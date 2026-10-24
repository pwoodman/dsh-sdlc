/**
 * tests/unit/recovery-reconcile.test.mjs — one transition per reconciled task (B.12).
 *
 * Regression guard: `reconcile` used to emit BOTH `FAILED` (dead worker) and
 * `ESCALATED` (missing worktree) for the same task, so the runtime could apply
 * two contradictory moves. Ambiguity must ESCALATE, and only once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const rec = await core.recovery();

const run = (over = {}) => ({ id: 'R1', task_id: 'T1', attempt: 1, pid: 4242, worktree_path: '/w/T1', finished_at: null, status: 'running', ...over });
const task = (over = {}) => ({ id: 'T1', state: 'IN_PROGRESS', worktree_path: '/w/T1', branch: 'sdlc/task-T1', ...over });

test('a dead worker in a missing worktree escalates exactly once (no FAILED+ESCALATED pair)', () => {
  const result = rec.reconcile({
    tasks: [task()],
    runs: [run()],
    isAlive: () => false,
    worktreeExists: () => false,
  });
  assert.deepEqual(result.transitions, [
    { taskId: 'T1', to: 'ESCALATED', actor: 'recovery', evidence: 'missing-worktree' },
  ]);
  const kinds = result.discrepancies.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['dead-worker', 'missing-worktree']);
  // The ambiguity is recorded as such, not silently dropped.
  assert.deepEqual(result.ambiguous.map((d) => d.kind), ['missing-worktree']);
});

test('a missing branch also escalates at most once and outranks salvage', () => {
  const result = rec.reconcile({
    tasks: [task()],
    runs: [run()],
    isAlive: () => false,
    worktreeExists: () => true,
    branchExists: () => false,
  });
  assert.deepEqual(result.transitions, [
    { taskId: 'T1', to: 'ESCALATED', actor: 'recovery', evidence: 'missing-branch' },
  ]);
});

test('a dead worker with an intact worktree still salvages to FAILED exactly once', () => {
  const result = rec.reconcile({
    tasks: [task()],
    runs: [run()],
    isAlive: () => false,
    worktreeExists: () => true,
    branchExists: () => true,
  });
  assert.deepEqual(result.transitions, [
    { taskId: 'T1', to: 'FAILED', actor: 'recovery', evidence: 'ORPHAN_SALVAGE' },
  ]);
});

test('an unfinished run with no pid is an orphan (the resume path used to strand it)', () => {
  const result = rec.reconcile({
    tasks: [task()],
    runs: [run({ pid: null })],
    isAlive: () => false,
    worktreeExists: () => true,
    branchExists: () => true,
  });
  assert.deepEqual(result.transitions, [
    { taskId: 'T1', to: 'FAILED', actor: 'recovery', evidence: 'ORPHAN_SALVAGE' },
  ]);
  const dead = result.discrepancies.find((d) => d.kind === 'dead-worker');
  assert.equal(dead?.detail, 'no-pid');
});

test('every reconciled task yields at most one transition, whatever the combination', () => {
  const result = rec.reconcile({
    tasks: [
      task({ id: 'T1' }),
      task({ id: 'T2', worktree_path: null }),
      task({ id: 'T3', state: 'VERIFYING' }),
      task({ id: 'T4' }),
    ],
    runs: [
      run({ id: 'R1', task_id: 'T1' }),
      run({ id: 'R2', task_id: 'T2' }),
      run({ id: 'R4', task_id: 'T4', pid: 7 }),
    ],
    isAlive: (pid) => pid === 7,
    worktreeExists: () => false,
    branchExists: () => false,
  });
  const perTask = new Map();
  for (const t of result.transitions) perTask.set(t.taskId, (perTask.get(t.taskId) ?? 0) + 1);
  for (const [taskId, n] of perTask) assert.equal(n, 1, `${taskId} produced ${n} transitions`);
  // T3 has an active state but no open run: exactly one ESCALATED, no run checks.
  assert.deepEqual(result.transitions.find((t) => t.taskId === 'T3'), {
    taskId: 'T3', to: 'ESCALATED', actor: 'recovery', evidence: 'active-state-without-run',
  });
});

test('applyReconciliation persists orphaned=1 for dead workers (A1)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const rec = await core.recovery();
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE worker_runs (id TEXT PRIMARY KEY, task_id TEXT, attempt INTEGER, pid INTEGER, finished_at TEXT, orphaned INTEGER DEFAULT 0, worktree_path TEXT)`);
  db.prepare(`INSERT INTO worker_runs(id, task_id, attempt, pid, finished_at, worktree_path) VALUES ('R1','T1',0,4242,NULL,'/w')`).run();
  const state = { transition: (taskId, to, actor, ctx) => ({ ok: true, taskId, to, actor, ctx }) };
  const out = rec.applyReconciliation({
    db, state,
    tasks: [{ id: 'T1', state: 'IN_PROGRESS', worktree_path: '/w', branch: null }],
    runs: db.prepare('SELECT * FROM worker_runs').all(),
    isAlive: () => false,
    worktreeExists: () => true,
    branchExists: () => true,
  });
  assert.equal(out.applied.length, 1);
  assert.equal(out.applied[0].to, 'FAILED');
  assert.equal(out.applied[0].evidence, 'ORPHAN_SALVAGE');
  assert.equal(db.prepare('SELECT orphaned FROM worker_runs WHERE id = ?').get('R1').orphaned, 1);
});

test('markOrphaned returns false for an unknown run (A1)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const rec = await core.recovery();
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE worker_runs (id TEXT PRIMARY KEY, orphaned INTEGER DEFAULT 0)`);
  assert.equal(rec.markOrphaned(db, 'missing'), false);
});
