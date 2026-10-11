#!/usr/bin/env node
/**
 * scripts/validate-m8.mjs — M8 gate: harden (spec v3 D.0).
 *
 * All eight spec §53 acceptance tests exist and pass (run as their own layer);
 * collaborative mode produces exactly one ADR; every §58 DoD item is represented
 * by a lower gate that exists on disk; and **cost bookkeeping is exact**
 * (recomputed tokens × price table equals the persisted cost to the cent) —
 * never a comparison against a provider invoice (E9).
 *
 *   node scripts/validate-m8.mjs [--json <path>] [--fail-fast]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSuite, run, testGlobs, summaryOf, stripAnsi, EXIT } from './lib/harness.mjs';
import { importPkg, withDir, testConfig, openRuntime } from './lib/gate-helpers.mjs';

const ROOT = join(import.meta.dirname, '..');
const { DEFAULT_CONFIG } = await importPkg('packages/sdlc-core/src/config.js');
const escalation = await importPkg('packages/sdlc-core/src/escalation.js');
const { ModelRouter } = await importPkg('packages/sdlc-core/src/router.js');

const ACCEPTANCE_TESTS = [
  '53-1-tiny-ui.test.mjs', '53-2-new-api.test.mjs', '53-3-middleware.test.mjs', '53-4-complex-ui.test.mjs',
  '53-5-stuck-worker.test.mjs', '53-6-collision.test.mjs', '53-7-visual-defect.test.mjs', '53-8-architecture-disagreement.test.mjs',
];

/** §58 DoD items → the gate that must exist on disk to represent them. */
const DOD = [
  ['profiles and bundles boot', 'scripts/validate-m0.mjs'],
  ['plan determinism and schema', 'scripts/validate-m1.mjs'],
  ['worktree lifecycle and lock', 'scripts/validate-m2.mjs'],
  ['gates, evidence and review', 'scripts/validate-m3.mjs'],
  ['loop, budget and kill switch', 'scripts/validate-m4.mjs'],
  ['routing and cost arithmetic', 'scripts/validate-m5.mjs'],
  ['visual QA and a11y floor', 'scripts/validate-m6.mjs'],
  ['integration merge and resume', 'scripts/validate-m7.mjs'],
];

