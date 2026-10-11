/**
 * tests/adversarial/authority-spoofing.test.mjs — L6 threat T12 / "approval
 * spoofing": a model tool tries to grant itself authority (spec v3 C.4, L.1
 * rules 1/4, K.7).
 *
 * Tools are PROPOSE-ONLY. `sdlc_approve_transition` and `sdlc_dispatch_task`
 * return AUTHORITY_DENIED / INVALID_TRANSITION, and the transition service
 * rejects an illegal proposal with INVALID_TRANSITION plus the current row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, cleanup, core } from '../lib/helpers.mjs';

const tools = await core.tools();
const { TaskStateService } = await core.stateMachine();
const { TOOL_DEFS, AUTHORITY_COMMANDS } = tools;

test('model-facing authority tools are proposals and return an explicit denial', () => {
  const dir = tempDir('sdlc-authority-');
  try {
    const handlers = tools.createHandlers({ worktreePath: dir, runMeta: { runId: 'R1', taskId: 'T1', attempt: 0, nonce: 'N' } });

    const approve = handlers.sdlc_approve_transition({ task_id: 'T1', to: 'ACCEPTED', reason: 'looks good to me' });
    assert.equal(approve.ok, false);
    assert.match(approve.error, /AUTHORITY_DENIED/);

    const dispatch = handlers.sdlc_dispatch_task({ task_id: 'T1', note: 'do it now' });
    assert.equal(dispatch.ok, false);
    assert.match(dispatch.error, /INVALID_TRANSITION/);

    // Every tool that touches authority is declared as `propose`, never `grant`.
    assert.equal(TOOL_DEFS.sdlc_approve_transition.authority, 'propose');
    assert.equal(TOOL_DEFS.sdlc_dispatch_task.authority, 'propose');
    assert.ok(AUTHORITY_COMMANDS.includes('approve'));
    assert.ok(AUTHORITY_COMMANDS.includes('reject'));
    assert.ok(!tools.WORKER_TOOLS.includes('sdlc_approve_transition'));

    // The proposal handlers do not mutate anything — there is no DB access.
    assert.equal(typeof handlers._state.reported, 'object');
  } finally {
    cleanup(dir);
  }
});

test('the transition service rejects an illegal proposer with INVALID_TRANSITION and the current row', () => {
  const svc = new TaskStateService(':memory:');
  try {
    svc._setState('T1', 'VERIFYING', { attempt: 0, retry_budget: 2 });

    // A model actor is not an allowed actor for VERIFYING → ACCEPTED.
    const spoof = svc.transition('T1', 'ACCEPTED', 'model-tool', { gatesPass: true });
    assert.equal(spoof.ok, false);
    assert.equal(spoof.error, 'INVALID_TRANSITION');
    assert.match(spoof.reason, /actor model-tool may not perform VERIFYING→ACCEPTED/);
    assert.equal(spoof.row.state, 'VERIFYING', 'the current row is returned with the rejection');
    assert.equal(svc.getState('T1'), 'VERIFYING', 'the spoofed transition did not apply');

    // Even the verifier actor needs the evidence guard.
    const noEvidence = svc.transition('T1', 'ACCEPTED', 'verifier', { gatesPass: false });
    assert.equal(noEvidence.ok, false);
    assert.equal(noEvidence.error, 'INVALID_TRANSITION');
    assert.match(noEvidence.reason, /guard gatesPass rejected/);
    assert.equal(svc.getState('T1'), 'VERIFYING');

    // The genuine path still works.
    const legal = svc.transition('T1', 'ACCEPTED', 'verifier', { gatesPass: true });
    assert.equal(legal.ok, true);
    assert.equal(svc.getState('T1'), 'ACCEPTED');
    assert.equal(svc.getEvents('T1').length, 1);
  } finally {
    svc.close();
  }
});

test('no model tool can perform a transition the matrix does not allow', () => {
  const svc = new TaskStateService(':memory:');
  try {
    svc._setState('T1', 'BACKLOG');
    // Dispatch is owned by the scheduler; a tool actor is rejected and the row
    // is reported unchanged.
    const res = svc.transition('T1', 'READY', 'model-tool', { depStates: {} });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'INVALID_TRANSITION');
    assert.match(res.reason, /actor model-tool may not perform/);
    assert.equal(res.row.state, 'BACKLOG');

    // A truly unknown target is rejected before any row lookup.
    const bogus = svc.transition('T1', 'GRANTED', 'model-tool', {});
    assert.equal(bogus.ok, false);
    assert.equal(bogus.error, 'INVALID_TRANSITION');
    assert.match(bogus.reason, /unknown target state/);
  } finally {
    svc.close();
  }
});
