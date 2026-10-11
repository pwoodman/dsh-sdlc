/**
 * packages/sdlc-core/src/state-machine.js — task/project state machines (spec v3 B.2).
 *
 * L.1 rule 1: the RUNTIME owns state. Model-facing tools submit proposals; only
 * this service performs transitions. An illegal proposal returns
 * `INVALID_TRANSITION` with the current row, and every accepted transition
 * writes exactly one `events` row (property-tested in tests/unit).
 *
 * All mutations go through one serialized write queue, so no in-process
 * interleaving is possible (B.2.3 single-writer invariant).
 */

import { DatabaseSync } from 'node:sqlite';
import { migrate } from './schema.js';

export const TERMINAL_STATES = ['DONE', 'CANCELLED'];
export const TASK_STATES = [
  'BACKLOG', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'VERIFYING',
  'ACCEPTED', 'MERGING', 'DONE', 'FAILED', 'ESCALATED', 'BLOCKED', 'CANCELLED',
];

const DEP_FAILED_STATES = ['FAILED', 'BLOCKED', 'ESCALATED', 'CANCELLED'];

/** Guard helpers: the service enforces what it is TOLD, never invented facts. */
const G = {
  anyDependencyNotDone: (ctx = {}) => {
    const states = ctx.depStates;
    if (!states) return false; // no dependency information supplied ⇒ nothing to enforce
    return (ctx.deps ?? Object.keys(states)).some((d) => (states[d] ?? 'BACKLOG') !== 'DONE');
  },
  dependencyRegressed: (ctx = {}) => {
    const states = ctx.depStates;
    if (!states) return false;
    return (ctx.deps ?? Object.keys(states)).some((d) => DEP_FAILED_STATES.includes(states[d]));
  },
  locksUnavailable: (ctx = {}) => ctx.available === false || ctx.locksGrantable === false,
  locksHeldBeyondBudget: (ctx = {}) => ctx.waitBudgetExceeded === true,
  launchFailed: (ctx = {}) => ctx.launchFailed === true,
  hardFailure: (ctx = {}) => ctx.hardFailure === true,
  gatesFailed: (ctx = {}) => ctx.gatesPass === false,
  gatesPass: (ctx = {}) => ctx.gatesPass !== false,
  loopMatched: (ctx = {}) => ctx.loopMatched === true,
  mergeSlotFree: (ctx = {}) => ctx.mergeSlotFree !== false,
  mergedAndGreen: (ctx = {}) => ctx.merged === true && ctx.postMergeGatesPass !== false,
  conflictOrGateFailure: (ctx = {}) => ctx.mergeConflict === true || ctx.postMergeGatesPass === false,
  retryBudgetRemaining: (ctx = {}) => (ctx.attempt ?? 0) < (ctx.retryBudget ?? 0),
  retryBudgetExhausted: (ctx = {}) => (ctx.attempt ?? 0) >= (ctx.retryBudget ?? 0),
  planApproved: (ctx = {}) => ctx.correctivePlanApproved === true,
  userDecisionRequired: (ctx = {}) => ctx.userDecisionRequired !== false,
  blockerResolved: (ctx = {}) => ctx.blockerResolved === true,
  workerStopped: (ctx = {}) => ctx.workerStopped !== false,
  always: () => true,
};

/**
 * The B.2.1 transition matrix, one row per legal transition.
 * `from: '*'` is the recovery wildcard ("any non-terminal → ESCALATED").
 */
