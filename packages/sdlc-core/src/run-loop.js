/**
 * packages/sdlc-core/src/run-loop.js — the production scheduler tick (spec v3
 * C.2/B.3, Tier D).
 *
 * WHY THIS MODULE EXISTS
 *
 * `Runtime.dispatchBatch()` deliberately stops at ASSIGNED ("launching the
 * process is the caller's Tier D step"), `executeTask()` (executor.js) stops
 * at VERIFYING, and `gates.runVerification()` + `verifier.decideAcceptance()`
 * were never called by anything outside tests. The observable consequence:
 * a task could be created, queued and dispatched from the panel while
 * `worker_runs`, `test_results` and `model_runs` stayed empty forever — the
 * panel's live telemetry was structurally blank in every deployment.
 *
 * This module is the missing caller, as ONE idempotent function:
 *
 *   advanceFlow() = drain-to-fixed-point of
 *     1. planStep's BACKLOG→READY / →BLOCKED moves (the scheduler's rows),
 *     2. dispatchBatch's READY→ASSIGNED batch (bounded by the real cap),
 *     3. executeTask per ASSIGNED task (real `dsh --profile sdlc-worker`
 *        process in the task's worktree, worker_runs row, ingest, settle),
 *     4. verification: runVerification → recordTestResults → decideAcceptance
 *        → ACCEPTED | FAILED | BLOCKED, and
 *     5. integration: a real `git merge --no-ff` of an ACCEPTED task's branch
 *        into `sdlc/integration`, then DONE.
 *
 * Every write goes through the runtime's own authority path. Nothing here
 * grants approval: acceptance requires gate evidence, and R2+ work above R1
 * additionally requires an independent review verdict — the loop leaves such
 * tasks in VERIFYING and reports them as `awaitingReview` rather than
 * inventing a reviewer or burning the task as FAILED.
 *
 * Gates run in a CHILD PROCESS (gates-child.mjs): `runVerification` uses a
 * synchronous runner, and running `npm test` synchronously inside a host that
 * also serves the panel would freeze the UI for minutes. The child keeps the
 * host's event loop free; the loop's own worker spawn is already async.
 *
 * Waves: after a chain settles, its dependents become READY; the loop re-plans
 * (bounded by `maxWaves`) until the DAG reaches a fixed point. Callers that
 * must return fast (the panel's HTTP handler) read the report after the first
 * dispatch and let `completion` drain the rest in the background.
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { executeTask, worktreePathFor, taskBranch } from './executor.js';
import { decideAcceptance } from './verifier.js';
import { requiredGates, blockedBySkippedGate } from './risk.js';
import { planStep } from './scheduler.js';
import { integrationSteps } from './integration.js';

/** Default bound on re-plan waves: a DAG deeper than this needs a new click. */
export const DEFAULT_MAX_WAVES = 8;

/** The gates a task must pass (risk-derived, config-aware) — the harness contract. */
export function gateSpecFor(task, config = {}) {
  if (Array.isArray(task.verification) && task.verification.length > 0) {
    return task.verification.map((gate) => ({ gate, required: true }));
  }
  return requiredGates(task.risk_class ?? 'R2', {
    gateCommands: config.verification?.gates ?? {},
  });
}

/**
 * Run one task's gate set in the child-process shim and return the
 * `runVerification` result. DI: tests (and any caller with a runner of its
 * own) pass `runGates` directly to `advanceFlow` instead.
 */
async function runGatesInChild({ spawn, projectRoot, payload }) {
  const childPath = fileURLToPath(new URL('./gates-child.mjs', import.meta.url));
  const argv = [process.execPath, childPath, JSON.stringify(payload)];
  const raw = await runArgvSafe({ spawn, argv, cwd: projectRoot });
  if (raw.error || raw.exitCode == null) {
    return {
      overall: 'fail',
      gates: {},
      firstFailure: { gate: 'verify-harness', status: `fail:shim (${raw.error ?? `exit ${raw.exitCode}`})` },
      error: raw.error ?? `gates child exited ${raw.exitCode}`,
    };
  }
  try {
    const parsed = JSON.parse(raw.stdout || '{}');
    if (parsed && typeof parsed === 'object' && parsed.gates) return parsed;
    return { overall: 'fail', gates: {}, firstFailure: null, error: 'gates child returned no result object' };
  } catch (err) {
    return {
      overall: 'fail', gates: {}, firstFailure: null,
      error: `gates child output unparseable: ${err?.message ?? err}`,
    };
  }
}

