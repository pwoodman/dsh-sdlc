/**
 * tests/unit/state-machine.test.mjs — exhaustive transition testing (spec v3 B.2.1, G.2.2, K.3).
 *
 * Every cell of the matrix is exercised: legal transitions succeed and write
 * EXACTLY one events row; illegal transitions return INVALID_TRANSITION with
 * the current row and leave state untouched; DONE/CANCELLED accept nothing;
 * MERGING cannot be cancelled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const sm = await core.stateMachine();
const ALL_STATES = sm.TASK_STATES;
const ALL_ACTORS = ['planner', 'scheduler', 'worker-mgr', 'verifier', 'integration-mgr', 'loop-detector', 'escalation-mgr', 'human', 'recovery'];

function fresh(state = null) {
  const svc = new sm.TaskStateService(':memory:');
  if (state) svc._setState('T1', state);
  return svc;
}

/**
 * One TaskStateService per task STATE (12), reused across the whole matrix
 * row-group. The exhaustive test below used to construct a fresh `:memory:`
 * DB per (from, to, actor) cell — 1,296 constructions (~18s of sqlite open +
 * migrate on the slow runner). Reusing one service per `from` state between
 * cells keeps the coverage byte-identical (same transitions, same guards,
 * same event counts) while constructing only 12 DBs.
 *
 * Reset subtlety: `events` is append-only by DATABASE TRIGGER (a DELETE is
 * rejected), so the service cannot be "emptied" — instead each cell uses a
 * FRESH task id and the assertion counts only that id's events. State is
 * re-seeded per cell via `_setState`, which overwrites the row in place.
 */
const perStateSvc = new Map();
let cellSeq = 0;
function svcFor(from) {
  let svc = perStateSvc.get(from);
  if (!svc) {
    svc = new sm.TaskStateService(':memory:');
    perStateSvc.set(from, svc);
  }
  const taskId = `T1/c${cellSeq++}`;
  svc._setState(taskId, from);
  return { svc, taskId };
}

/** Context that satisfies the guard of a specific matrix row. */
const CTX_BY_GUARD = {
  always: {},
  allDepsDone: { depStates: { DEP: 'DONE' } },
  anyDepFailed: { depStates: { DEP: 'FAILED' } },
  locksGrantable: { available: true },
  locksHeldOrDepRegressed: { depStates: { DEP: 'FAILED' } },
  launchFailed: { launchFailed: true },
  hardFailure: { hardFailure: true },
  loopMatched: { loopMatched: true },
  gatesPass: { gatesPass: true },
  gatesFailed: { gatesPass: false },
  skippedGateBlocks: { blockedBySkippedGate: true },
  mergeSlotFree: { mergeSlotFree: true },
  mergedAndGreen: { merged: true, postMergeGatesPass: true },
  conflictOrGateFailure: { mergeConflict: true },
  retryBudgetRemaining: { attempt: 0, retryBudget: 3 },
  retryBudgetExhausted: { attempt: 3, retryBudget: 3 },
  planApproved: { correctivePlanApproved: true },
  userDecisionRequired: { userDecisionRequired: true },
  blockerResolved: { blockerResolved: true },
  workerStopped: { workerStopped: true },
};

function satisfyingCtx(from, to, actor) {
  const row = sm.findTransition(from, to, actor);
  return row ? (CTX_BY_GUARD[row.guard] ?? {}) : {};
}

test('the matrix rows are the only legal transitions (exhaustive over 12 states × 12 states × 9 actors)', () => {
  let checked = 0;
  for (const from of ALL_STATES) {
    // One DB per `from` state, reset between cells (see svcFor): 12
    // constructions instead of 1,296, identical transition coverage.
    for (const to of ALL_STATES) {
      for (const actor of ALL_ACTORS) {
        const row = sm.findTransition(from, to, actor);
        const expected = row !== null;
        const { svc, taskId } = svcFor(from);
        const before = svc.getState(taskId);
        const res = svc.transition(taskId, to, actor, satisfyingCtx(from, to, actor));
        checked += 1;
        if (expected) {
          assert.equal(res.ok, true, `expected legal ${from}→${to} (${actor}): ${res.reason}`);
          assert.equal(svc.getState(taskId), to);
          assert.equal(svc.getEvents(taskId).length, 1, 'exactly one events row per accepted transition');
        } else {
          assert.equal(res.ok, false, `expected illegal ${from}→${to} (${actor})`);
          assert.equal(res.error, 'INVALID_TRANSITION');
          assert.equal(res.row.state, before, 'state unchanged on rejection');
          assert.equal(svc.getEvents(taskId).length, 0, 'no events row on rejection');
        }
      }
    }
  }
  assert.equal(checked, ALL_STATES.length * ALL_STATES.length * ALL_ACTORS.length);
});

