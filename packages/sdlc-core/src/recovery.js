/**
 * packages/sdlc-core/src/recovery.js — orphan salvage & reconciliation (spec v3 B.12).
 *
 * `events` is append-only and authoritative. `sdlc resume` performs
 * reconciliation: nothing is invented, and anything ambiguous becomes an
 * ESCALATED task with the discrepancy recorded as evidence.
 */

export const ORPHAN_STATES = ['ASSIGNED', 'IN_PROGRESS', 'VERIFYING'];

/**
 * Every worktree not owned by a live `worker_runs` row is an orphan.
 * @param {object} input
 * @param {Array} input.runs          worker_runs rows
 * @param {(pid:number)=>boolean} input.isAlive
 * @param {(path:string)=>boolean} [input.worktreeExists]
 */
export function findOrphans({ runs = [], isAlive = () => false, worktreeExists = () => true } = {}) {
  const orphans = [];
  for (const run of runs) {
    const finished = run.finished_at != null || run.status === 'completed' || run.status === 'failed';
    if (finished) continue;
    const alive = run.pid != null && isAlive(run.pid);
    if (alive) continue;
    orphans.push({
      runId: run.id,
      taskId: run.task_id,
      attempt: run.attempt,
      pid: run.pid ?? null,
      worktreePath: run.worktree_path ?? null,
      worktreeMissing: run.worktree_path ? !worktreeExists(run.worktree_path) : false,
      reason: run.pid == null ? 'no-pid' : 'dead-pid',
    });
  }
  return orphans;
}

/**
 * Mark a worker run as orphaned. The UPDATE is conditional on the row existing,
 * so callers can salvage without a prior SELECT (K.5: the run row is evidence).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} runId
 * @returns {boolean} true when a row was marked
 */
export function markOrphaned(db, runId) {
  const res = db.prepare('UPDATE worker_runs SET orphaned = 1 WHERE id = ?').run(runId);
  return (res.changes ?? 0) > 0;
}

/** Snapshot plan for one orphan: preserve work, then FAIL→READY with evidence. */
export function salvagePlan(orphan, { recoveryRoot = '.sdlc/recovery' } = {}) {
  return {
    taskId: orphan.taskId,
    runId: orphan.runId,
    attempt: orphan.attempt,
    snapshotDir: `${recoveryRoot}/${orphan.runId}`,
    commands: [
      { step: 'mkdir', argv: ['mkdir', '-p', `${recoveryRoot}/${orphan.runId}`] },
      { step: 'diff', argv: ['git', 'diff', 'HEAD'], capture: `${recoveryRoot}/${orphan.runId}/diff.patch` },
      { step: 'status', argv: ['git', 'status', '--porcelain'], capture: `${recoveryRoot}/${orphan.runId}/status.txt` },
    ],
    markOrphaned: true,
    transition: { to: 'FAILED', actor: 'recovery', reason: 'ORPHAN_SALVAGE' },
  };
}

/**
 * Reconcile persisted state against reality. Returns the discrepancies and the
 * transitions the runtime should apply; each discrepancy is evidence.
 */
