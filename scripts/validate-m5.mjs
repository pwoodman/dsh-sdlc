#!/usr/bin/env node
/**
 * scripts/validate-m5.mjs — M5 gate: route (spec v3 D.0).
 *
 * Router picks CHEAP for trivial tasks; escalates to ELEVATED at attempt ≥ 2;
 * capability constraints override the attempt ladder; the cost calculation
 * matches the price table; history feeds `hist_success`.
 *
 *   node scripts/validate-m5.mjs [--json <path>] [--fail-fast]
 */

import { runSuite, EXIT } from './lib/harness.mjs';
import { importPkg } from './lib/gate-helpers.mjs';

const { ModelRouter } = await importPkg('packages/sdlc-core/src/router.js');
const { DEFAULT_CONFIG, validateConfig } = await importPkg('packages/sdlc-core/src/config.js');

const TIERS = {
  cheap: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  base: [{ provider: 'openai', model: 'gpt-4o' }],
  elevated: [{ provider: 'anthropic', model: 'claude-opus-4' }],
};
const CAPABILITIES = { 'openai/gpt-4o-mini': ['text'], 'openai/gpt-4o': ['text', 'vision'], 'anthropic/claude-opus-4': ['text', 'vision'] };

function router(extra = {}) {
  return new ModelRouter({ tiers: TIERS, capabilities: CAPABILITIES, pricing: DEFAULT_CONFIG.pricing, ...extra });
}

const checks = [
  {
    id: 'M5-01-cheap-for-trivial',
    title: 'a trivial task at attempt 0 rides CHEAP',
    fn() {
      const choice = router().route({ task: { attempt: 0, task_class: 'trivial', task_type: 'ui' } });
      if (choice.tier !== 'cheap') throw new Error(`expected cheap, got ${choice.tier}`);
      if (choice.model !== 'gpt-4o-mini') throw new Error(`expected the cheap model, got ${choice.model}`);
      return { detail: `cheap/${choice.model} via rule ${choice.rule}` };
    },
  },
  {
    id: 'M5-02-escalates-on-attempt-2',
    title: 'attempt ≥ 2 escalates to ELEVATED',
    fn() {
      const choice = router().route({ task: { attempt: 2, task_class: 'normal', task_type: 'api' } });
      if (choice.tier !== 'elevated') throw new Error(`expected elevated, got ${choice.tier}`);
      if (choice.rule !== 4) throw new Error(`expected rule 4, got ${choice.rule}`);
      const later = router().route({ task: { attempt: 5, task_class: 'normal', task_type: 'api' } });
      if (later.tier !== 'elevated') throw new Error('attempt 5 did not stay elevated');
      return { detail: 'attempt 2 and 5 both route ELEVATED' };
    },
  },
  {
    id: 'M5-03-capability-overrides-ladder',
    title: 'capability constraints dominate the attempt ladder (rule 1)',
    fn() {
      const choice = router().route({ task: { attempt: 3, requires: ['vision'], task_class: 'normal' } });
      if (choice.rule !== 1) throw new Error(`expected rule 1, got rule ${choice.rule}`);
      if (choice.tier !== 'base') throw new Error(`expected the cheapest vision tier (base), got ${choice.tier}`);
      const impossible = new ModelRouter({ tiers: { cheap: [{ provider: 'p', model: 'text-only' }], base: [], elevated: [] }, capabilities: { 'p/text-only': ['text'] } })
        .route({ task: { attempt: 0, requires: ['vision'] } });
      if (impossible.tier !== null || impossible.reason !== 'NO_ELIGIBLE_MODEL') throw new Error('an unsatisfiable capability did not resolve NO_ELIGIBLE_MODEL');
      return { detail: 'vision task → cheapest vision tier; unsatisfiable → NO_ELIGIBLE_MODEL' };
    },
  },
  {
    id: 'M5-04-cost-matches-price-table',
    title: 'cost = tokens × the deployment price table (no currency metadata exists)',
    fn() {
      const r = router();
      const cost = r.estimateCost('openai/gpt-4o', { tokens_in: 100000, tokens_out: 20000 });
      const expected = (100000 * DEFAULT_CONFIG.pricing['openai/gpt-4o'].input + 20000 * DEFAULT_CONFIG.pricing['openai/gpt-4o'].output) / 1_000_000;
      if (Math.abs(cost - expected) > 1e-12) throw new Error(`cost mismatch: ${cost} vs ${expected}`);
      if (cost !== 0.45) throw new Error(`expected 0.45, got ${cost}`);
      if (r.estimateCost('openai/not-priced', { tokens_in: 1, tokens_out: 1 }) !== null) throw new Error('an unpriced model returned a number');
      // Every routed model in the default config must be priced (H.3 check 3).
      const validation = validateConfig(DEFAULT_CONFIG, { projectRoot: process.cwd(), env: {} });
      if (!validation.ok) throw new Error(`default config invalid: ${validation.errors.join('; ')}`);
      return { detail: 'price-table arithmetic exact; unpriced model is null, not zero' };
    },
  },
  {
    id: 'M5-05-history-feeds-hist-success',
    title: 'model_runs history feeds hist_success with Laplace smoothing',
    fn() {
      const strong = router({ history: { 'openai/gpt-4o-mini:ui': { successes: 9, failures: 1 } } });
      if (strong.histSuccess('openai/gpt-4o-mini', 'ui') !== 0.9) throw new Error('n≥5 history should use the raw rate');
      const choice = strong.route({ task: { attempt: 0, task_class: 'normal', task_type: 'ui' } });
      if (choice.tier !== 'cheap') throw new Error(`a 0.9-history task should ride cheap, got ${choice.tier}`);

      const small = router({ history: { 'openai/gpt-4o-mini:ui': { successes: 2, failures: 0 } } });
      if (small.histSuccess('openai/gpt-4o-mini', 'ui') !== 0.75) throw new Error('n<5 must be Laplace-smoothed');
      const cold = router();
      if (cold.histSuccess('openai/gpt-4o-mini', 'ui') !== 0.5) throw new Error('an unknown model must use the 0.5 prior');

      const recorded = cold.recordOutcome('openai/gpt-4o-mini', 'ui', 'success');
      if (recorded.outcome !== 'success' || cold.history['openai/gpt-4o-mini:ui'].successes !== 1) throw new Error('history was not recorded');
      return { detail: 'raw ≥5, Laplace <5, prior 0.5, and outcomes fold back into history' };
    },
  },
  {
    id: 'M5-06-fallback-chain-score-order',
    title: 'the fallback chain advances in score order (K.5)',
    fn() {
      const r = new ModelRouter({
        tiers: { cheap: [{ provider: 'p', model: 'best' }, { provider: 'p', model: 'worst' }], base: [], elevated: [] },
        pricing: { 'p/best': { input: 1, output: 1 }, 'p/worst': { input: 100, output: 100 } },
        history: { 'p/best:default': { successes: 9, failures: 1 }, 'p/worst:default': { successes: 1, failures: 9 } },
      });
      const chain = r.fallbackChain({ requires: [] });
      if (chain[0].model !== 'best') throw new Error(`first fallback should be the best candidate, got ${chain[0].model}`);
      if (chain[1].model !== 'worst') throw new Error(`second fallback should be the worst, got ${chain[1].model}`);
      return { detail: chain.map((c) => c.model).join(' → ') };
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M5 routing gate', version: '1.0.0', checks }));