export const TASK_TRANSITIONS = [
  { from: null, to: 'BACKLOG', actors: ['planner'], guard: 'always', note: 'task created' },
  { from: '*', to: 'ESCALATED', actors: ['recovery'], guard: 'always', note: 'reconciliation discrepancy' },

  { from: 'BACKLOG', to: 'READY', actors: ['scheduler'], guard: 'allDepsDone', note: 'all deps DONE' },
  { from: 'BACKLOG', to: 'BLOCKED', actors: ['scheduler'], guard: 'anyDepFailed', note: 'dependency failed' },

  { from: 'READY', to: 'ASSIGNED', actors: ['scheduler'], guard: 'locksGrantable', note: 'locks grantable' },
  { from: 'READY', to: 'BLOCKED', actors: ['scheduler'], guard: 'locksHeldOrDepRegressed', note: 'wait budget / regression' },

  { from: 'ASSIGNED', to: 'IN_PROGRESS', actors: ['worker-mgr'], guard: 'always', note: 'first worker event' },
  { from: 'ASSIGNED', to: 'READY', actors: ['worker-mgr'], guard: 'launchFailed', note: 'retryable launch failure' },

  { from: 'IN_PROGRESS', to: 'VERIFYING', actors: ['worker-mgr'], guard: 'always', note: 'WorkerResult received' },
  { from: 'IN_PROGRESS', to: 'FAILED', actors: ['worker-mgr', 'recovery'], guard: 'hardFailure', note: 'timeout/crash/error or orphan salvage (B.12)' },
  { from: 'IN_PROGRESS', to: 'ESCALATED', actors: ['loop-detector'], guard: 'loopMatched', note: 'loop fingerprint' },

  { from: 'VERIFYING', to: 'ACCEPTED', actors: ['verifier'], guard: 'gatesPass', note: 'gates + review' },
  { from: 'VERIFYING', to: 'FAILED', actors: ['verifier'], guard: 'gatesFailed', note: 'gate failure' },
  { from: 'VERIFYING', to: 'ESCALATED', actors: ['verifier'], guard: 'loopMatched', note: 'loop fingerprint' },
  // EXTENSION (documented, D4): B.2.1 has no VERIFYING→BLOCKED row, but L.5
  // requires "R3+ tasks touching UI are BLOCKED, not auto-accepted" when the
  // visual/e2e gate was skipped. Without this row that policy has no
  // persistable state, so a skipped gate could only be modelled as FAILED.
  { from: 'VERIFYING', to: 'BLOCKED', actors: ['verifier'], guard: 'skippedGateBlocks', note: 'required gate skipped (L.5)' },

  { from: 'ACCEPTED', to: 'MERGING', actors: ['integration-mgr'], guard: 'mergeSlotFree', note: 'single writer' },
  { from: 'MERGING', to: 'DONE', actors: ['integration-mgr'], guard: 'mergedAndGreen', note: 'post-merge gates green' },
  { from: 'MERGING', to: 'FAILED', actors: ['integration-mgr'], guard: 'conflictOrGateFailure', note: 'conflict / revert' },

  { from: 'FAILED', to: 'READY', actors: ['scheduler'], guard: 'retryBudgetRemaining', note: 'retry with context' },
  { from: 'FAILED', to: 'ESCALATED', actors: ['scheduler'], guard: 'retryBudgetExhausted', note: 'budget exhausted' },

  { from: 'ESCALATED', to: 'READY', actors: ['escalation-mgr'], guard: 'planApproved', note: 'corrective plan approved' },
  { from: 'ESCALATED', to: 'BLOCKED', actors: ['escalation-mgr'], guard: 'userDecisionRequired', note: 'user decision' },
  { from: 'BLOCKED', to: 'BACKLOG', actors: ['escalation-mgr'], guard: 'blockerResolved', note: 'blocker resolved' },

  { from: 'BACKLOG', to: 'CANCELLED', actors: ['human', 'planner'], guard: 'always', note: 'scope cut / stop' },
  { from: 'READY', to: 'CANCELLED', actors: ['human', 'planner'], guard: 'always', note: 'scope cut / stop' },
  { from: 'ASSIGNED', to: 'CANCELLED', actors: ['human'], guard: 'always', note: 'no live worker' },
  { from: 'FAILED', to: 'CANCELLED', actors: ['human'], guard: 'always', note: 'stop' },
  { from: 'BLOCKED', to: 'CANCELLED', actors: ['human'], guard: 'always', note: 'stop' },
  { from: 'ESCALATED', to: 'CANCELLED', actors: ['human'], guard: 'always', note: 'stop' },
  { from: 'IN_PROGRESS', to: 'CANCELLED', actors: ['human'], guard: 'workerStopped', note: 'stop' },
  { from: 'VERIFYING', to: 'CANCELLED', actors: ['human'], guard: 'workerStopped', note: 'stop' },
  // MERGING is deliberately absent: a human stop during merge waits for the
  // merge to settle into DONE or FAILED (B.2.1).
];