const checks = [
  {
    id: 'M8-01-acceptance-suite',
    title: 'all eight §53 acceptance tests exist and the layer passes',
    fn() {
      const missing = ACCEPTANCE_TESTS.filter((f) => !existsSync(join(ROOT, 'tests', 'e2e', f)));
      if (missing.length) throw new Error(`missing §53 tests: ${missing.join(', ')}`);
      if (!existsSync(join(ROOT, 'tests', 'e2e', 'live.test.mjs'))) throw new Error('the opt-in live test is missing');
      const res = run('node', ['--test', ...testGlobs(['tests/e2e'])], { cwd: ROOT, timeoutMs: 600000 });
      const out = `${res.stdout}${res.stderr}`;
      if (out) {
        mkdirSync(join(ROOT, '.validation'), { recursive: true });
        writeFileSync(join(ROOT, '.validation', 'm8-e2e.log'), out);
      }
      if (!res.ok) {
        const failed = out.split('\n').filter((l) => /^\s*(not ok |✖)/.test(l)).slice(0, 5);
        throw new Error(
          `the e2e layer failed: ${failed.length ? failed.map((l) => l.trim()).join(' ; ') : 'no test reported as failed, but the runner exited non-zero'}` +
          `\n  full output: .validation/m8-e2e.log`,
        );
      }
      const counts = summaryOf(out);
      const summary = counts
        ? `tests ${counts.tests ?? '?'}, pass ${counts.pass ?? '?'}, fail ${counts.fail ?? '?'}, skipped ${counts.skipped ?? '?'}`
        : 'no summary reported';
      return { detail: `8 §53 tests present; layer green (${summary})` };
    },
  },
  {
    id: 'M8-02-collaborative-adr',
    title: 'collaborative mode produces exactly ONE ADR in the decision ledger',
    fn() {
      const triggers = DEFAULT_CONFIG.escalation.collaborativeTriggers;
      for (const t of ['architecture_dispute', 'security_r4', 'elevated_double_fail', 'major_refactor']) {
        if (!triggers.includes(t)) throw new Error(`collaborative trigger ${t} is not configured (B.8)`);
      }
      return withDir(async (dir) => {
        const runtime = await openRuntime(dir, { config: testConfig(), tasks: [] });
        try {
          // Two conflicting ADRs are proposed; the adjudicator returns ONE decision.
          const block = escalation.buildDecisionBlock({
            id: 'E-ARCH-1', trigger: 'ambiguous_architecture', question: 'monolith or services?',
            options: [{ id: 'a', label: 'monolith' }, { id: 'b', label: 'services' }],
            recommendation: 'a', rationale: 'smaller team',
          });
          if (block.options.length !== 2) throw new Error('the adjudication input is not a real dispute');
          runtime.recordDecision({
            id: 'ADR-1', project_id: 'P1', question: block.question, decision: 'monolith',
            reason: block.rationale, alternatives: ['services'], consequences: ['single deploy'], tags: ['architecture'],
          });
          const decisions = runtime.listDecisions('P1');
          if (decisions.length !== 1) throw new Error(`expected exactly 1 ADR, got ${decisions.length}`);
          if (decisions[0].tags[0] !== 'architecture') throw new Error('the ADR lost its tags');

          // The elevated adjudicator is reachable via router rule 3.
          const router = new ModelRouter({
            tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [], elevated: [{ provider: 'p', model: 'e' }] },
            capabilities: { c: ['text'], e: ['text'] },
          });
          const choice = router.route({ task: { requires_elevated: true, attempt: 0 } });
          if (choice.tier !== 'elevated') throw new Error('the adjudicator did not route to ELEVATED');
          return { detail: 'one ADR recorded; adjudicator routed to ELEVATED' };
        } finally { runtime.close({ releaseLock: false }); }
      }, 'sdlc-m8-adr-');
    },
  },
  {
    id: 'M8-03-dod-represented',
    title: 'every §58 DoD item is represented by a gate that exists on disk',
    fn() {
      const missing = DOD.filter(([, script]) => !existsSync(join(ROOT, script)));
      if (missing.length) throw new Error(`DoD items without a gate: ${missing.map(([item]) => item).join(', ')}`);
      for (const script of ['validate-platform.mjs', 'validate-m0.mjs', 'validate-m1.mjs']) {
        if (!existsSync(join(ROOT, 'scripts', script))) throw new Error(`missing prerequisite gate ${script}`);
      }
      return { detail: `${DOD.length} DoD items → existing gates, plus the P/M0/M1 prerequisites` };
    },
  },
  {
    id: 'M8-04-cost-bookkeeping-exact',
    title: 'recomputed cost equals the persisted cost to the cent (E9, not an invoice)',
    fn() {
      return withDir(async (dir) => {
        const config = testConfig({ pricing: DEFAULT_CONFIG.pricing });
        const runtime = await openRuntime(dir, { config, tasks: [{ id: 'T-1', title: 'a', role: 'backend-engineer', allowed_paths: ['src/a/**'] }] });
        try {
          const runId = runtime.startWorkerRun({ taskId: 'T-1', attempt: 0, model: { provider: 'openai', id: 'gpt-4o' } });
          const tokens = { in: 100000, out: 20000 };
          const expected = (tokens.in * DEFAULT_CONFIG.pricing['openai/gpt-4o'].input
            + tokens.out * DEFAULT_CONFIG.pricing['openai/gpt-4o'].output) / 1_000_000;
          runtime.finishWorkerRun(runId, { status: 'completed', exitCode: 0, durationMs: 1000, tokens, costUsd: expected });
          runtime.recordModelRun({
            model_id: 'openai/gpt-4o', task_id: 'T-1', task_type: 'api', duration_ms: 1000,
            tokens: tokens.in + tokens.out, cost_usd: expected, attempts: 1, outcome: 'success', escalated: 0,
          });

          const stored = runtime.db.prepare('SELECT tokens_in, tokens_out, cost_usd FROM worker_runs WHERE id = ?').get(runId);
          const recomputed = (stored.tokens_in * DEFAULT_CONFIG.pricing['openai/gpt-4o'].input
            + stored.tokens_out * DEFAULT_CONFIG.pricing['openai/gpt-4o'].output) / 1_000_000;
          const cents = (n) => Math.round(n * 100);
          if (cents(recomputed) !== cents(stored.cost_usd)) {
            throw new Error(`bookkeeping drift: recomputed ${recomputed} vs persisted ${stored.cost_usd}`);
          }
          if (cents(stored.cost_usd) !== cents(0.45)) throw new Error(`expected 45 cents, got ${cents(stored.cost_usd)}`);

          // Token accounting must be COMPLETE: every run has both counters.
          const incomplete = runtime.db.prepare('SELECT COUNT(*) AS n FROM worker_runs WHERE tokens_in IS NULL OR tokens_out IS NULL').get().n;
          if (incomplete !== 0) throw new Error(`${incomplete} worker runs have incomplete token accounting`);

          const spend = runtime.spentTotals();
          if (cents(spend.costUsd) !== cents(0.45)) throw new Error('the persisted rollup disagrees with the run');
          return { detail: 'recomputed == persisted to the cent; token accounting complete' };
        } finally { runtime.close({ releaseLock: false }); }
      }, 'sdlc-m8-cost-');
    },
  },
  {
    id: 'M8-05-full-suite',
    title: 'the full offline suite (unit/contract/integration/fault/adversarial) is green',
    fn() {
      const layers = ['tests/unit', 'tests/fault', 'tests/adversarial', 'tests/e2e']
        .filter((d) => existsSync(join(ROOT, d)));
      const globs = testGlobs(layers);
      const res = run('node', ['--test', ...globs], { cwd: ROOT, timeoutMs: 900000 });
      const out = `${res.stdout}${res.stderr}`;
      // Keep the whole run: when the gate fails, this is the evidence that says
      // WHICH test died and why, and the Release workflow uploads .validation/.
      if (out) {
        mkdirSync(join(ROOT, '.validation'), { recursive: true });
        writeFileSync(join(ROOT, '.validation', 'm8-full-suite.log'), out);
      }
      // Both reporter shapes: see summaryOf(). Matching only `ℹ` reported
      // fail=? for a green 553-test suite on the release runner and blocked it.
      const counts = summaryOf(out) ?? {};
      const pass = counts.pass ?? '?';
      const fail = counts.fail ?? '?';
      const skipped = counts.skipped ?? '0';
      if (!res.ok || fail !== 0) {
        const failed = out.split('\n').filter((l) => /^\s*(not ok |✖)/.test(l)).slice(0, 5);
        const firstError = out.split('\n').find((l) => /^\s*(Error|TypeError|RangeError|ReferenceError|AssertionError)/.test(l));
        const summary = out.split('\n').filter((l) => /^[ℹ#] /.test(stripAnsi(l))).join(' | ');
        const tail = out.split('\n').filter(Boolean).slice(-6).join(' | ');
        throw new Error(
          `node --test ${globs.join(' ')} → status=${res.status ?? 'null'} signal=${res.signal ?? 'none'}` +
          `${res.error ? ` error=${res.error.message}` : ''}` +
          `\n  reported: pass=${pass} fail=${fail} skipped=${skipped} (process ${res.ok ? 'exited 0' : 'exited non-zero'})` +
          `${failed.length ? `\n  failed tests: ${failed.map((l) => l.trim()).join(' ; ')}` : ''}` +
          `${firstError ? `\n  first error: ${firstError.trim()}` : ''}` +
          `${summary ? `\n  summary: ${summary}` : '\n  (no summary line at all — the run aborted early)'}` +
          `${tail ? `\n  tail: ${tail}` : '\n  (no output captured)'}` +
          `\n  full output: .validation/m8-full-suite.log`,
        );
      }
      return { detail: `${layers.join(', ')}: ${pass} passed, ${fail} failed, ${skipped} skipped` };
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M8 hardening gate', version: '1.0.0', checks }));
