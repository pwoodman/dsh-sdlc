/**
 * tests/unit/budget-spend-scope.test.mjs — project vs task spend in evaluateRun (B.7).
 *
 * Regression guard: `evaluateRun` used PROJECT spend to decide TASK-cumulative
 * exhaustion, so a busy unrelated task could escalate one that had barely run.
 * Project spend must feed only the project ceiling; taskSpend feeds the task one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const b = await core.budget();

const R2 = b.RISK_BUDGET_DEFAULTS.R2;

test('a large project spend does not escalate a fresh task (task cumulative is per task)', () => {
  const out = b.evaluateRun({
    attempt: 0,
    run: { costUsd: 1, tokens: 0, durationMs: 0 },
    taskBudget: R2,          // cumulative cost ceiling = 5 × 3 = 15
    taskSpend: { costUsd: 0 },
    projectSpend: { costUsd: 100, durationMs: 0 }, // under the default 200 project cap
  });
  assert.deepEqual(out, { action: 'continue', reason: null, perAttemptOver: false, cumulativeExhausted: false });
});

test('this task\'s own spend does exhaust its cumulative ceiling', () => {
  const out = b.evaluateRun({
    attempt: 0,
    run: { costUsd: 1, tokens: 0, durationMs: 0 },
    taskBudget: R2,
    taskSpend: { costUsd: 20 }, // 20 + 1 ≥ 15
    projectSpend: { costUsd: 0, durationMs: 0 },
  });
  assert.equal(out.action, 'escalate');
  assert.equal(out.reason, 'BUDGET_EXHAUSTED:cumulative');
  assert.equal(out.cumulativeExhausted, true);
});

test('the project ceiling still blocks, and takes precedence', () => {
  const out = b.evaluateRun({
    attempt: 0,
    run: { costUsd: 1, tokens: 0, durationMs: 0 },
    taskBudget: R2,
    taskSpend: { costUsd: 0 },
    projectSpend: { costUsd: 250, durationMs: 0 },
  });
  assert.equal(out.action, 'block');
  assert.equal(out.reason, 'BUDGET_EXHAUSTED:project-cost');
});

test('a per-attempt overrun is still an explicit retry', () => {
  const out = b.evaluateRun({
    attempt: 0,
    run: { costUsd: 6, tokens: 0, durationMs: 0 },
    taskBudget: R2,
    taskSpend: { costUsd: 0 },
    projectSpend: { costUsd: 0, durationMs: 0 },
  });
  assert.equal(out.action, 'retry');
  assert.equal(out.reason, 'PER_ATTEMPT_BUDGET_EXCEEDED');
  assert.equal(out.perAttemptOver, true);
});