/** Named guard predicates, keyed by the `guard` string used in the matrix. */
export const GUARDS = {
  always: G.always,
  allDepsDone: (ctx) => !G.anyDependencyNotDone(ctx),
  anyDepFailed: (ctx) => {
    const states = ctx?.depStates;
    if (!states) return true; // no dependency info ⇒ the scheduler asserted a failure
    return (ctx.deps ?? Object.keys(states)).some((d) => DEP_FAILED_STATES.includes(states[d]));
  },
  locksGrantable: (ctx) => !G.locksUnavailable(ctx),
  locksHeldOrDepRegressed: (ctx) => G.locksHeldBeyondBudget(ctx) || G.dependencyRegressed(ctx),
  launchFailed: G.launchFailed,
  hardFailure: G.hardFailure,
  loopMatched: G.loopMatched,
  gatesPass: G.gatesPass,
  gatesFailed: G.gatesFailed,
  skippedGateBlocks: (ctx) => ctx?.blockedBySkippedGate === true,
  mergeSlotFree: G.mergeSlotFree,
  mergedAndGreen: G.mergedAndGreen,
  conflictOrGateFailure: G.conflictOrGateFailure,
  retryBudgetRemaining: G.retryBudgetRemaining,
  retryBudgetExhausted: G.retryBudgetExhausted,
  planApproved: G.planApproved,
  userDecisionRequired: G.userDecisionRequired,
  blockerResolved: G.blockerResolved,
  workerStopped: G.workerStopped,
};

export function legalTargets(from) {
  if (from === null || from === undefined) return TASK_TRANSITIONS.filter((t) => t.from === null).map((t) => t.to);
  if (TERMINAL_STATES.includes(from)) return [];
  const rows = TASK_TRANSITIONS.filter((t) => t.from === from || t.from === '*');
  return [...new Set(rows.map((t) => t.to))];
}

/** Look up the matrix row for (from, to, actor); null when no row matches. */
export function findTransition(from, to, actor) {
  // Terminal states accept nothing (B.2.1), so the recovery wildcard — which is
  // "any NON-TERMINAL state → ESCALATED" — must not match them either.
  if (from !== null && from !== undefined && TERMINAL_STATES.includes(from)) return null;
  const candidates = TASK_TRANSITIONS.filter(
    (t) => t.to === to && (t.from === from || (t.from === '*' && from !== null)),
  );
  if (candidates.length === 0) return null;
  return candidates.find((t) => t.actors.includes(actor)) ?? null;
}

export function isLegalTransition(from, to, actor) {
  return findTransition(from, to, actor) !== null;
}

export class TaskStateService {
  /**
   * @param {string|import('node:sqlite').DatabaseSync} dbPathOrDb
   *   `':memory:'` (used by tests) or an existing DatabaseSync.
   */
  constructor(dbPathOrDb = ':memory:', { now = () => new Date().toISOString() } = {}) {
    this.owned = typeof dbPathOrDb === 'string';
    this.db = this.owned ? new DatabaseSync(dbPathOrDb) : dbPathOrDb;
    if (this.owned) migrate(this.db);
    this.now = now;
    this._queue = Promise.resolve();
  }

  /**
   * Serialized write queue (B.2.3). Every mutation also runs inside
   * `BEGIN IMMEDIATE … COMMIT`; because `node:sqlite` statements are
   * synchronous, two in-process writers cannot interleave, and the queue
   * provides ordering for async callers.
   */
  enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Run `fn` inside one IMMEDIATE transaction (atomicity + durability). */
  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  close() {
    if (this.owned) this.db.close();
  }

  _taskRow(id) {
    return this.db
      .prepare('SELECT id, state, attempt, retry_budget, project_id FROM tasks WHERE id = ?')
      .get(id) ?? null;
  }

  getState(id) {
    return this._taskRow(id)?.state ?? null;
  }

  getTask(id) {
    return this._taskRow(id);
  }

  getEvents(taskId) {
    return this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(taskId);
  }

