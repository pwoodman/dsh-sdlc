/**
 * tests/integration/resource-serialization.test.mjs — spec v3 G.3.1, B.10, K.3 (L4).
 *
 * The scheduler promise (§19–21): no two concurrently active tasks may share a
 * `task_resources` entry (`max_shared_resource_tasks = 1`).
 *
 * Verified here with `scheduler.planStep` / `locksGrantable` / `checkNoOverlap`:
 *   - two simultaneously-READY tasks sharing a resource get at most one ASSIGNED;
 *   - a task whose resource is already held by an ACTIVE task is never assigned;
 *   - `checkNoOverlap` reports the collision when two active tasks are forced.
 *
 * (Regression guard: an earlier revision of `planStep` did not fold proposed
 * ASSIGNED transitions into its `projected` snapshot and assigned both tasks.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

function task(id, resources, allowedPaths, state = 'READY', extra = {}) {
  return { id, state, resources, allowed_paths: allowedPaths, depends_on: [], ...extra };
}

test('resource-serialization: an active holder blocks a second shared-resource task', async () => {
  const { planStep, locksGrantable, checkNoOverlap } = await core.scheduler();

  // DB-001 is already active (ASSIGNED) and holds `package.json`.
  const snapshot = [
    task('API-001', ['package.json'], ['src/api/**'], 'READY'),
    task('DB-001', ['package.json'], ['src/db/**'], 'ASSIGNED'),
  ];

  const lock = locksGrantable(snapshot[0], snapshot, { maxSharedResourceTasks: 1 });
  assert.equal(lock.ok, false, 'a shared resource held by an active task must refuse the lock');
  assert.match(lock.reason, /resource package\.json locked by DB-001/);

  const transitions = planStep({ tasks: snapshot }, { maxParallelWorkers: 4, maxSharedResourceTasks: 1 });
  assert.deepEqual(
    transitions.filter((t) => t.to === 'ASSIGNED'),
    [],
    'planStep must not assign a task whose shared resource is already held',
  );
});

test('resource-serialization: ownership overlap is serialized while a path owner is active', async () => {
  const { planStep, checkNoOverlap } = await core.scheduler();
  const snapshot = [
    task('A-1', [], ['src/shared/**'], 'ASSIGNED'),
    task('B-1', [], ['src/shared/**'], 'READY'),
  ];
  const transitions = planStep({ tasks: snapshot });
  assert.deepEqual(transitions.filter((t) => t.to === 'ASSIGNED'), []);
  // And the invariant checker agrees once both are forced active.
  const forced = snapshot.map((t) => ({ ...t, state: 'ASSIGNED' }));
  const violations = checkNoOverlap(forced);
  assert.ok(
    violations.some((v) => v.kind === 'ownership-overlap' && v.a === 'A-1' && v.b === 'B-1'),
    'checkNoOverlap must report a path ownership collision',
  );
});

test('resource-serialization: NEGATIVE CONTROL — checkNoOverlap reports a forced resource collision', async () => {
  const { checkNoOverlap } = await core.scheduler();
  const forcedActive = [
    task('DB-001', ['package.json'], ['src/db/**'], 'ASSIGNED'),
    task('API-001', ['package.json'], ['src/api/**'], 'IN_PROGRESS'),
  ];
  const violations = checkNoOverlap(forcedActive, { maxSharedResourceTasks: 1 });
  assert.equal(violations.length, 1, 'exactly one collision is expected');
  assert.deepEqual(violations[0], {
    kind: 'resource-collision',
    a: 'DB-001',
    b: 'API-001',
    resources: ['package.json'],
  });
  // No collision when the cap allows sharing.
  assert.deepEqual(checkNoOverlap(forcedActive, { maxSharedResourceTasks: 2 }), []);
});

test('resource-serialization: two READY tasks sharing a resource are never both ASSIGNED in one step', async () => {
  const { planStep } = await core.scheduler();
  const snapshot = [
    task('API-001', ['package.json'], ['src/api/**'], 'READY'),
    task('DB-001', ['package.json'], ['src/db/**'], 'READY'),
  ];
  const transitions = planStep({ tasks: snapshot });
  const assigned = transitions.filter((t) => t.to === 'ASSIGNED');
  assert.equal(assigned.length, 1,
    `planStep must assign at most one shared-resource task per step, got ${assigned.length}`);
  assert.equal(assigned[0].taskId, 'API-001', 'stable id order: the first candidate wins the lock');

  // Applying the emitted step can never produce a collision.
  const applied = snapshot.map((t) => {
    const change = transitions.find((x) => x.taskId === t.id && x.to === 'ASSIGNED');
    return change ? { ...t, state: 'ASSIGNED' } : t;
  });
  const { checkNoOverlap } = await core.scheduler();
  assert.deepEqual(checkNoOverlap(applied), [], 'the emitted plan must be collision-free');
});
