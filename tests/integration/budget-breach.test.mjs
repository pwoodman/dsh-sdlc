/**
 * tests/integration/budget-breach.test.mjs — spec v3 G.3.1, B.7 (L4).
 *
 * Budget semantics fixed in v3:
 *   - `max_attempts` is PER TASK;
 *   - `max_duration_ms` / `max_cost_usd` / `max_tokens` are PER ATTEMPT, with
 *     derived CUMULATIVE ceilings = attempts × per-attempt.
 * A breach always yields `BUDGET_EXHAUSTED` and an explicit action
 * (`block` / `escalate` / explicit `retry` with `PER_ATTEMPT_BUDGET_EXCEEDED`) —
 * never a silent retry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

test('budget-breach: per-attempt vs cumulative dispatch ceilings', async () => {
  const { budgetsForRisk, cumulativeBudgets, checkDispatch } = await core.budget();
  const perAttempt = budgetsForRisk('R2');
  assert.deepEqual(perAttempt, { maxAttempts: 3, maxDurationMs: 3_600_000, maxCostUsd: 5, maxTokens: 400_000 });
  const cumulative = cumulativeBudgets(perAttempt);
  assert.deepEqual(cumulative, {
    maxAttempts: 3, maxDurationMs: 10_800_000, maxCostUsd: 15, maxTokens: 1_200_000,
  });

  // Per-attempt ceilings are NOT the dispatch ceiling; cumulative ones are.
  assert.equal(checkDispatch({ attempt: 0, spentCostUsd: 4.99, spentTokens: 399_999, spentDurationMs: 3_599_999 }, perAttempt).ok, true);
  assert.deepEqual(checkDispatch({ attempt: 3 }, perAttempt), { ok: false, reason: 'BUDGET_EXHAUSTED:max_attempts' });
  assert.deepEqual(checkDispatch({ attempt: 0, spentCostUsd: 15 }, perAttempt), { ok: false, reason: 'BUDGET_EXHAUSTED:cost' });
  assert.deepEqual(checkDispatch({ attempt: 0, spentTokens: 1_200_000 }, perAttempt), { ok: false, reason: 'BUDGET_EXHAUSTED:tokens' });
  assert.deepEqual(checkDispatch({ attempt: 0, spentDurationMs: 10_800_000 }, perAttempt), { ok: false, reason: 'BUDGET_EXHAUSTED:duration' });
});

test('budget-breach: evaluateRun maps breaches to explicit actions', async () => {
  const { budgetsForRisk, evaluateRun, checkProjectBudget, PROJECT_BUDGET_DEFAULTS } = await core.budget();
  const R2 = budgetsForRisk('R2');

  const healthy = evaluateRun({ attempt: 0, run: { costUsd: 1, tokens: 1000, durationMs: 1000 }, taskBudget: R2 });
  assert.deepEqual(healthy, { action: 'continue', reason: null, perAttemptOver: false, cumulativeExhausted: false });

  // Per-attempt overrun is an explicit retry, never silent.
  const over = evaluateRun({ attempt: 0, run: { costUsd: 6, tokens: 1000, durationMs: 1000 }, taskBudget: R2 });
  assert.equal(over.action, 'retry');
  assert.equal(over.reason, 'PER_ATTEMPT_BUDGET_EXCEEDED');
  assert.equal(over.perAttemptOver, true);

  // Cumulative exhaustion ⇒ ESCALATED (explicit decision), not FAILED.
  const cumulative = evaluateRun({ attempt: 2, run: { costUsd: 1, tokens: 1, durationMs: 1 }, taskBudget: R2 });
  assert.equal(cumulative.action, 'escalate');
  assert.equal(cumulative.reason, 'BUDGET_EXHAUSTED:cumulative');
  assert.equal(cumulative.cumulativeExhausted, true);

  // Project ceiling ⇒ BLOCK, with the project reason.
  const blocked = evaluateRun({
    attempt: 0,
    run: { costUsd: 250, tokens: 1, durationMs: 1 },
    taskBudget: R2,
    projectSpend: { costUsd: 0, durationMs: 0 },
  });
  assert.equal(blocked.action, 'block');
  assert.equal(blocked.reason, 'BUDGET_EXHAUSTED:project-cost');

  // Every breach carries a BUDGET_EXHAUSTED reason and a non-continue action.
  for (const outcome of [blocked, cumulative]) {
    assert.match(outcome.reason, /^BUDGET_EXHAUSTED/);
    assert.ok(['block', 'escalate'].includes(outcome.action));
  }

  assert.deepEqual(checkProjectBudget({ spentCostUsd: 0 }, PROJECT_BUDGET_DEFAULTS), { ok: true });
  assert.deepEqual(checkProjectBudget({ spentCostUsd: 200 }, PROJECT_BUDGET_DEFAULTS), { ok: false, reason: 'BUDGET_EXHAUSTED:project-cost' });
});

test('budget-breach: Runtime.canDispatch stops dispatch once the project budget is spent', async () => {
  const { Runtime } = await core.runtime();
  const root = tempDir('sdlc-budget-');
  const rt = new Runtime({ projectRoot: root, config: {}, useLock: true });
  try {
    rt.open();
    rt.createProject({ id: 'P1', name: 'budget' });
    rt.addTask({ id: 'T-1', project_id: 'P1', title: 't', risk_class: 'R2' });

    assert.deepEqual(rt.canDispatch(rt.getTask('T-1')), { ok: true });

    // Persist a run whose cost exceeds the project ceiling (default 200 USD).
    const runId = rt.startWorkerRun({ taskId: 'T-1', attempt: 0 });
    rt.finishWorkerRun(runId, { status: 'completed', costUsd: 250, durationMs: 10 });

    const verdict = rt.canDispatch(rt.getTask('T-1'));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'BUDGET_EXHAUSTED:project-cost');

    // NEGATIVE CONTROL: an attempt at the per-task ceiling is blocked too.
    const { budgetsForRisk, checkDispatch } = await core.budget();
    const atCap = checkDispatch({ attempt: budgetsForRisk('R2').maxAttempts }, budgetsForRisk('R2'));
    assert.equal(atCap.ok, false);
    assert.equal(atCap.reason, 'BUDGET_EXHAUSTED:max_attempts');
  } finally {
    rt.close();
    cleanup(root);
  }
});