  /** Test/loader helper: place a row in a state without emitting an event. */
  _setState(taskId, state, extra = {}) {
    const existing = this._taskRow(taskId);
    const ts = this.now();
    if (existing) {
      this.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(state, ts, taskId);
    } else {
      this.db
        .prepare(
          `INSERT INTO tasks(id, project_id, title, state, attempt, retry_budget, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, extra.project_id ?? null, extra.title ?? taskId, state, extra.attempt ?? 0, extra.retry_budget ?? 0, ts, ts);
    }
    return this._taskRow(taskId);
  }

  _insertEvent({ taskId, actor, action, result, payload, durationMs }) {
    this.db
      .prepare(
        `INSERT INTO events(ts, project_id, task_id, actor, action, result, duration_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        payload?.project_id ?? null,
        taskId,
        actor,
        action ?? null,
        result ?? 'ok',
        durationMs ?? null,
        payload ? JSON.stringify(payload) : null,
      );
  }

  /**
   * Attempt one transition. Returns `{ ok:true, from, to, row }` on success or
   * `{ ok:false, error:'INVALID_TRANSITION', from, to, actor, row, reason }`.
   */
  transition(taskId, to, actor, ctx = {}) {
    return this._tx(() => {
      const row = this._taskRow(taskId);
      const from = row?.state ?? null;
      const fail = (reason) => ({
        ok: false,
        error: 'INVALID_TRANSITION',
        from,
        to,
        actor,
        reason,
        row,
      });

      if (!TASK_STATES.includes(to)) return fail(`unknown target state ${to}`);
      if (row && TERMINAL_STATES.includes(from)) return fail(`${from} is terminal`);

      const entry = findTransition(from, to, actor);
      if (!entry) {
        const pairLegal = TASK_TRANSITIONS.some((t) => t.to === to && (t.from === from || t.from === '*'));
        return fail(pairLegal ? `actor ${actor} may not perform ${from ?? '—'}→${to}` : `no transition ${from ?? '—'}→${to}`);
      }
      const guard = GUARDS[entry.guard] ?? GUARDS.always;
      if (!guard(ctx)) return fail(`guard ${entry.guard} rejected ${from ?? '—'}→${to}`);

      const attemptDelta = to === 'READY' && (from === 'FAILED' || from === 'ESCALATED') ? 1 : 0;
      const ts = this.now();
      if (from === null) {
        this.db
          .prepare(
            `INSERT INTO tasks(id, project_id, title, state, attempt, retry_budget, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            taskId,
            ctx.project_id ?? null,
            ctx.title ?? taskId,
            to,
            ctx.attempt ?? 0,
            ctx.retry_budget ?? ctx.retryBudget ?? 0,
            ts,
            ts,
          );
      } else {
        this.db
          .prepare(
            `UPDATE tasks SET state = ?, attempt = attempt + ?, waiting_on = ?, updated_at = ? WHERE id = ?`,
          )
          .run(to, attemptDelta, ctx.waiting_on ?? null, ts, taskId);
      }
      this._insertEvent({
        taskId,
        actor,
        action: `${from ?? '—'}→${to}`,
        result: 'ok',
        durationMs: ctx.durationMs,
        payload: { from, to, guard: entry.guard, ...(ctx.payload ?? {}) },
      });
      return { ok: true, from, to, row: this._taskRow(taskId) };
    });
  }

  /** Append-only audit rows for a project-level action (no state change). */
  record({ taskId = null, projectId = null, actor, action, result = 'ok', payload = null, durationMs = null }) {
    return this._tx(() => {
      this._insertEvent({ taskId, actor, action, result, durationMs, payload: { ...(payload ?? {}), project_id: projectId } });
      return { ok: true };
    });
  }

  /** Assert the append-only invariant is actually enforced (negative control). */
  assertAppendOnly() {
    let blocked = false;
    try { this.db.prepare('DELETE FROM events').run(); } catch { blocked = true; }
    if (!blocked) throw new Error('events table is not append-only');
    return true;
  }
}

// ── project state machine (B.2.2) ──────────────────────────────────────────

export const PROJECT_STATES = [
  'DISCOVERY', 'REQUIREMENTS', 'ARCHITECTURE', 'PLANNING', 'IMPLEMENTATION',
  'INTEGRATION', 'VERIFICATION', 'RELEASE', 'MAINTENANCE',
];

export const PROJECT_SEQUENCE = [
  ['DISCOVERY', 'REQUIREMENTS', 'requirements'],
  ['REQUIREMENTS', 'ARCHITECTURE', 'architecture'],
  ['ARCHITECTURE', 'PLANNING', 'plan'],
  ['PLANNING', 'IMPLEMENTATION', 'dag'],
  ['IMPLEMENTATION', 'INTEGRATION', null],
  ['INTEGRATION', 'VERIFICATION', null],
  ['VERIFICATION', 'RELEASE', null],
  ['RELEASE', 'MAINTENANCE', null],
];

/** Project transitions require a persisted artifact for the first three hops. */
export function projectTransition(from, to, { artifacts = {} } = {}) {
  if (to === 'BLOCKED') return { ok: true, blockedState: from };
  if (from === 'BLOCKED') return { ok: true, to };
  const entry = PROJECT_SEQUENCE.find(([f, t]) => f === from && t === to);
  if (!entry) return { ok: false, error: 'INVALID_TRANSITION', from, to };
  const [, , required] = entry;
  if (required && !artifacts[required]) {
    return { ok: false, error: 'MISSING_ARTIFACT', from, to, required };
  }
  return { ok: true, from, to };
}

export default { TaskStateService, TASK_TRANSITIONS, TASK_STATES, TERMINAL_STATES, isLegalTransition, legalTargets, findTransition };
