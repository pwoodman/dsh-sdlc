/**
 * tests/integration/dispatch-and-complete.test.mjs — spec v3 G.3.1 (L4).
 *
 * Happy path through the REAL `Runtime` + `TaskStateService` on a temp-dir
 * project with the instance lock ON and a real `node:sqlite` database:
 *   BACKLOG → READY → ASSIGNED → IN_PROGRESS → VERIFYING → ACCEPTED → MERGING → DONE
 *
 * Assertions:
 *   - final task states;
 *   - every accepted transition wrote exactly one `events` row;
 *   - `runtime.assertIntegrity()` returns `ok`.
 *
 * Negative controls:
 *   - a terminal task rejects any further transition AND writes no event;
 *   - a legal (from,to) pair proposed by the wrong actor is rejected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup, sampleTaskGraph, driveToDone } from '../lib/helpers.mjs';

async function freshRuntime(prefix) {
  const root = tempDir(prefix);
  const { Runtime } = await core.runtime();
  const rt = new Runtime({ projectRoot: root, config: {}, useLock: true });
  rt.open();
  return { root, rt };
}

test('dispatch-and-complete: BACKLOG → DONE through the real runtime', async () => {
  const { root, rt } = await freshRuntime('sdlc-dispatch-');
  try {
    rt.createProject({ id: 'P1', name: 'dispatch demo' });
    for (const task of sampleTaskGraph('P1')) rt.addTask(task);

    // ── DB-001: full happy path ──────────────────────────────────────────
    const dbBefore = rt.getEvents({ taskId: 'DB-001' }).length;
    const dbSteps = driveToDone(rt, 'DB-001');

    assert.equal(rt.getTask('DB-001').state, 'DONE');
    assert.equal(dbSteps.length, 7, 'BACKLOG→DONE is seven transitions');

    const dbEvents = rt.getEvents({ taskId: 'DB-001' });
    assert.equal(
      dbEvents.length - dbBefore,
      dbSteps.length,
      'every accepted transition must write exactly one events row',
    );

    const transitions = dbEvents.filter((e) => e.action.includes('→'));
    assert.deepEqual(
      transitions.map((e) => e.action),
      dbSteps.map((r) => `${r.from}→${r.to}`),
      'each transition records its from→to in the events action',
    );
    assert.deepEqual(
      transitions.map((e) => e.actor),
      ['scheduler', 'scheduler', 'worker-mgr', 'worker-mgr', 'verifier', 'integration-mgr', 'integration-mgr'],
      'each transition is written by the matrix actor',
    );
    for (const row of transitions) assert.equal(row.result, 'ok');

    // ── API-001: dependency is DONE before the dependent is driven ───────
    const apiBefore = rt.getEvents({ taskId: 'API-001' }).length;
    const apiSteps = driveToDone(rt, 'API-001');
    assert.equal(rt.getTask('API-001').state, 'DONE');
    assert.equal(rt.getEvents({ taskId: 'API-001' }).length - apiBefore, apiSteps.length);
    assert.deepEqual(
      rt.getEvents({ taskId: 'API-001' }).filter((e) => e.action.includes('→')).map((e) => e.action),
      apiSteps.map((r) => `${r.from}→${r.to}`),
    );

    // ── whole-DB integrity ───────────────────────────────────────────────
    assert.equal(rt.assertIntegrity(), 'ok');
    assert.equal(rt.state.assertAppendOnly(), true, 'events table is append-only');

    // ── negative control 1: terminal state rejects and writes no event ───
    const beforeIllegal = rt.getEvents({ taskId: 'DB-001' }).length;
    const illegal = rt.transition('DB-001', 'READY', 'scheduler', { depStates: {} });
    assert.equal(illegal.ok, false);
    assert.equal(illegal.error, 'INVALID_TRANSITION');
    assert.match(illegal.reason, /terminal/);
    assert.equal(
      rt.getEvents({ taskId: 'DB-001' }).length,
      beforeIllegal,
      'a rejected transition must not write an events row',
    );

    // ── negative control 2: wrong actor for a legal pair ─────────────────
    rt.addTask({ id: 'X-1', project_id: 'P1', title: 'extra', risk_class: 'R1' });
    const wrongActor = rt.transition('X-1', 'READY', 'verifier', { depStates: {} });
    assert.equal(wrongActor.ok, false);
    assert.equal(wrongActor.error, 'INVALID_TRANSITION');
    assert.match(wrongActor.reason, /actor verifier may not perform/);
  } finally {
    rt.close();
    cleanup(root);
  }
});