test('terminal states accept nothing', () => {
  for (const terminal of sm.TERMINAL_STATES) {
    for (const to of ALL_STATES) {
      const svc = fresh(terminal);
      const res = svc.transition('T1', to, 'human', satisfyingCtx(terminal, to, 'human'));
      assert.equal(res.ok, false, `${terminal}→${to} must be rejected`);
      assert.equal(svc.getState('T1'), terminal);
    }
  }
});

test('ACCEPTED→MERGING enforces a single writer from the database, not a caller flag', () => {
  const svc = fresh('ACCEPTED');
  svc._setState('T2', 'ACCEPTED');
  const first = svc.transition('T1', 'MERGING', 'integration-mgr', {});
  assert.equal(first.ok, true, JSON.stringify(first));
  const blocked = svc.transition('T2', 'MERGING', 'integration-mgr', {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /mergeSlotFree/);
  assert.equal(svc.getState('T2'), 'ACCEPTED');
  // The slot frees when the first merge settles.
  assert.equal(svc.transition('T1', 'DONE', 'integration-mgr', { merged: true }).ok, true);
  assert.equal(svc.transition('T2', 'MERGING', 'integration-mgr', {}).ok, true);
});

test('MERGING cannot be cancelled — a stop waits for the merge to settle', () => {
  const svc = fresh('MERGING');
  const res = svc.transition('T1', 'CANCELLED', 'human', satisfyingCtx('MERGING', 'CANCELLED', 'human'));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'INVALID_TRANSITION');
  assert.equal(svc.getState('T1'), 'MERGING');
});

test('legal example rows from B.2.1', () => {
  const rows = [
    ['BACKLOG', 'READY', 'scheduler', { deps: ['T1'], depStates: { T1: 'DONE' } }],
    ['BACKLOG', 'BLOCKED', 'scheduler', { deps: ['T1'], depStates: { T1: 'FAILED' } }],
    ['READY', 'ASSIGNED', 'scheduler', { locks: ['package.json'], available: true }],
    ['ASSIGNED', 'IN_PROGRESS', 'worker-mgr', {}],
    ['IN_PROGRESS', 'VERIFYING', 'worker-mgr', {}],
    ['VERIFYING', 'ACCEPTED', 'verifier', { gatesPass: true }],
    ['ACCEPTED', 'MERGING', 'integration-mgr', { mergeSlotFree: true }],
    ['MERGING', 'DONE', 'integration-mgr', { merged: true }],
    ['FAILED', 'READY', 'scheduler', { attempt: 1, retryBudget: 3 }],
    ['ESCALATED', 'READY', 'escalation-mgr', { correctivePlanApproved: true }],
    ['BLOCKED', 'BACKLOG', 'escalation-mgr', { blockerResolved: true }],
  ];
  for (const [from, to, actor, ctx] of rows) {
    const svc = fresh(from);
    const res = svc.transition('T1', to, actor, ctx);
    assert.equal(res.ok, true, `${from}→${to} (${actor}) rejected: ${res.reason}`);
    assert.equal(svc.getState('T1'), to);
  }
});

test('VERIFYING→ACCEPTED needs explicit gatesPass:true, not a missing field', () => {
  const svc = fresh('VERIFYING');
  const empty = svc.transition('T1', 'ACCEPTED', 'verifier', {});
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /gatesPass/);
  assert.equal(svc.getState('T1'), 'VERIFYING');
  assert.equal(svc.transition('T1', 'ACCEPTED', 'verifier', { gatesPass: true }).ok, true);
});

test('guards are enforced, not decorative', () => {
  // Dependency not DONE ⇒ BACKLOG→READY must be rejected.
  const a = fresh('BACKLOG');
  assert.equal(a.transition('T1', 'READY', 'scheduler', { deps: ['T0'], depStates: { T0: 'IN_PROGRESS' } }).ok, false);
  // Locks unavailable ⇒ READY→ASSIGNED rejected.
  const b = fresh('READY');
  assert.equal(b.transition('T1', 'ASSIGNED', 'scheduler', { available: false }).ok, false);
  // Gates failed ⇒ VERIFYING→ACCEPTED rejected.
  const c = fresh('VERIFYING');
  assert.equal(c.transition('T1', 'ACCEPTED', 'verifier', { gatesPass: false }).ok, false);
  // Retry budget exhausted ⇒ FAILED→READY rejected.
  const d = fresh('FAILED');
  assert.equal(d.transition('T1', 'READY', 'scheduler', { attempt: 3, retryBudget: 3 }).ok, false);
  // Worktree recreated without corrective plan approval ⇒ ESCALATED→READY rejected.
  const e = fresh('ESCALATED');
  assert.equal(e.transition('T1', 'READY', 'escalation-mgr', { correctivePlanApproved: false }).ok, false);
});

