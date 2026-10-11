/**
 * tests/lib/transition-fixtures.mjs — the B.2.1 matrix expressed as data.
 *
 * Used by scripts/validate-m1.mjs and the unit suite so the "transitions match
 * the documented matrix" claim is asserted against ONE authoritative fixture
 * rather than re-typed expectations.
 */

export const LEGAL = [
  [null, 'BACKLOG', 'planner', {}],
  ['BACKLOG', 'READY', 'scheduler', { depStates: { DEP: 'DONE' } }],
  ['BACKLOG', 'BLOCKED', 'scheduler', { depStates: { DEP: 'FAILED' } }],
  ['READY', 'ASSIGNED', 'scheduler', { available: true }],
  ['READY', 'BLOCKED', 'scheduler', { depStates: { DEP: 'FAILED' } }],
  ['ASSIGNED', 'IN_PROGRESS', 'worker-mgr', {}],
  ['ASSIGNED', 'READY', 'worker-mgr', { launchFailed: true }],
  ['IN_PROGRESS', 'VERIFYING', 'worker-mgr', {}],
  ['IN_PROGRESS', 'FAILED', 'worker-mgr', { hardFailure: true }],
  ['IN_PROGRESS', 'ESCALATED', 'loop-detector', { loopMatched: true }],
  ['VERIFYING', 'ACCEPTED', 'verifier', { gatesPass: true }],
  ['VERIFYING', 'FAILED', 'verifier', { gatesPass: false }],
  ['VERIFYING', 'ESCALATED', 'verifier', { loopMatched: true }],
  ['ACCEPTED', 'MERGING', 'integration-mgr', { mergeSlotFree: true }],
  ['MERGING', 'DONE', 'integration-mgr', { merged: true, postMergeGatesPass: true }],
  ['MERGING', 'FAILED', 'integration-mgr', { mergeConflict: true }],
  ['FAILED', 'READY', 'scheduler', { attempt: 1, retryBudget: 3 }],
  ['FAILED', 'ESCALATED', 'scheduler', { attempt: 3, retryBudget: 3 }],
  ['ESCALATED', 'READY', 'escalation-mgr', { correctivePlanApproved: true }],
  ['ESCALATED', 'BLOCKED', 'escalation-mgr', { userDecisionRequired: true }],
  ['BLOCKED', 'BACKLOG', 'escalation-mgr', { blockerResolved: true }],
  ['BACKLOG', 'CANCELLED', 'human', {}],
  ['READY', 'CANCELLED', 'planner', {}],
  ['ASSIGNED', 'CANCELLED', 'human', {}],
  ['FAILED', 'CANCELLED', 'human', {}],
  ['BLOCKED', 'CANCELLED', 'human', {}],
  ['ESCALATED', 'CANCELLED', 'human', {}],
  ['IN_PROGRESS', 'CANCELLED', 'human', { workerStopped: true }],
  ['VERIFYING', 'CANCELLED', 'human', { workerStopped: true }],
  ['BACKLOG', 'ESCALATED', 'recovery', {}],
  ['IN_PROGRESS', 'ESCALATED', 'recovery', {}],
];

export const ILLEGAL = [
  ['DONE', 'BACKLOG', 'planner'],
  ['DONE', 'READY', 'scheduler'],
  ['DONE', 'ESCALATED', 'recovery'],
  ['CANCELLED', 'READY', 'scheduler'],
  ['CANCELLED', 'ESCALATED', 'recovery'],
  ['MERGING', 'CANCELLED', 'human'],
  ['BACKLOG', 'DONE', 'planner'],
  ['BACKLOG', 'IN_PROGRESS', 'worker-mgr'],
  ['ASSIGNED', 'DONE', 'worker-mgr'],
  ['READY', 'DONE', 'scheduler'],
  ['VERIFYING', 'DONE', 'verifier'],
  ['ACCEPTED', 'DONE', 'integration-mgr'],
  ['FAILED', 'DONE', 'scheduler'],
  ['ESCALATED', 'DONE', 'escalation-mgr'],
  ['BLOCKED', 'DONE', 'escalation-mgr'],
  ['IN_PROGRESS', 'BLOCKED', 'worker-mgr'],
  ['ACCEPTED', 'READY', 'integration-mgr'],
  ['MERGING', 'ACCEPTED', 'integration-mgr'],
  // Right pair, wrong actor:
  ['BACKLOG', 'READY', 'human'],
  ['READY', 'ASSIGNED', 'verifier'],
  ['VERIFYING', 'ACCEPTED', 'worker-mgr'],
];

export function documentedTransitions() {
  return { legal: LEGAL, illegal: ILLEGAL };
}

export default { LEGAL, ILLEGAL, documentedTransitions };
