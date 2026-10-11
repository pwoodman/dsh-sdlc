/**
 * tests/unit/budget-isolation.test.mjs — per-task budget accounting (spec v3 B.7).
 *
 * Regression guard: `Runtime.canDispatch` must compare a task's OWN cumulative
 * spend against its cumulative limits. Comparing the project-wide total against
 * one task's budget falsely blocks untouched tasks, and passing 0 for cost /
 * duration silently disables those two ceilings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const { Runtime } = await core.runtime();

function baseConfig(overrides = {}) {
  return {
    storage: { dbPath: '.sdlc/sdlc.db', requireQuickCheckOnOpen: true },
    safety: { instanceLock: false },
    budgets: {},
    tiers: {},
    pricing: {},
    ...overrides,
  };
}

function freshRuntime(prefix, config = baseConfig()) {
  const root = tempDir(prefix);
  const rt = new Runtime({ projectRoot: root, config });
  rt.open();
  return { root, rt };
}

function spend(rt, taskId, { id, tokens = null, costUsd = 0, durationMs = 0 }) {
  rt.startWorkerRun({ taskId, attempt: 1, id });
  rt.finishWorkerRun(id, { status: 'completed', tokens, costUsd, durationMs });
}

test('a sibling task exhausting its own budget does not block an untouched task', () => {
  const { root, rt } = freshRuntime('sdlc-budget-isolation-', baseConfig({
    budgets: {
      perProject: { maxCostUsd: 1e9, maxDurationMs: 1e12 },
      perTask: { R2: { maxAttempts: 2, maxDurationMs: 1e12, maxCostUsd: 1e9, maxTokens: 1000 } },
    },
  }));
  try {
    rt.addTask({ id: 'T1', risk_class: 'R2' });
    rt.addTask({ id: 'T2', risk_class: 'R2' });
    assert.deepEqual(rt.spentForTask('T2'), { costUsd: 0, durationMs: 0, tokens: 0 });

    // T1 alone blows past its cumulative token ceiling (2 attempts × 1000).
    spend(rt, 'T1', { id: 'run-t1', tokens: { in: 3000, out: 2000 } });

    const t1 = rt.canDispatch(rt.getTask('T1'));
    assert.equal(t1.ok, false);
    assert.match(t1.reason, /tokens/);

    // The project total is now 5000 tokens, but T2 has spent nothing.
    assert.equal(rt.spentTotals().tokens, 5000);
    assert.deepEqual(rt.canDispatch(rt.getTask('T2')), { ok: true });
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('the per-task cost ceiling is enforced (not passed as 0)', () => {
  const { root, rt } = freshRuntime('sdlc-budget-cost-', baseConfig({
    budgets: {
      perProject: { maxCostUsd: 1e9, maxDurationMs: 1e12 },
      perTask: { R1: { maxAttempts: 1, maxDurationMs: 1e12, maxCostUsd: 0.5, maxTokens: 1e9 } },
    },
  }));
  try {
    rt.addTask({ id: 'T1', risk_class: 'R1' });
    assert.deepEqual(rt.canDispatch(rt.getTask('T1')), { ok: true });
    spend(rt, 'T1', { id: 'run-cost', costUsd: 0.75 });
    const verdict = rt.canDispatch(rt.getTask('T1'));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /cost/);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('the per-task duration ceiling is enforced (not passed as 0)', () => {
  const { root, rt } = freshRuntime('sdlc-budget-duration-', baseConfig({
    budgets: {
      perProject: { maxCostUsd: 1e9, maxDurationMs: 1e12 },
      perTask: { R1: { maxAttempts: 1, maxDurationMs: 100, maxCostUsd: 1e9, maxTokens: 1e9 } },
    },
  }));
  try {
    rt.addTask({ id: 'T1', risk_class: 'R1' });
    spend(rt, 'T1', { id: 'run-dur', durationMs: 150 });
    const verdict = rt.canDispatch(rt.getTask('T1'));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /duration/);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('the project ceiling still blocks dispatch even when no single task is exhausted', () => {
  const { root, rt } = freshRuntime('sdlc-budget-project-', baseConfig({
    budgets: {
      perProject: { maxCostUsd: 1, maxDurationMs: 1e12 },
      perTask: { R2: { maxAttempts: 5, maxDurationMs: 1e12, maxCostUsd: 1e9, maxTokens: 1e9 } },
    },
  }));
  try {
    rt.addTask({ id: 'T1', risk_class: 'R2' });
    rt.addTask({ id: 'T2', risk_class: 'R2' });
    spend(rt, 'T1', { id: 'run-p', costUsd: 1.5 });
    const verdict = rt.canDispatch(rt.getTask('T2'));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /project-cost/);
  } finally {
    rt.close();
    cleanup(root);
  }
});
