/**
 * tests/integration/escalation-authority.test.mjs — decisions are persisted and
 * composable with the state machine.
 *
 * The `escalations` table used to have no writer, and `applyResolution` never
 * produced `correctivePlanApproved`, so ESCALATED→READY could not be driven by
 * an actual user decision. Approval now needs an explicit corrective plan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const { Runtime } = await core.runtime();
const esc = await core.escalation();

function fixture() {
  const root = tempDir('sdlc-escalation-');
  const rt = new Runtime({
    projectRoot: root,
    config: { storage: { dbPath: '.sdlc/sdlc.db', requireQuickCheckOnOpen: false }, safety: { instanceLock: false } },
  });
  rt.open();
  rt.createProject({ id: 'P1', name: 'esc' });
  rt.addTask({ id: 'T1', project_id: 'P1', title: 'blocked', role: 'backend-engineer' });
  rt.state._setState('T1', 'ESCALATED');
  return { root, rt };
}

function block(id) {
  return esc.buildDecisionBlock({
    id, trigger: 'budget_exhausted', question: 'raise the budget?',
    taskId: 'T1', projectId: 'P1', recommendation: 'raise once',
  });
}

test('a recorded escalation round-trips and a headless plan cannot unblock it', () => {
  const { root, rt } = fixture();
  try {
    rt.recordEscalation({ id: 'E1', taskId: 'T1', attempt: 0, level: 'BASE', packet: block('E1') });
    const rows = rt.getEscalations({ taskId: 'T1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].packet.trigger, 'budget_exhausted');
    const plan = esc.planEscalation(rows[0].packet, { mode: 'headless' });
    assert.equal(plan.deliver, false);
    assert.equal(rt.getTask('T1').state, 'ESCALATED');
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('approval without a corrective plan does not unblock; rejection blocks', () => {
  const { root, rt } = fixture();
  try {
    rt.recordEscalation({ id: 'E1', taskId: 'T1', attempt: 0, level: 'BASE', packet: block('E1') });
    const bare = rt.resolveEscalation('E1', { resolution: 'approved', decidedBy: 'human' });
    assert.equal(bare.correctivePlanApproved, false);
    assert.equal(bare.transition, null);
    assert.equal(rt.getTask('T1').state, 'ESCALATED');

    rt.state._setState('T1', 'ESCALATED');
    rt.recordEscalation({ id: 'E2', taskId: 'T1', attempt: 1, level: 'BASE', packet: block('E2') });
    const rejected = rt.resolveEscalation('E2', { resolution: 'rejected', decidedBy: 'human' });
    assert.equal(rejected.taskTo, 'BLOCKED');
    assert.equal(rejected.transition.ok, true, JSON.stringify(rejected.transition));
    assert.equal(rt.getTask('T1').state, 'BLOCKED');
    assert.equal(rt.getEscalation('E2').resolution, 'rejected');
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('approved + corrective plan yields exactly one ESCALATED→READY transition', () => {
  const { root, rt } = fixture();
  try {
    rt.recordEscalation({ id: 'E1', taskId: 'T1', attempt: 0, level: 'BASE', packet: block('E1') });
    const before = rt.getEvents({ taskId: 'T1' }).length;
    const result = rt.resolveEscalation('E1', {
      resolution: 'approved', decidedBy: 'human', correctivePlan: { steps: ['raise budget'] },
    });
    assert.equal(result.correctivePlanApproved, true);
    assert.equal(result.transition.ok, true, JSON.stringify(result.transition));
    assert.equal(rt.getTask('T1').state, 'READY');
    const after = rt.getEvents({ taskId: 'T1' });
    assert.equal(after.length - before, 2, 'one resolution audit event + one state transition');
    assert.ok(after.some((e) => /escalation-resolved/.test(e.action)));
    assert.ok(after.some((e) => /ESCALATED→READY/.test(e.action)));
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('resolving an unknown escalation throws (no invented authority)', () => {
  const { root, rt } = fixture();
  try {
    assert.throws(() => rt.resolveEscalation('NOPE', { resolution: 'approved' }), /unknown escalation/);
  } finally {
    rt.close();
    cleanup(root);
  }
});
