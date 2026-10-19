/**
 * tests/integration/budget-ingest.test.mjs — post-run accounting must be
 * evidence, not a note. A run that spends past its per-attempt ceiling used to
 * be persisted as `completed` and could still reach ACCEPTED.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const { Runtime } = await core.runtime();

function fixture(overrides = {}) {
  const root = tempDir('sdlc-budget-ingest-');
  const rt = new Runtime({
    projectRoot: root,
    config: {
      storage: { dbPath: '.sdlc/sdlc.db' },
      safety: { instanceLock: false },
      budgets: {
        perProject: { maxCostUsd: 1e9, maxDurationMs: 1e12 },
        perTask: { R2: { maxAttempts: 3, maxDurationMs: 1e12, maxCostUsd: 5, maxTokens: 400_000 } },
      },
      ...overrides,
    },
  });
  rt.open();
  rt.createProject({ id: 'P1', name: 'budget' });
  rt.addTask({ id: 'T1', project_id: 'P1', title: 't', risk_class: 'R2' });
  rt.state._setState('T1', 'IN_PROGRESS');
  return { root, rt };
}

function ingest(rt, runtime) {
  const runId = rt.startWorkerRun({ taskId: 'T1', attempt: 0 });
  return rt.ingestResult({
    runId,
    filesChanged: [],
    contract: { allowed_paths: ['src/**'] },
    runtime,
  });
}

test('a per-attempt cost overrun is persisted as FAILED with budget evidence', () => {
  const { root, rt } = fixture();
  try {
    const out = ingest(rt, { exitCode: 0, turnEndReason: 'end_turn', costUsd: 6, tokens: { in: 10, out: 10 }, durationMs: 10 });
    assert.equal(out.budget.available, true);
    assert.equal(out.budget.perAttemptOver, true);
    assert.equal(out.budget.action, 'retry');
    assert.equal(rt.getTask('T1').state, 'FAILED');
    const event = rt.getEvents({ taskId: 'T1' }).at(-1);
    assert.match(event.payload_json, /PER_ATTEMPT_BUDGET_EXCEEDED/);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('NEGATIVE CONTROL: a within-budget run stays IN_PROGRESS', () => {
  const { root, rt } = fixture();
  try {
    const out = ingest(rt, { exitCode: 0, turnEndReason: 'end_turn', costUsd: 1, tokens: { in: 10, out: 10 }, durationMs: 10 });
    assert.equal(out.budget.available, true);
    assert.equal(out.budget.action, 'continue');
    assert.equal(rt.getTask('T1').state, 'IN_PROGRESS');
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('missing cost or tokens is UNKNOWN, never treated as zero spend', () => {
  const { root, rt } = fixture();
  try {
    const noCost = ingest(rt, { exitCode: 0, turnEndReason: 'end_turn', tokens: { in: 10, out: 10 } });
    assert.equal(noCost.budget.available, false);
    assert.equal(noCost.budget.reason, 'COST_UNKNOWN');
    assert.equal(rt.getTask('T1').state, 'IN_PROGRESS');

    const noTokens = ingest(rt, { exitCode: 0, turnEndReason: 'end_turn', costUsd: 1 });
    assert.equal(noTokens.budget.available, false);
    assert.equal(noTokens.budget.reason, 'COST_UNKNOWN');
  } finally {
    rt.close();
    cleanup(root);
  }
});
