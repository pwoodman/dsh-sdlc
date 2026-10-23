/**
 * tests/unit/scheduler-cap.test.mjs — the resource CAP in `checkNoOverlap` (B.10/K.3)
 * plus the B15 dispatch fan-out (cap + concurrent ASSIGNED batch).
 *
 * Regression guard: `maxSharedResourceTasks` is a CAP. With a cap above 1 the
 * old checker returned no violations at all, so a genuine overrun (three tasks
 * holding one resource against a cap of two) was invisible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const s = await core.scheduler();
const { Runtime } = await core.runtime();

function task(id, state, allowed_paths = [], resources = []) {
  return { id, state, allowed_paths, resources };
}

function freshRuntime(prefix, config = null) {
  const root = tempDir(prefix);
  const rt = new Runtime({
    projectRoot: root,
    config: config ?? {
      storage: { dbPath: '.sdlc/sdlc.db', requireQuickCheckOnOpen: true },
      safety: { instanceLock: false },
      execution: { maxParallelWorkers: 2 },
      budgets: {},
    },
  });
  rt.open();
  rt.createProject({ id: 'P1', name: 'P1' });
  return { root, rt };
}

test('cap 1: two holders of one resource is reported with the documented shape', () => {
  const tasks = [
    task('DB-001', 'ASSIGNED', ['src/db/**'], ['package.json']),
    task('API-001', 'IN_PROGRESS', ['src/api/**'], ['package.json']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 1 });
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    kind: 'resource-collision',
    a: 'DB-001',
    b: 'API-001',
    resources: ['package.json'],
  });
});

test('cap 2: two holders is exactly at the cap and is legal', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json']),
    task('B', 'IN_PROGRESS', ['src/b/**'], ['package.json']),
  ];
  assert.deepEqual(s.checkNoOverlap(tasks, { maxSharedResourceTasks: 2 }), []);
});

test('cap 2: three holders exceeds the cap and IS reported (the old blind spot)', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json']),
    task('B', 'IN_PROGRESS', ['src/b/**'], ['package.json']),
    task('C', 'VERIFYING', ['src/c/**'], ['package.json']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 2 });
  assert.equal(violations.length, 1, `expected one cap breach, got ${JSON.stringify(violations)}`);
  assert.equal(violations[0].kind, 'resource-collision');
  assert.deepEqual(violations[0].holders, ['A', 'B', 'C']);
  assert.equal(violations[0].cap, 2);
  assert.deepEqual(violations[0].resources, ['package.json']);
});

test('cap 3: three holders is exactly at the cap and is legal', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json']),
    task('B', 'IN_PROGRESS', ['src/b/**'], ['package.json']),
    task('C', 'VERIFYING', ['src/c/**'], ['package.json']),
  ];
  assert.deepEqual(s.checkNoOverlap(tasks, { maxSharedResourceTasks: 3 }), []);
});

test('path ownership overlap is independent of the resource cap', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/**']),
    task('B', 'IN_PROGRESS', ['src/api/**']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 5 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'ownership-overlap');
});

test('multiple distinct overrun resources each produce their own violation', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json', 'tsconfig.json']),
    task('B', 'IN_PROGRESS', ['src/b/**'], ['package.json', 'tsconfig.json']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 1 });
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.resources[0]).sort(), ['package.json', 'tsconfig.json']);
});

// ── B15: the capped ASSIGNED fan-out ─────────────────────────────────────────
// planStep over N independent READY tasks with cap C proposes exactly
// min(N, C) ASSIGNED transitions; dispatchBatch applies them concurrently
// (Promise.all, bounded by the cap) via the runtime's own transition path,
// so locks stay respected and the single-writer invariant holds.

test('B15: planStep batch of N independent tasks with cap C proposes exactly min(N, C) ASSIGNED', () => {
  const tasks = ['T1', 'T2', 'T3', 'T4', 'T5'].map((id, i) =>
    ({ id, state: 'READY', allowed_paths: [`src/${i}/**`], resources: [], depends_on: [] }));
  const step = s.planStep({ tasks }, { maxParallelWorkers: 2 });
  const assigned = step.filter((t) => t.to === 'ASSIGNED');
  assert.equal(assigned.length, 2, `cap 2 over 5 READY tasks must propose exactly 2 ASSIGNED, got ${assigned.length}`);
  assert.deepEqual(assigned.map((t) => t.taskId), ['T1', 'T2'], 'stable id order');
});

test('B15: dispatchBatch applies exactly the capped batch and respects locks', async () => {
  const { root, rt } = freshRuntime('sdlc-dispatch-batch-');
  try {
    // Four independent READY tasks (disjoint paths, no shared resources).
    for (const [id, path] of [['B1', 'src/b1/**'], ['B2', 'src/b2/**'], ['B3', 'src/b3/**'], ['B4', 'src/b4/**']]) {
      rt.addTask({ id, title: id, project_id: 'P1', allowed_paths: [path], resources: [] });
      rt.state._setState(id, 'READY');
    }
    const applied = await rt.dispatchBatch({ projectId: 'P1' });
    assert.equal(applied.length, 2, `cap 2 over 4 READY tasks must ASSIGN exactly 2, got ${JSON.stringify(applied)}`);
    assert.equal(rt.getTask('B1').state, 'ASSIGNED');
    assert.equal(rt.getTask('B2').state, 'ASSIGNED');
    assert.equal(rt.getTask('B3').state, 'READY');
    assert.equal(rt.getTask('B4').state, 'READY');
    // The creation event plus one row per applied transition (L.1: the
    // runtime owns transitions — addTask's task-created is row 1).
    assert.equal(rt.getEvents({ taskId: 'B1' }).length, 2);
    assert.equal(rt.getEvents({ taskId: 'B1' })[1].action, 'READY→ASSIGNED');
  } finally {
    rt.close({ releaseLock: false });
    cleanup(root);
  }
});

test('B15: dispatchBatch serializes resource-locked tasks (locks respected under the cap)', async () => {
  const { root, rt } = freshRuntime('sdlc-dispatch-locks-');
  try {
    // Same resource on both: only one may ASSIGN no matter how high the cap.
    for (const id of ['L1', 'L2']) {
      rt.addTask({ id, title: id, project_id: 'P1', allowed_paths: [`src/${id.toLowerCase()}/**`], resources: ['package.json'] });
      rt.state._setState(id, 'READY');
    }
    const applied = await rt.dispatchBatch({ projectId: 'P1', cap: 8 });
    assert.equal(applied.length, 1, `resource lock must serialize to 1 ASSIGNED, got ${JSON.stringify(applied)}`);
    const states = [rt.getTask('L1').state, rt.getTask('L2').state].sort();
    assert.deepEqual(states, ['ASSIGNED', 'READY']);
  } finally {
    rt.close({ releaseLock: false });
    cleanup(root);
  }
});

test('B15: dispatchParallelism honors the explicit config over host auto', async () => {
  const { root, rt } = freshRuntime('sdlc-dispatch-cap-');
  try {
    // Config says 2: even with 64 cores / 64 GiB the cap is 2.
    const cap = await rt.dispatchParallelism({ cpus: 64, ramGb: 64 });
    assert.equal(cap, 2, `explicit maxParallelWorkers: 2 must win over host auto, got ${cap}`);
    // And an explicit dispatchBatch cap overrides the config.
    for (const [id, path] of [['C1', 'src/c1/**'], ['C2', 'src/c2/**'], ['C3', 'src/c3/**']]) {
      rt.addTask({ id, title: id, project_id: 'P1', allowed_paths: [path], resources: [] });
      rt.state._setState(id, 'READY');
    }
    const applied = await rt.dispatchBatch({ projectId: 'P1', cap: 1 });
    assert.equal(applied.length, 1);
  } finally {
    rt.close({ releaseLock: false });
    cleanup(root);
  }
});
