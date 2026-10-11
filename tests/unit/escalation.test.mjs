/**
 * tests/unit/escalation.test.mjs — escalation & budget interplay (spec v3 B.6, B.7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const esc = await core.escalation();

test('decision blocks carry options, a recommendation and a rationale (spec §45)', () => {
  const block = esc.buildDecisionBlock({
    id: 'E1', trigger: 'ambiguous_architecture', question: 'Which approach?',
    options: [{ id: 'a', label: 'monolith' }, { id: 'b', label: 'services', effect: 'ops burden' }],
    recommendation: 'a', rationale: 'smaller team', taskId: 'T1', evidence: { adrs: ['ADR-1', 'ADR-2'] },
  });
  assert.equal(block.trigger, 'ambiguous_architecture');
  assert.equal(block.options.length, 2);
  assert.equal(block.recommendation, 'a');
  assert.equal(block.evidence.adrs.length, 2);
  assert.throws(() => esc.buildDecisionBlock({ id: 'E2', trigger: 'not-a-trigger', question: 'x' }), /unknown escalation trigger/);
});

test('all documented escalation triggers are recognised', () => {
  for (const t of esc.ESCALATION_TRIGGERS) {
    assert.doesNotThrow(() => esc.buildDecisionBlock({ id: 'x', trigger: t, question: 'q' }));
  }
});

test('approval outcomes are fail-closed', () => {
  assert.deepEqual(esc.normalizeApprovalOutcome('allowed-once'), { allowed: true, resolution: 'approved' });
  assert.equal(esc.normalizeApprovalOutcome('rejected').allowed, false);
  assert.equal(esc.normalizeApprovalOutcome('unavailable').failClosed, true);
  assert.equal(esc.normalizeApprovalOutcome('garbage').failClosed, true);
});

test('a headless deployment cannot unblock itself (C.2/L.5)', () => {
  const block = esc.buildDecisionBlock({ id: 'E1', trigger: 'budget_exhausted', question: 'raise the budget?' });
  const headless = esc.planEscalation(block, { mode: 'headless' });
  assert.equal(headless.deliver, false);
  assert.equal(headless.state, 'BLOCKED');
  assert.match(headless.reason, /fail-closed/);
  const interactive = esc.planEscalation(block, { mode: 'interactive' });
  assert.equal(interactive.deliver, true);
  assert.match(interactive.roundPrompt, /E1/);
});

test('escalation level rises with repeated failure', () => {
  assert.equal(esc.escalationLevel([]), 'CHEAP');
  assert.equal(esc.escalationLevel([{ status: 'failed' }, { status: 'failed' }]), 'BASE');
  assert.equal(esc.escalationLevel([{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }]), 'ELEVATED');
  assert.equal(esc.advanceLevel('ELEVATED', true), 'ARCHITECTURE_REVIEW');
  assert.equal(esc.advanceLevel('ELEVATED', false), 'ELEVATED');
});

test('applyResolution unblocks only on approval', () => {
  assert.equal(esc.applyResolution({ resolution: 'approved' }).taskTo, 'READY');
  assert.equal(esc.applyResolution({ resolution: 'rejected' }).taskTo, 'BLOCKED');
  assert.throws(() => esc.applyResolution({ resolution: 'nonsense' }), /invalid resolution/);
});