export function reconcile({
  tasks = [],
  runs = [],
  isAlive = () => false,
  worktreeExists = () => true,
  branchExists = () => true,
} = {}) {
  const discrepancies = [];
  const transitions = [];
  const runByTask = new Map();
  for (const run of runs) {
    if (!run.finished_at) runByTask.set(run.task_id, run);
  }

  for (const task of tasks) {
    if (!ORPHAN_STATES.includes(task.state)) continue;
    const run = runByTask.get(task.id);
    if (!run) {
      discrepancies.push({ taskId: task.id, kind: 'active-state-without-run', detail: `${task.state} but no open worker_run` });
      transitions.push({ taskId: task.id, to: 'ESCALATED', actor: 'recovery', evidence: 'active-state-without-run' });
      continue;
    }
    // A pid of null is not a live worker: in-process/API runs record no pid, and
    // a crash leaves them unfinished forever. findOrphans already treats null as
    // an orphan ('no-pid'); reconcile must agree or the resume path strands them.
    const deadPid = run.pid == null || !isAlive(run.pid);
    const missingWorktree = Boolean(task.worktree_path) && !worktreeExists(task.worktree_path);
    const missingBranch = Boolean(task.branch) && !branchExists(task.branch);

    if (deadPid) discrepancies.push({ taskId: task.id, kind: 'dead-worker', detail: run.pid == null ? 'no-pid' : `pid ${run.pid} is not alive` });
    if (missingWorktree) discrepancies.push({ taskId: task.id, kind: 'missing-worktree', detail: task.worktree_path });
    if (missingBranch) discrepancies.push({ taskId: task.id, kind: 'missing-branch', detail: task.branch });

    // Exactly ONE transition per task: emitting FAILED and ESCALATED together
    // would let the runtime apply two contradictory moves. A missing worktree or
    // branch makes the work unpreservable, so the ambiguity ESCALATES and
    // outranks the salvage FAILED.
    if (missingWorktree) {
      transitions.push({ taskId: task.id, to: 'ESCALATED', actor: 'recovery', evidence: 'missing-worktree' });
    } else if (missingBranch) {
      transitions.push({ taskId: task.id, to: 'ESCALATED', actor: 'recovery', evidence: 'missing-branch' });
    } else if (deadPid) {
      transitions.push({ taskId: task.id, to: 'FAILED', actor: 'recovery', evidence: 'ORPHAN_SALVAGE' });
    }
  }

  return { discrepancies, transitions, ambiguous: discrepancies.filter((d) => d.kind !== 'dead-worker') };
}

/**
 * Apply a reconciliation to the store: persist `orphaned=1` for every dead
 * worker's run (salvage evidence, K.5) and apply each transition through the
 * state machine. Exactly one transition per task comes out of `reconcile()`,
 * so the runtime applies exactly one move per task here.
 *
 * @param {object} input
 * @param {import('node:sqlite').DatabaseSync} input.db
 * @param {{transition(taskId:string,to:string,actor:string,ctx?:object):{ok:boolean,reason?:string}}} input.state
 *   the TaskStateService (or any object with the same `transition` shape)
 * @param {Array} [input.tasks] task rows (must carry `id`, `state`,
 *   `worktree_path`, `branch`)
 * @param {Array} [input.runs] worker_runs rows
 * @param {(pid:number)=>boolean} [input.isAlive]
 * @param {(path:string)=>boolean} [input.worktreeExists]
 * @param {(branch:string)=>boolean} [input.branchExists]
 */
export function applyReconciliation({
  db, state, tasks = [], runs = [],
  isAlive = () => false, worktreeExists = () => true, branchExists = () => true,
} = {}) {
  if (!db) throw new Error('applyReconciliation: db is required');
  if (!state || typeof state.transition !== 'function') throw new Error('applyReconciliation: state.transition is required');
  const recon = reconcile({ tasks, runs, isAlive, worktreeExists, branchExists });
  const runByTask = new Map();
  for (const run of runs) {
    if (!run.finished_at) runByTask.set(run.task_id, run);
  }
  const applied = [];
  for (const t of recon.transitions) {
    // Dead-worker salvage always marks the run row first: the `orphaned=1`
    // flag is the durable K.5 evidence that the run's output was salvaged,
    // not silently dropped. Escalated siblings keep their run row as-is —
    // the discrepancy (missing worktree/branch) is the evidence there.
    if (t.evidence === 'ORPHAN_SALVAGE') {
      const run = runByTask.get(t.taskId);
      if (run) markOrphaned(db, run.id);
    }
    const res = state.transition(t.taskId, t.to, t.actor ?? 'recovery', {
      hardFailure: t.to === 'FAILED',
      ...(t.to === 'ESCALATED' ? { payload: { evidence: t.evidence } } : {}),
    });
    applied.push({ ...t, ok: res.ok === true, reason: res.ok ? undefined : res.reason ?? res.error });
  }
  return { discrepancies: recon.discrepancies, transitions: recon.transitions, applied };
}

/** Resume is a reconciliation + scheduler re-entry; it never invents state. */
export function resumePlan(state = {}) {
  const recon = reconcile(state);
  return {
    step: 'reconcile',
    discrepancies: recon.discrepancies,
    transitions: recon.transitions,
    reenterScheduler: true,
    note: recon.ambiguous.length
      ? 'ambiguous states become ESCALATED with the discrepancy as evidence'
      : 'no ambiguous state',
  };
}

export default { findOrphans, markOrphaned, salvagePlan, reconcile, resumePlan, applyReconciliation, ORPHAN_STATES };