test('wrong actor for a legal pair is rejected', () => {
  const svc = fresh('BACKLOG');
  const res = svc.transition('T1', 'READY', 'human', satisfyingCtx('BACKLOG', 'READY', 'human'));
  assert.equal(res.ok, false);
  assert.match(res.reason, /actor human may not perform/);
});

test('isLegalTransition wires the guard table (C16 iv): row + failing guard is illegal', async () => {
  const { isLegalTransition, findTransition } = await core.stateMachine();
  // Row exists but the guard rejects: VERIFYING→ACCEPTED with gatesPass:false.
  assert.ok(findTransition('VERIFYING', 'ACCEPTED', 'verifier'), 'row must exist for the test to mean anything');
  assert.equal(isLegalTransition('VERIFYING', 'ACCEPTED', 'verifier', { gatesPass: false }), false);
  assert.equal(isLegalTransition('VERIFYING', 'ACCEPTED', 'verifier', { gatesPass: true }), true);
  // Guard-throwing ctx fails closed, never throws.
  assert.equal(isLegalTransition('VERIFYING', 'ACCEPTED', 'verifier', null), false);
  // No row at all stays illegal regardless of ctx.
  assert.equal(isLegalTransition('BACKLOG', 'DONE', 'planner', {}), false);
});

test('retry increments attempt; recovery wildcard escalates any non-terminal state', () => {
  const svc = fresh('FAILED');
  svc.transition('T1', 'READY', 'scheduler', { attempt: 0, retryBudget: 3 });
  assert.equal(svc.getTask('T1').attempt, 1);
  for (const state of ['BACKLOG', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'VERIFYING', 'ACCEPTED', 'MERGING', 'FAILED', 'BLOCKED', 'ESCALATED']) {
    const s = fresh(state);
    const res = s.transition('T1', 'ESCALATED', 'recovery', {});
    assert.equal(res.ok, true, `recovery wildcard must escalate ${state}`);
  }
});

test('events are append-only at the DB level (negative control)', () => {
  const svc = fresh('BACKLOG');
  svc.transition('T1', 'READY', 'scheduler', satisfyingCtx('BACKLOG', 'READY', 'scheduler'));
  assert.equal(svc.assertAppendOnly(), true);
  assert.throws(() => svc.db.prepare('DELETE FROM events').run(), /append-only/);
  assert.throws(() => svc.db.prepare("UPDATE events SET actor='x'").run(), /append-only/);
});

test('event payload records from/to/guard for audit', () => {
  const svc = fresh('BACKLOG');
  svc.transition('T1', 'READY', 'scheduler', satisfyingCtx('BACKLOG', 'READY', 'scheduler'));
  const [event] = svc.getEvents('T1');
  assert.equal(event.actor, 'scheduler');
  assert.equal(event.action, 'BACKLOG→READY');
  assert.equal(JSON.parse(event.payload_json).guard, 'allDepsDone');
});

test('project state machine requires artifacts for the first three hops', () => {
  assert.equal(sm.projectTransition('DISCOVERY', 'REQUIREMENTS').ok, false);
  assert.equal(sm.projectTransition('DISCOVERY', 'REQUIREMENTS', { artifacts: { requirements: 'doc' } }).ok, true);
  assert.equal(sm.projectTransition('REQUIREMENTS', 'ARCHITECTURE', { artifacts: { requirements: 'doc' } }).ok, false);
  assert.equal(sm.projectTransition('REQUIREMENTS', 'ARCHITECTURE', { artifacts: { architecture: 'adr' } }).ok, true);
  assert.equal(sm.projectTransition('PLANNING', 'IMPLEMENTATION').ok, false);
  assert.equal(sm.projectTransition('PLANNING', 'IMPLEMENTATION', { artifacts: { dag: {} } }).ok, true);
  assert.equal(sm.projectTransition('MAINTENANCE', 'DISCOVERY').ok, false);
  assert.equal(sm.projectTransition('IMPLEMENTATION', 'BLOCKED').blockedState, 'IMPLEMENTATION');
  assert.equal(sm.projectTransition('BLOCKED', 'IMPLEMENTATION').ok, true);
});
