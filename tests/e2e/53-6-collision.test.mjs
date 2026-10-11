/**
 * tests/e2e/53-6-collision.test.mjs — §53 Test 6, Resource collision (spec v3 K.8, D.1).
 *
 * Two workers that both need `package.json` must SERIALIZE: the
 * `task_resources` lock plus the B.2.1 `READY→ASSIGNED` guard mean only one can
 * hold the resource at a time.
 *
 * Runtime evidence asserted: `task_resources` rows, the real `planStep`
 * decisions, the `locksGrantable` guard rejection in `sdlc.db` events, the
 * no-overlap invariant, and the fact that the second task only dispatches after
 * the first is DONE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M, createHarness, addTasks, schedule, planNow, stageTaskWork, runAttempt,
  mergeAcceptedTask, makeMock, modelDecision, resourceRows,
} from './harness.mjs';

const { scheduler } = M;

test('§53 Test 6: two workers on package.json serialize through task_resources', async () => {
  const h = await createHarness();
  try {
    const mock = makeMock();
    addTasks(h, [
      {
        id: 'COL-A', title: 'Touch A', role: 'backend-engineer', objective: 'A', risk_class: 'R2',
        resources: ['package.json'], allowed_paths: ['src/a/**'],
        verification: ['syntax', 'lint', 'unit', 'integration'],
      },
      {
        id: 'COL-B', title: 'Touch B', role: 'backend-engineer', objective: 'B', risk_class: 'R2',
        resources: ['package.json'], allowed_paths: ['src/b/**'],
        verification: ['syntax', 'lint', 'unit', 'integration'],
      },
    ]);

    // `task_resources` is the persisted lock table.
    assert.deepEqual(resourceRows(h), [
      { task_id: 'COL-A', resource: 'package.json' },
      { task_id: 'COL-B', resource: 'package.json' },
    ]);

    // ── only one holder is granted in a single scheduler step ──────────────
    const applied = schedule(h);
    const assigned = applied.filter((t) => t.to === 'ASSIGNED').map((t) => t.taskId);
    assert.deepEqual(assigned, ['COL-A'], `exactly one package.json holder: ${assigned}`);
    assert.equal(h.runtime.getTask('COL-A').state, 'ASSIGNED');
    assert.equal(h.runtime.getTask('COL-B').state, 'READY');
    assert.deepEqual(planNow(h).filter((t) => t.to === 'ASSIGNED'), [], 'no second grant while the lock is held');

    // ── the invariant holds over the concurrently active set ───────────────
    assert.deepEqual(scheduler.checkNoOverlap(h.runtime.projectTasks(h.projectId)), []);
    // NEGATIVE CONTROL: if both were ASSIGNED the invariant reports the collision.
    const bad = [
      { id: 'COL-A', state: 'ASSIGNED', allowed_paths: ['src/a/**'], resources: ['package.json'], depends_on: [] },
      { id: 'COL-B', state: 'ASSIGNED', allowed_paths: ['src/b/**'], resources: ['package.json'], depends_on: [] },
    ];
    assert.ok(scheduler.checkNoOverlap(bad).some((v) => v.kind === 'resource-collision'));

    // ── `locksGrantable` names the holder ─────────────────────────────────
    const lock = scheduler.locksGrantable(
      { id: 'COL-B', allowed_paths: ['src/b/**'], resources: ['package.json'] },
      [{ ...h.runtime.getTask('COL-A'), state: 'ASSIGNED' }],
    );
    assert.equal(lock.ok, false);
    assert.match(lock.reason, /resource package\.json locked by COL-A/);

    // ── the READY→ASSIGNED guard rejects an unavailable lock ──────────────
    const guarded = h.runtime.state.transition('COL-B', 'ASSIGNED', 'scheduler', { available: false });
    assert.equal(guarded.ok, false);
    assert.equal(guarded.error, 'INVALID_TRANSITION');
    assert.match(guarded.reason, /locksGrantable/);
    assert.equal(h.runtime.getTask('COL-B').state, 'READY', 'the guarded task is unchanged');
    const evt = h.runtime.getEvents({ taskId: 'COL-B' });
    assert.ok(!evt.some((e) => e.action === 'READY→ASSIGNED'), 'no ASSIGNED event may be written');

    // ── completing A releases the resource for B ──────────────────────────
    const workA = stageTaskWork(h, {
      taskId: 'COL-A',
      files: { 'src/a/service.js': 'export const a = 1;\n', 'src/a/service.test.js': 'test("a", () => {});\n' },
    });
    const attemptA = runAttempt(h, {
      taskId: 'COL-A', filesChanged: workA.filesChanged,
      review: modelDecision(mock, 'mock/review-accept'), branch: workA.branch,
    });
    assert.equal(attemptA.decision.accept, true, JSON.stringify(attemptA.decision));
    mergeAcceptedTask(h, { taskId: 'COL-A', branch: workA.branch });
    assert.equal(h.runtime.getTask('COL-A').state, 'DONE');

    const second = schedule(h);
    assert.ok(second.some((t) => t.taskId === 'COL-B' && t.to === 'ASSIGNED'), JSON.stringify(second));
    assert.equal(h.runtime.getTask('COL-B').state, 'ASSIGNED');
  } finally {
    h.close();
  }
});
