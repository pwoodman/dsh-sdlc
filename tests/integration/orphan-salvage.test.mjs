/**
 * tests/integration/orphan-salvage.test.mjs — spec v3 G.3.1, B.3.2, B.12 (L4).
 *
 * A worker run whose pid is dead is an orphan: it produces a snapshot plan
 * under `.sdlc/recovery/<runId>` and the task is marked FAILED with evidence.
 * A live pid is kept (never treated as an orphan).
 *
 * Deviation D4 lists `recovery` as a legal actor on `IN_PROGRESS → FAILED`
 * (the matrix's recovery wildcard covers the remaining non-terminal states), so
 * reconciliation's salvage transition is applied exactly as `recovery.reconcile`
 * emits it — no worker-mgr substitute is required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

test('orphan-salvage: a dead pid is an orphan and gets a snapshot plan', async () => {
  const { findOrphans, salvagePlan, reconcile } = await core.recovery();

  const runs = [
    { id: 'T-1-a0-dead', task_id: 'T-1', attempt: 0, pid: 999_999, status: 'running', finished_at: null, worktree_path: '.sdlc/worktrees/T-1' },
    { id: 'T-2-a0-live', task_id: 'T-2', attempt: 0, pid: process.pid, status: 'running', finished_at: null, worktree_path: '.sdlc/worktrees/T-2' },
    { id: 'T-3-a0-done', task_id: 'T-3', attempt: 0, pid: 999_998, status: 'completed', finished_at: '2024-01-01T00:00:00Z', worktree_path: null },
  ];
  const isAlive = (pid) => pid === process.pid;
  const orphans = findOrphans({ runs, isAlive, worktreeExists: () => true });
  assert.equal(orphans.length, 1);
  assert.deepEqual(
    { runId: orphans[0].runId, taskId: orphans[0].taskId, reason: orphans[0].reason },
    { runId: 'T-1-a0-dead', taskId: 'T-1', reason: 'dead-pid' },
  );

  const plan = salvagePlan(orphans[0]);
  assert.equal(plan.snapshotDir, '.sdlc/recovery/T-1-a0-dead');
  assert.equal(plan.markOrphaned, true);
  assert.deepEqual(plan.transition, { to: 'FAILED', actor: 'recovery', reason: 'ORPHAN_SALVAGE' });
  assert.ok(plan.commands.some((c) => c.step === 'diff' && c.capture.endsWith('diff.patch')));
  assert.ok(plan.commands.some((c) => c.step === 'status' && c.capture.endsWith('status.txt')));

  // Execute the snapshot plan inside a temp project root.
  const root = tempDir('sdlc-orphan-');
  try {
    mkdirSync(join(root, plan.snapshotDir), { recursive: true });
    writeFileSync(join(root, plan.snapshotDir, 'diff.patch'), '# orphan diff\n');
    writeFileSync(join(root, plan.snapshotDir, 'status.txt'), 'M src/api/x.ts\n');
    assert.ok(existsSync(join(root, plan.snapshotDir, 'diff.patch')));
    assert.ok(existsSync(join(root, plan.snapshotDir, 'status.txt')));

    const recon = reconcile({
      tasks: [
        { id: 'T-1', state: 'IN_PROGRESS' },
        { id: 'T-2', state: 'IN_PROGRESS' },
      ],
      runs,
      isAlive,
      worktreeExists: () => true,
    });
    assert.deepEqual(recon.discrepancies, [{ taskId: 'T-1', kind: 'dead-worker', detail: 'pid 999999 is not alive' }]);
    assert.deepEqual(recon.transitions, [
      { taskId: 'T-1', to: 'FAILED', actor: 'recovery', evidence: 'ORPHAN_SALVAGE' },
    ]);
    assert.deepEqual(recon.ambiguous, [], 'a dead worker is not ambiguous');
  } finally {
    cleanup(root);
  }
});

test('orphan-salvage: the runtime marks the orphan task FAILED with evidence', async () => {
  const { findOrphans, reconcile } = await core.recovery();
  const { Runtime } = await core.runtime();
  const root = tempDir('sdlc-orphan-rt-');
  const rt = new Runtime({ projectRoot: root, config: {}, useLock: true });
  try {
    rt.open();
    rt.createProject({ id: 'P1', name: 'orphan' });
    rt.addTask({ id: 'T-1', project_id: 'P1', title: 'orphan task', risk_class: 'R2' });
    assert.equal(rt.transition('T-1', 'READY', 'scheduler', { depStates: {} }).ok, true);
    assert.equal(rt.transition('T-1', 'ASSIGNED', 'scheduler', { available: true }).ok, true);
    assert.equal(rt.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {}).ok, true);
    const runId = rt.startWorkerRun({ taskId: 'T-1', attempt: 0, pid: 999_999, worktreePath: '.sdlc/worktrees/T-1' });

    const runs = rt.listWorkerRuns();
    const isAlive = () => false;
    const orphans = findOrphans({ runs, isAlive, worktreeExists: () => true });
    assert.deepEqual(orphans.map((o) => o.runId), [runId]);

    const recon = reconcile({ tasks: rt.listTasks(), runs, isAlive, worktreeExists: () => true });
    assert.equal(recon.transitions.length, 1);
    assert.equal(recon.transitions[0].to, 'FAILED');

    const evidence = { evidence: 'ORPHAN_SALVAGE', runId };
    // D4: `recovery` is a legal actor for IN_PROGRESS→FAILED, so the transition
    // emitted by reconcile applies as written. Asserting it directly pins D4 —
    // a silent fallback to worker-mgr would hide a regression in the matrix.
    const applied = rt.transition('T-1', 'FAILED', 'recovery', { hardFailure: true, payload: evidence });
    assert.equal(applied.ok, true, applied.ok ? '' : applied.reason);
    assert.equal(rt.getTask('T-1').state, 'FAILED');
    const event = rt.getEvents({ taskId: 'T-1' }).at(-1);
    assert.equal(event.action, 'IN_PROGRESS→FAILED');
    assert.equal(JSON.parse(event.payload_json).evidence, 'ORPHAN_SALVAGE');
    assert.equal(JSON.parse(event.payload_json).runId, runId);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('orphan-salvage: NEGATIVE CONTROL — a live pid is never reclaimed', async () => {
  const { findOrphans, reconcile } = await core.recovery();
  const runs = [{
    id: 'LIVE-1', task_id: 'T-1', attempt: 0, pid: process.pid,
    status: 'running', finished_at: null, worktree_path: '.sdlc/worktrees/T-1',
  }];
  const orphans = findOrphans({ runs, isAlive: (pid) => pid === process.pid });
  assert.deepEqual(orphans, []);
  const recon = reconcile({
    tasks: [{ id: 'T-1', state: 'IN_PROGRESS' }],
    runs,
    isAlive: () => true,
  });
  assert.deepEqual(recon.discrepancies, []);
  assert.deepEqual(recon.transitions, []);
});
