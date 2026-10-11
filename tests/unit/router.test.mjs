/**
 * tests/unit/router.test.mjs — model router rule ladder (spec v3 B.8, G.2.3, K.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const { ModelRouter } = await core.router();

test('rule 1: capability constraint outranks the attempt ladder', () => {
  const router = new ModelRouter({
    tiers: {
      cheap: [{ provider: 'openai', model: 'gpt-4o-mini' }],       // no vision
      base: [{ provider: 'openai', model: 'gpt-4o' }],             // vision ✓
      elevated: [{ provider: 'anthropic', model: 'claude-opus' }], // vision ✓
    },
    capabilities: { 'gpt-4o-mini': ['text'], 'gpt-4o': ['text', 'vision'], 'claude-opus': ['text', 'vision'] },
  });
  const choice = router.route({ task: { requires: ['vision'], attempt: 3 } });
  assert.equal(choice.tier, 'base', 'cheapest tier with vision, not elevated');
  assert.equal(choice.rule, 1);
});

test('rule 1: a vision-capable CHEAP tier is preferred over BASE and ELEVATED', () => {
  const router = new ModelRouter({
    tiers: { cheap: [{ provider: 'p', model: 'cheap-vision' }], base: [{ provider: 'p', model: 'b' }], elevated: [{ provider: 'p', model: 'e' }] },
    capabilities: { 'cheap-vision': ['text', 'vision'], b: ['text', 'vision'], e: ['text', 'vision'] },
  });
  assert.equal(router.route({ task: { requires: ['vision'], attempt: 3 } }).tier, 'cheap');
});

test('rule 1: NO_ELIGIBLE_MODEL when no tier can satisfy the capability', () => {
  const router = new ModelRouter({ tiers: { cheap: [{ provider: 'p', model: 'm' }], base: [], elevated: [] }, capabilities: { m: ['text'] } });
  const choice = router.route({ task: { requires: ['vision'], attempt: 0 } });
  assert.equal(choice.tier, null);
  assert.equal(choice.reason, 'NO_ELIGIBLE_MODEL');
});

test('rule 2: security-critical gate routes to ELEVATED', () => {
  const router = new ModelRouter({
    tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [{ provider: 'p', model: 'b' }], elevated: [{ provider: 'p', model: 'e' }] },
  });
  assert.equal(router.route({ task: { sec: true, gate: 'security', attempt: 0 } }).tier, 'elevated');
});

test('rule 3: requires_elevated → ELEVATED', () => {
  const router = new ModelRouter({ tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [], elevated: [{ provider: 'p', model: 'e' }] } });
  assert.equal(router.route({ task: { requires_elevated: true, attempt: 0 } }).tier, 'elevated');
});

test('rule 4: attempt ≥ 2 → ELEVATED', () => {
  const router = new ModelRouter({ tiers: { cheap: [], base: [], elevated: [{ provider: 'p', model: 'm' }] }, capabilities: {} });
  assert.equal(router.route({ task: { attempt: 2 } }).tier, 'elevated');
  assert.equal(router.route({ task: { attempt: 5 } }).tier, 'elevated');
});

test('rule 5: attempt = 1 → BASE', () => {
  const router = new ModelRouter({ tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [{ provider: 'p', model: 'b' }], elevated: [{ provider: 'p', model: 'e' }] } });
  assert.equal(router.route({ task: { attempt: 1 } }).tier, 'base');
});

test('rule 6: trivial task, attempt 0 → CHEAP', () => {
  const router = new ModelRouter({ tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [], elevated: [] }, capabilities: {} });
  assert.equal(router.route({ task: { attempt: 0, task_class: 'trivial' } }).tier, 'cheap');
});

test('rule 7: normal task with strong history → CHEAP, else BASE', () => {
  const strong = new ModelRouter({
    tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [{ provider: 'p', model: 'b' }], elevated: [] },
    history: { 'p/c:test': { successes: 9, failures: 1 } },
  });
  assert.equal(strong.route({ task: { attempt: 0, task_class: 'normal', task_type: 'test' } }).tier, 'cheap');

  const weak = new ModelRouter({
    tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [{ provider: 'p', model: 'b' }], elevated: [] },
    history: { 'p/c:test': { successes: 3, failures: 7 } },
  });
  assert.equal(weak.route({ task: { attempt: 0, task_class: 'normal', task_type: 'test' } }).tier, 'base');

  // n < 5 ⇒ Laplace-smoothed prior, never a raw small-sample rate.
  const smallSample = new ModelRouter({
    tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [{ provider: 'p', model: 'b' }], elevated: [] },
    history: { 'p/c:test': { successes: 2, failures: 0 } },
  });
  assert.equal(smallSample.histSuccess('p/c', 'test'), 3 / 4);
  assert.equal(smallSample.route({ task: { attempt: 0, task_class: 'normal', task_type: 'test' } }).tier, 'base');
});

test('rule 8: architectural → BASE, or ELEVATED at complexity ≥ 0.65', () => {
  const router = new ModelRouter({ tiers: { cheap: [], base: [{ provider: 'p', model: 'b' }], elevated: [{ provider: 'p', model: 'e' }] } });
  assert.equal(router.route({ task: { attempt: 0, task_class: 'architectural', complexity: 0.4 } }).tier, 'base');
  assert.equal(router.route({ task: { attempt: 0, task_class: 'architectural', complexity: 0.7 } }).tier, 'elevated');
});

test('cost calculation matches the price table (per 1M tokens)', () => {
  const router = new ModelRouter({
    tiers: { base: [{ provider: 'openai', model: 'gpt-4o' }] },
    capabilities: {},
    pricing: { 'openai/gpt-4o': { input: 2.5, output: 10.0 } },
  });
  const cost = router.estimateCost('openai/gpt-4o', { tokens_in: 100000, tokens_out: 20000 });
  assert.equal(cost, (100000 * 2.5 + 20000 * 10.0) / 1_000_000);
  assert.equal(cost, 0.45);
  // An unpriced model is an explicit null, never a silent zero (H.3 check 3).
  assert.equal(router.estimateCost('openai/unpriced', { tokens_in: 1, tokens_out: 1 }), null);
});

test('selection within a tier scores history, cost and latency; single candidate skips scoring', () => {
  const router = new ModelRouter({
    tiers: { base: [
      { provider: 'p', model: 'good' },
      { provider: 'p', model: 'bad' },
    ] },
    capabilities: {},
    pricing: { 'p/good': { input: 1, output: 1 }, 'p/bad': { input: 100, output: 100 } },
    history: { 'p/good:default': { successes: 9, failures: 1 }, 'p/bad:default': { successes: 1, failures: 9 } },
  });
  const choice = router.route({ task: { attempt: 1 } });
  assert.equal(choice.model, 'good');

  const single = new ModelRouter({ tiers: { base: [{ provider: 'p', model: 'only' }] } });
  assert.equal(single.route({ task: { attempt: 1 } }).model, 'only');
});

test('tie-break is deterministic: lower cost, then stable model id', () => {
  const router = new ModelRouter({
    tiers: { base: [{ provider: 'p', model: 'zzz' }, { provider: 'p', model: 'aaa' }] },
    pricing: { 'p/zzz': { input: 1, output: 1 }, 'p/aaa': { input: 1, output: 1 } },
  });
  const first = router.route({ task: { attempt: 1 } }).model;
  for (let i = 0; i < 20; i += 1) assert.equal(router.route({ task: { attempt: 1 } }).model, first);
  assert.equal(first, 'aaa');
});

test('fallback chain lists every eligible candidate (used on provider errors)', () => {
  const router = new ModelRouter({
    tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [{ provider: 'p', model: 'b' }], elevated: [{ provider: 'p', model: 'e' }] },
    capabilities: { c: ['text'], b: ['text', 'vision'], e: ['text', 'vision'] },
  });
  const chain = router.fallbackChain({ task: { requires: ['vision'] } });
  assert.deepEqual(chain.map((c) => c.model), ['b', 'e']);
});

test('history folds into model_runs-shaped records', () => {
  const router = new ModelRouter({ tiers: {}, history: {} });
  router.recordOutcome('p/m', 'test', 'success');
  router.recordOutcome('p/m', 'test', 'failure');
  const record = router.recordOutcome('p/m', 'test', 'success', { tokens: 10, costUsd: 0.01, durationMs: 5 });
  assert.equal(router.histSuccess('p/m', 'test'), 0.6); // (2+1)/(3+2) — Laplace while n<5
  assert.equal(record.model_id, 'p/m');
  assert.equal(record.outcome, 'success');
});

test('routing is a pure function of the task contract + history (K.6)', () => {
  const make = () => new ModelRouter({
    tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [{ provider: 'p', model: 'b' }], elevated: [{ provider: 'p', model: 'e' }] },
    capabilities: { c: ['text'], b: ['text'], e: ['text'] },
    pricing: { 'p/c': { input: 1, output: 1 }, 'p/b': { input: 2, output: 2 }, 'p/e': { input: 4, output: 4 } },
    history: { 'p/c:api': { successes: 9, failures: 1 } },
  });
  const task = { id: 'API-1', attempt: 0, task_class: 'normal', task_type: 'api' };
  const a = make().route(task);
  const b = make().route(task);
  assert.deepEqual(a, b);
  assert.equal(a.tier, 'cheap');
});
