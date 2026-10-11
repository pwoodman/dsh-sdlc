/**
 * tests/integration/dependency-blocking.test.mjs — spec v3 G.3.1, B.2.1 (L4).
 *
 * `scheduler.planStep` must keep API-001 in BACKLOG until its dependency DB-001
 * is DONE, and must move the dependent to BLOCKED when a dependency has failed.
 * The BLOCKED transition is then applied through the REAL state machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup, sampleTaskGraph } from '../lib/helpers.mjs';

test('dependency-blocking: dependent stays BACKLOG until the dependency is DONE', async () => {
  const { planStep } = await core.scheduler();
  const tasks = sampleTaskGraph('P1').map((t) => ({
    id: t.id, state: 'BACKLOG', allowed_paths: t.allowed_paths,
    resources: t.resources, depends_on: t.depends_on ?? [],
  }));

  const step1 = planStep({ tasks });
  assert.equal(step1.some((t) => t.taskId === 'API-001'), false,
    'API-001 must stay BACKLOG while DB-001 is not DONE');
  assert.deepEqual(
    step1.filter((t) => t.taskId === 'DB-001').map((t) => t.to),
    ['READY', 'ASSIGNED'],
    'the dependency-free task is promoted and assigned in the same tick',
  );

  let state = tasks.map((t) => {
    const changes = step1.filter((x) => x.taskId === t.id);
    return changes.length ? { ...t, state: changes.at(-1).to } : t;
  });
  const step2 = planStep({ tasks: state });
  assert.equal(step2.some((t) => t.taskId === 'API-001'), false, 'API-001 still waits');

  // DB-001 lands -> API-001 becomes READY (and assigned in the same tick).
  state = state.map((t) => (t.id === 'DB-001' ? { ...t, state: 'DONE' } : t));
  const step3 = planStep({ tasks: state });
  assert.deepEqual(step3.map((t) => [t.taskId, t.to]), [['API-001', 'READY'], ['API-001', 'ASSIGNED']]);
});

test('dependency-blocking: a failed dependency produces a BLOCKED transition for the dependent', async () => {
  const { planStep } = await core.scheduler();
  const tasks = sampleTaskGraph('P1').map((t) => ({
    id: t.id, state: 'BACKLOG', allowed_paths: t.allowed_paths,
    resources: t.resources, depends_on: t.depends_on ?? [],
  }));
  const failed = tasks.map((t) => (t.id === 'DB-001' ? { ...t, state: 'FAILED' } : t));

  const planned = planStep({ tasks: failed });
  const block = planned.find((t) => t.taskId === 'API-001');
  assert.ok(block, 'API-001 must be proposed for BLOCKED');
  assert.equal(block.to, 'BLOCKED');
  assert.equal(block.actor, 'scheduler');
  assert.equal(block.ctx.depStates['DB-001'], 'FAILED');
  assert.equal(planned.some((t) => t.taskId === 'DB-001'), false, 'a FAILED task is not re-planned here');

  // Apply it through the REAL state machine in a temp-dir project.
  const root = tempDir('sdlc-depblock-');
  const { Runtime } = await core.runtime();
  const rt = new Runtime({ projectRoot: root, config: {}, useLock: true });
  try {
    rt.open();
    rt.createProject({ id: 'P1', name: 'dep-block' });
    for (const t of sampleTaskGraph('P1')) rt.addTask(t);

    // Drive DB-001 to FAILED via the matrix.
    assert.equal(rt.transition('DB-001', 'READY', 'scheduler', { depStates: {} }).ok, true);
    assert.equal(rt.transition('DB-001', 'ASSIGNED', 'scheduler', { available: true }).ok, true);
    assert.equal(rt.transition('DB-001', 'IN_PROGRESS', 'worker-mgr', {}).ok, true);
    assert.equal(rt.transition('DB-001', 'FAILED', 'worker-mgr', { hardFailure: true }).ok, true);

    assert.equal(rt.getTask('API-001').state, 'BACKLOG');
    const applied = rt.transition('API-001', block.to, block.actor, block.ctx);
    assert.equal(applied.ok, true, applied.ok ? '' : applied.reason);
    assert.equal(rt.getTask('API-001').state, 'BLOCKED');

    const event = rt.getEvents({ taskId: 'API-001' }).at(-1);
    assert.equal(event.action, 'BACKLOG→BLOCKED');
    assert.equal(event.actor, 'scheduler');
    assert.equal(JSON.parse(event.payload_json).guard, 'anyDepFailed',
      'the failed-dependency guard is recorded as evidence');
    assert.equal(JSON.parse(event.payload_json).to, 'BLOCKED');

    // NEGATIVE CONTROL: BLOCKED→BACKLOG requires the blocker to be resolved.
    const rejected = rt.transition('API-001', 'BACKLOG', 'escalation-mgr', {});
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'INVALID_TRANSITION');
    assert.match(rejected.reason, /guard blockerResolved rejected/);
    assert.equal(rt.getTask('API-001').state, 'BLOCKED', 'the rejected proposal left state untouched');
  } finally {
    rt.close();
    cleanup(root);
  }
});