/** spawn-based argv run that never throws (the executor's runArgv contract). */
async function runArgvSafe({ spawn, argv, cwd }) {
  try {
    const handle = await spawn({ argv, cwd, env: { PATH: process.env.PATH } });
    const outcome = await (typeof handle?.waitForExit === 'function' ? handle.waitForExit() : handle?.exited);
    let stdout = typeof handle?.stdout === 'string' ? handle.stdout : '';
    let stderr = typeof handle?.stderr === 'string' ? handle.stderr : '';
    if ((!stdout || !stderr) && typeof handle?.readOutput === 'function') {
      try {
        const out = await handle.readOutput();
        if (out && typeof out === 'object') {
          if (typeof out.stdout === 'string') stdout = stdout || out.stdout;
          if (typeof out.stderr === 'string') stderr = stderr || out.stderr;
        }
      } catch { /* keep whatever we already have */ }
    }
    return { exitCode: outcome?.exitCode ?? null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: null };
  } catch (err) {
    return { exitCode: null, stdout: '', stderr: '', error: err?.message ?? String(err) };
  }
}

/** True when the (task, run) pair already has recorded gate evidence. */
function hasRecordedGates(runtime, taskId, runId) {
  try {
    const row = runtime.db
      .prepare('SELECT COUNT(*) AS n FROM test_results WHERE task_id = ? AND run_id = ?')
      .get(taskId, runId);
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Verify one VERIFYING task: gates → record → acceptance decision → the
 * verifier's own transition. A green-but-unreviewed R2+ task is REPORTED,
 * not transitioned — the review is a human/reviewer input the loop must not
 * fabricate (L.1 rule 3).
 */
async function verifyTask({ runtime, task, runId, config, runGates, projectRoot, report }) {
  const gateSpec = gateSpecFor(task, config);
  const gateList = gateSpec.map((g) => g.gate);
  const required = gateSpec.filter((g) => g.required).map((g) => g.gate);
  const logDir = join(projectRoot, '.sdlc', 'verification', task.id);

  const stored = runtime.getWorkerRun(runId);
  const result = stored?.result ?? {};
  const filesChanged = Array.isArray(result.files_changed) ? result.files_changed : [];

  const gateResults = await runGates({
    cwd: stored?.worktree_path ?? worktreePathFor(projectRoot, task.id),
    gates: gateList,
    config,
    taskId: task.id,
    logDir,
    changedFiles: filesChanged,
  });
  runtime.recordTestResults(task.id, runId, gateResults.gates ?? gateResults);

  const decision = decideAcceptance({
    riskClass: task.risk_class ?? 'R2',
    requiredGates: required,
    gateResults: gateResults.gates ?? gateResults,
    scope: result.scope ?? { ok: true, code: 'IN_SCOPE' },
    review: null,
    filesChanged: filesChanged,
    claims: {
      status: result.worker_claimed_status,
      __malformed: result.result_malformed,
      __suspect: result.suspect,
    },
    runtimeStatus: result.status ?? 'completed',
    blockedBySkippedGate: blockedBySkippedGate(task.risk_class ?? 'R2', gateSpec),
  });

  const awaitingReview = decision.code === 'REVIEW_REJECTED'
    && (decision.reasons ?? []).some((reason) => String(reason).includes('review verdict missing'));

  if (decision.accept) {
    const settled = runtime.transition(task.id, 'ACCEPTED', 'verifier', { gatesPass: true });
    return { taskId: task.id, runId, decision, settled: settled?.ok === true ? 'ACCEPTED' : task.state, awaitingReview: false };
  }
  if (awaitingReview) {
    report.awaitingReview.push({ taskId: task.id, runId, gates: gateResults.gates ?? {} });
    return { taskId: task.id, runId, decision, settled: task.state, awaitingReview: true };
  }
  if (decision.status === 'BLOCKED') {
    const settled = runtime.transition(task.id, 'BLOCKED', 'verifier', { blockedBySkippedGate: true });
    return { taskId: task.id, runId, decision, settled: settled?.ok === true ? 'BLOCKED' : task.state, awaitingReview: false };
  }
  const settled = runtime.transition(task.id, 'FAILED', 'verifier', {
    gatesPass: false,
    payload: { code: decision.code, reasons: decision.reasons ?? [] },
  });
  return { taskId: task.id, runId, decision, settled: settled?.ok === true ? 'FAILED' : task.state, awaitingReview: false };
}

/**
 * Merge one ACCEPTED task's branch into `sdlc/integration` (B.9): the
 * integration-mgr's own transitions, real git via the injected spawn. A
 * conflict fails the merge honestly (MERGING→FAILED, conflictOrGateFailure).
 */
async function integrateTask({ runtime, task, spawn, projectRoot, report }) {
  const branch = task.branch ?? taskBranch(task.id);
  const moving = runtime.transition(task.id, 'MERGING', 'integration-mgr', { mergeSlotFree: true });
  if (!moving?.ok) {
    report.skipped.push({ taskId: task.id, reason: `MERGING rejected: ${moving?.reason ?? 'unknown'}` });
    return { taskId: task.id, settled: task.state };
  }

  const taskRef = { id: task.id, title: task.title, branch };
  // The merge moves COMMITS, not working trees: the worker's uncommitted
  // work is committed on the task branch first — exactly what the diff
  // already saw (the executor removes the outbox before this point, and the
  // scope verdict was decided from this same status). A worker that already
  // committed (clean tree) skips the commit; a commit failure fails the
  // merge honestly instead of merging a stale branch.
  const worktree = task.worktree_path ?? worktreePathFor(projectRoot, task.id);
  const status = await runArgvSafe({ spawn, argv: ['git', 'status', '--porcelain'], cwd: worktree });
  if (status.exitCode === 0 && status.stdout.trim() !== '') {
    await runArgvSafe({ spawn, argv: ['git', 'add', '-A'], cwd: worktree });
    const committed = await runArgvSafe({
      spawn,
      argv: ['git', 'commit', '-q', '-m', `feat(${task.id}): ${task.title}`],
      cwd: worktree,
    });
    if (committed.exitCode !== 0) {
      const reason = `worktree commit failed: ${committed.stderr?.trim()?.split('\n').at(-1) ?? `exit ${committed.exitCode}`}`;
      runtime.transition(task.id, 'FAILED', 'integration-mgr', {
        postMergeGatesPass: false,
        payload: { code: 'INTEGRATION_COMMIT_FAILED', reason, branch },
      });
      report.skipped.push({ taskId: task.id, reason });
      return { taskId: task.id, settled: 'FAILED' };
    }
  }
  const steps = integrationSteps(taskRef);
  const checkout = steps.find((s) => s.step === 'checkout-integration');
  if (checkout) await runArgvSafe({ spawn, argv: checkout.argv, cwd: projectRoot });
  const mergeStep = steps.find((s) => s.step === 'merge');
  const merged = await runArgvSafe({ spawn, argv: mergeStep.argv, cwd: projectRoot });
  if (merged.error || merged.exitCode !== 0) {
    // Leave the integration branch where it was; the conflict is the evidence.
    // The matrix's guard reads mergeConflict/postMergeGatesPass from the ctx.
    const reason = `${merged.error ?? `git merge exited ${merged.exitCode}`}${merged.stderr ? `: ${merged.stderr.trim().split('\n').at(-1)}` : ''}`;
    runtime.transition(task.id, 'FAILED', 'integration-mgr', {
      mergeConflict: true,
      payload: { code: 'MERGE_CONFLICT', reason, branch },
    });
    report.skipped.push({ taskId: task.id, reason: `merge failed: ${reason}` });
    return { taskId: task.id, settled: 'FAILED' };
  }
  await runArgvSafe({ spawn, argv: ['git', 'tag', `sdlc/accepted/${task.id}`], cwd: projectRoot });
  const done = runtime.transition(task.id, 'DONE', 'integration-mgr', {
    merged: true,
    postMergeGatesPass: true,
    payload: { gatesSource: 'task-branch', branch },
  });
  return { taskId: task.id, settled: done?.ok === true ? 'DONE' : 'MERGING' };
}

/**
 * The scheduler tick. `inFlight` (taskId → chain promise) is CALLER-OWNED so
 * repeated ticks — a poll-driven panel, several clicks — can never launch the
 * same task twice; pass one persistent Map from a long-lived host.
 *
 * @param {object} opts
 * @param {object} opts.runtime open Runtime (caller owns its lifecycle)
 * @param {string} [opts.projectRoot] defaults to runtime.projectRoot
 * @param {object} [opts.config] defaults to runtime.config
 * @param {Function} opts.spawn ctx.subprocess.spawn-compatible
 * @param {string|null} [opts.projectId] scope to one project's tasks
 * @param {number|null} [opts.maxParallel] defaults to runtime.dispatchParallelism()
 * @param {Map} [opts.inFlight] caller-owned in-flight registry
 * @param {Function} [opts.logger] {warn,info} — optional
 * @param {Function} [opts.execute] DI — defaults to executeTask
 * @param {Function} [opts.runGates] DI — defaults to the child-process shim
 * @param {boolean} [opts.integrate] merge ACCEPTED work into sdlc/integration
 * @param {number} [opts.maxWaves] re-plan bound
 * @returns {Promise<{report: object, completion: Promise<object>, cap: number}>}
 *   Resolves after the first dispatch and its chain launches (fast, sqlite
 *   bound); `report` carries what started, `completion` resolves when every
 *   launched chain — and the waves it unlocked — has settled.
 */
export async function advanceFlow({
  runtime,
  projectRoot = runtime?.projectRoot,
  config = runtime?.config ?? {},
  spawn,
  projectId = null,
  maxParallel = null,
  inFlight = new Map(),
  logger = null,
  execute = executeTask,
  runGates = null,
  integrate = true,
  maxWaves = DEFAULT_MAX_WAVES,
} = {}) {
  if (!runtime) throw new Error('advanceFlow: runtime is required');
  if (typeof spawn !== 'function') throw new Error('advanceFlow: a spawn function is required');
  const gatesRunner = runGates ?? ((payload) => runGatesInChild({ spawn, projectRoot, payload }));
  const report = {
    dispatched: [],
    executed: [],
    verified: [],
    integrated: [],
    awaitingReview: [],
    skipped: [],
  };

  const scopedTasks = () => (projectId ? runtime.projectTasks(projectId) : runtime.listTasks());

  /** planStep's BACKLOG→READY moves (the scheduler's own rows).
   *
   * planStep also proposes →BLOCKED for backlog work whose dependencies are
   * not DONE — applying that would STRAND the task: the matrix's
   * BLOCKED→BACKLOG row belongs to the escalation-mgr, so the loop could
   * never re-plan it. A dependency still running is "not ready yet" (the
   * task stays BACKLOG, honestly); a dependency that FAILED is the
   * failed task's own retry story, not a state change on this one. */
  const applyPlanMoves = () => {
    const rows = scopedTasks().map((t) => ({
      id: t.id, state: t.state, allowed_paths: t.allowed_paths ?? [],
      resources: t.resources ?? [], depends_on: t.depends_on ?? [],
    }));
    const step = planStep({ tasks: rows }, { maxParallelWorkers: Number.MAX_SAFE_INTEGER });
    const applied = [];
    for (const move of step) {
      if (move.to !== 'READY') continue; // ASSIGNED belongs to dispatchBatch; BLOCKED would strand the task
      const res = runtime.transition(move.taskId, move.to, move.actor ?? 'scheduler', move.ctx ?? {});
      if (res?.ok) applied.push({ taskId: move.taskId, to: move.to });
    }
    return applied;
  };

  /** One task's full chain: execute → verify → (integrate). Never rejects. */
  const runChain = async (task) => {
    const outcome = await execute({
      runtime, task, spawn,
      worktreePath: task.worktree_path ?? worktreePathFor(projectRoot, task.id),
      projectRoot, config,
      model: routeModel(runtime, task),
    });
    report.executed.push({
      taskId: task.id, runId: outcome.runId ?? null, status: outcome.status ?? null,
      taskState: outcome.taskState ?? null,
      filesChanged: outcome.filesChanged ?? null,
      reason: outcome.reason ?? null,
    });
    if (!outcome.ok || !outcome.runId) return outcome;
    // Verify immediately (the run just settled); VERIFYING is the precondition.
    const row = runtime.getTask(task.id);
    if (row?.state !== 'VERIFYING') return outcome;
    if (hasRecordedGates(runtime, task.id, outcome.runId)) return outcome;
    const verdict = await verifyTask({
      runtime, task: row, runId: outcome.runId, config, runGates: gatesRunner,
      projectRoot, report,
    });
    report.verified.push({ taskId: task.id, runId: outcome.runId, decision: verdict.decision?.code ?? null, settled: verdict.settled, awaitingReview: verdict.awaitingReview });
    if (integrate && verdict.settled === 'ACCEPTED') {
      const fresh = runtime.getTask(task.id);
      const merged = await integrateTask({ runtime, task: fresh, spawn, projectRoot, report });
      report.integrated.push({ taskId: task.id, settled: merged.settled });
    }
    return outcome;
  };

  /** Launch chains for every ASSIGNED task, deduped by the in-flight map. */
  const launchAssigned = async (cap) => {
    const dispatched = await runtime.dispatchBatch({ projectId, cap });
    report.dispatched.push(...dispatched.map((d) => ({ taskId: d.taskId, to: d.to })));
    let slots = cap - inFlight.size;
    for (const row of scopedTasks()) {
      if (slots <= 0) break;
      if (row.state !== 'ASSIGNED' || inFlight.has(row.id)) continue;
      slots -= 1;
      const chain = runChain(row)
        .catch((err) => {
          // A chain must never take the host down; the failure is evidence.
          report.skipped.push({ taskId: row.id, reason: `chain crashed: ${err?.message ?? err}` });
          if (logger?.warn) logger.warn('sdlc-run-loop: chain for %s crashed: %s', row.id, err?.message ?? err);
          return null;
        })
        .finally(() => { inFlight.delete(row.id); });
      inFlight.set(row.id, chain);
    }
  };

  /**
   * Merge every ACCEPTED task of the scope (this wave's or an earlier tick's)
   * and verify every VERIFYING task whose run finished without recorded
   * gates — the idempotent resume pass. Returns how many actions it took.
   */
  const settlePass = async () => {
    let actions = 0;
    for (const row of scopedTasks()) {
      if (inFlight.has(row.id)) continue;
      if (integrate && row.state === 'ACCEPTED') {
        const merged = await integrateTask({ runtime, task: row, spawn, projectRoot, report });
        report.integrated.push({ taskId: row.id, settled: merged.settled });
        actions += 1;
      } else if (row.state === 'VERIFYING') {
        const last = runtime.listWorkerRuns({ taskId: row.id }).at(-1);
        if (!last || last.status !== 'completed' || hasRecordedGates(runtime, row.id, last.id)) continue;
        const verdict = await verifyTask({
          runtime, task: row, runId: last.id, config, runGates: gatesRunner, projectRoot, report,
        });
        report.verified.push({
          taskId: row.id, runId: last.id, decision: verdict.decision?.code ?? null,
          settled: verdict.settled, awaitingReview: verdict.awaitingReview,
        });
        actions += 1;
        if (integrate && verdict.settled === 'ACCEPTED') {
          const fresh = runtime.getTask(row.id);
          const merged = await integrateTask({ runtime, task: fresh, spawn, projectRoot, report });
          report.integrated.push({ taskId: row.id, settled: merged.settled });
        }
      }
    }
    return actions;
  };

  /**
   * The wave driver, run in the background. Wave = plan moves → dispatch →
   * wait for chains → settle (verify/merge) → repeat while the DAG still
   * makes progress, bounded by maxWaves.
   */
  const drainWaves = async (cap) => {
    try {
      for (let wave = 0; wave < maxWaves; wave += 1) {
        const before = { executed: report.executed.length, settled: report.verified.length + report.integrated.length };
        applyPlanMoves();
        await launchAssigned(cap);
        await Promise.all([...inFlight.values()]);
        const settled = await settlePass();
        const progressed = (report.executed.length > before.executed)
          || (report.verified.length + report.integrated.length > before.settled)
          || settled > 0;
        if (!progressed) break;
      }
    } catch (err) {
      if (logger?.warn) logger.warn('sdlc-run-loop: advance failed: %s', err?.message ?? err);
      report.skipped.push({ taskId: null, reason: `advance failed: ${err?.message ?? err}` });
    }
    return report;
  };

  // The fast prefix the caller can await: dependency-READY moves plus the
  // first dispatch and its chain LAUNCHES (not their completion). The HTTP
  // handler answers with what started; `completion` owns the rest.
  const begin = (async () => {
    const cap = maxParallel ?? await runtime.dispatchParallelism();
    applyPlanMoves();
    await launchAssigned(cap);
    const completion = drainWaves(cap);
    return { report, completion, cap };
  })();
  return begin;
}

/** The route the router picks for one task, as the executor's model shape. */
function routeModel(runtime, task) {
  try {
    const routed = runtime.route({
      attempt: task.attempt ?? 0,
      task_class: task.task_class ?? 'normal',
      task_type: task.role ?? 'default',
      complexity: task.complexity ?? null,
    });
    if (routed?.provider && routed?.model) return { provider: routed.provider, id: routed.model };
  } catch { /* routing is best-effort; the run records what it used */ }
  return null;
}

export default { advanceFlow, gateSpecFor, DEFAULT_MAX_WAVES };
