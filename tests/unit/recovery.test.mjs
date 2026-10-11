/**
 * tests/unit/recovery.test.mjs — orphan salvage and reconciliation (spec v3 B.12, B.3.2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const rec = await core.recovery();

const run = (over = {}) => ({ id: 'R1', task_id: 'T1', attempt: 1, pid: 4242, worktree_path: '/w/T1', finished_at: null, status: 'running', ...over });
const task = (over = {}) => ({ id: 'T1', state: 'IN_PROGRESS', worktree_path: '/w/T1', branch: 'sdlc/task-T1', ...over });

test('a dead-pid worker run is an orphan; a live one is kept', () => {
  const dead = rec.findOrphans({ runs: [run()], isAlive: () => false });
  assert.equal(dead.length, 1);
  assert.equal(dead[0].reason, 'dead-pid');
  const live = rec.findOrphans({ runs: [run()], isAlive: () => true });
  assert.deepEqual(live, []);
});

test('finished runs are never orphans', () => {
  const finished = rec.findOrphans({ runs: [run({ finished_at: '2025-01-01T00:00:00Z', status: 'completed' })], isAlive: () => false });
  assert.deepEqual(finished, []);
});

test('salvagePlan snapshots the worktree and marks the run orphaned (B.3.2)', () => {
  const [orphan] = rec.findOrphans({ runs: [run()], isAlive: () => false });
  const plan = rec.salvagePlan(orphan);
  assert.equal(plan.snapshotDir, '.sdlc/recovery/R1');
  assert.equal(plan.markOrphaned, true);
  assert.equal(plan.transition.to, 'FAILED');
  assert.ok(plan.commands.some((c) => c.argv.includes('diff')));
});

test('reconcile reports dead workers and ambiguous states, with transitions', () => {
  const result = rec.reconcile({
    tasks: [
      task({ id: 'T1', state: 'IN_PROGRESS' }),
      task({ id: 'T2', state: 'VERIFYING', worktree_path: '/w/T2' }),
      task({ id: 'T3', state: 'ASSIGNED' }),
    ],
    runs: [run({ id: 'R1', task_id: 'T1' }), run({ id: 'R2', task_id: 'T2', pid: 1 })],
    isAlive: (pid) => pid === 1,
    worktreeExists: () => true,
  });
  const kinds = result.discrepancies.map((d) => d.kind);
  assert.ok(kinds.includes('dead-worker'), 'T1 pid 4242 is dead');
  assert.ok(kinds.includes('active-state-without-run'), 'T3 has a state but no run');
  assert.equal(result.transitions.some((t) => t.taskId === 'T1' && t.to === 'FAILED'), true);
  assert.equal(result.transitions.some((t) => t.taskId === 'T3' && t.to === 'ESCALATED'), true);
  assert.equal(result.ambiguous.length >= 1, true);
});

test('a missing worktree escates rather than inventing state', () => {
  const result = rec.reconcile({
    tasks: [task({ state: 'IN_PROGRESS' })],
    runs: [run()],
    isAlive: () => true,
    worktreeExists: () => false,
  });
  assert.equal(result.discrepancies.some((d) => d.kind === 'missing-worktree'), true);
  assert.equal(result.transitions.some((t) => t.to === 'ESCALATED'), true);
});

test('resumePlan re-enters the scheduler and never invents state', () => {
  const plan = rec.resumePlan({ tasks: [task({ state: 'IN_PROGRESS' })], runs: [run()], isAlive: () => false });
  assert.equal(plan.step, 'reconcile');
  assert.equal(plan.reenterScheduler, true);
  assert.equal(plan.transitions.length >= 1, true);
});
