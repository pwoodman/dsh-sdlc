/**
 * packages/sdlc-core/src/executor.js — the worker execution engine (spec v3
 * C.2, §B.3.2, §B.10, E5, E8, P4/P25/P32/P33/P34).
 *
 * WHY THIS MODULE EXISTS
 *
 * `Runtime.dispatchBatch()` deliberately stops at ASSIGNED: it transitions the
 * bounded batch and documents that "launching the process for each ASSIGNED
 * task is the caller's Tier D step, not this method's". That caller was never
 * written. The observable consequence was that nothing in the product ever ran:
 * a task could be queued, dispatched and ASSIGNED, and `worker_runs` stayed
 * empty forever. Every downstream surface — gates, spend, Review (which needs
 * two runs), the whole flow panel — was therefore structurally empty. This
 * module IS that missing caller.
 *
 * It is the single place that turns an ASSIGNED task into a real OS process,
 * waits for it, classifies the exit, ingests the worker's own reported diff,
 * persists the run, and hands the task to verification. It invents no state: if
 * a value is unknown it stays null rather than becoming a zero.
 *
 * CREDENTIAL SCRUB (E5 — the design-critical platform finding)
 *
 * `ctx.subprocess` builds a child env from the parent MINUS every name matching
 * /KEY|PASSWORD|SECRET|TOKEN/i and MINUS every `DSH_*` name. So `DSH_HOME` and
 * every provider key are stripped unless passed EXPLICITLY. `buildWorkerEnv`
 * (worker-mgr.js) constructs that explicit map and returns an audit record of
 * what was forwarded; default `workerEnvKeys = []` means credential-store auth,
 * and any opt-in is recorded in `worker_runs.context_manifest_json`.
 *
 * DEPENDENCY INJECTION
 *
 * The spawn function arrives as `spawn` — never a static `ctx` import — so the
 * engine is unit-testable offline without a DSH host, and the E6 partition
 * (core must not statically import host-only modules) is preserved.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  buildWorkerEnv, buildSpawnArgv, workerRunId, nonceFor, classifyExit,
  parseNdjson, finalText, turnEndReason, workerLogPath, sessionForAttempt,
} from './worker-mgr.js';

/** Default wall-clock ceiling for one worker process (config-overridable). */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Terminate escalation: SIGTERM, then SIGKILL after this grace period. */
export const SIGKILL_GRACE_MS = 5000;

/**
 * Read the per-task prompt contract the worker is launched with.
 *
 * Deliberately terse and factual: the worker receives the task's own row, not a
 * narrative the orchestrator invented. `objective` is the goal the human typed
 * or the planner wrote; acceptance criteria and allowed paths are passed
 * through verbatim so the guard and the verifier can hold the worker to them.
 *
 * The reporting contract is part of the prompt: a worker that knows its run
 * identity may write the outbox file; a worker that only prints still has the
 * fenced-block channel. Without one valid channel the result is malformed by
 * design — evidence, not narrative, is what gets ingested.
 *
 * @param {object} task - task row
 * @param {object} [identity] - { runId, attempt, nonce } for the outbox channel
 * @returns {string}
 */
export function buildTaskPrompt(task = {}, identity = null) {
  const lines = [
    `# Task ${task.id}`,
    '',
    `## Objective`,
    String(task.objective ?? task.title ?? '').trim() || '(no objective recorded)',
    '',
  ];
  const acs = Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [];
  if (acs.length > 0) {
    lines.push('## Acceptance criteria');
    for (const ac of acs) {
      const id = ac?.id ?? ac?.ac_id ?? '?';
      lines.push(`- ${id}: ${ac?.text ?? ac?.description ?? ''}`);
    }
    lines.push('');
  }
  const allowed = Array.isArray(task.allowed_paths) ? task.allowed_paths : [];
  if (allowed.length > 0) {
    lines.push('## Allowed paths');
    for (const p of allowed) lines.push(`- ${p}`);
    lines.push('');
  }
  lines.push(
    '## Reporting',
    'Report the work you did in ONE of two ways (otherwise the run is',
    'rejected as malformed — a claim is not evidence until it is parseable):',
    '',
    '1. Preferred: write `.sdlc/task-outbox.json` (relative to your working',
    '   directory) with EXACTLY this shape:',
    '   {"schemaVersion":1,"runId":"<runId>","taskId":"<taskId>","attempt":<attempt>,"nonce":"<nonce>",',
    '   "status":"completed","summary":"what you did","evidence_claims":[],"tests_run":[],"requests":[]}',
  );
  if (identity) {
    lines.push(
      `   For THIS run: runId=${identity.runId} taskId=${task.id} attempt=${identity.attempt} nonce=${identity.nonce}`,
    );
  }
  lines.push(
    '',
    '2. Fallback: end your FINAL message with a fenced block:',
    '   ```sdlc-result',
    '   {"status":"completed","summary":"what you did","evidence_claims":[],"tests_run":[],"requests":[]}',
    '   ```',
    '',
    'Files you change must stay inside the allowed paths. Do not edit `.sdlc/`',
    'except the outbox file above, then stop.',
  );
  return lines.join('\n');
}

/**
 * The run identity for one (task, attempt) — deterministic, so a retry that
 * resumes the same session addresses the same logical run.
 *
 * @param {object} task
 * @returns {number} the 0-based attempt this run represents
 */
export function attemptOf(task = {}) {
  const n = Number(task.attempt ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Decide how this attempt relates to the previous one (E8).
 *
 * The resume rule is narrow on purpose: a retry reuses the worker SESSION only
 * while the worktree and preset are unchanged; a re-created worktree starts
 * fresh, because resuming a session against a different tree would let the model
 * believe in files that no longer exist.
 *
 * @param {object} opts
 * @returns {{sessionId: string|null, fresh: boolean, reason: string}}
 */
export function resolveSession({ task = {}, sessionId = null, worktreeRecreated = false, presetChanged = false } = {}) {
  return sessionForAttempt({
    previousSessionId: sessionId ?? task.worker_session_id ?? null,
    worktreeRecreated,
    presetChanged,
  });
}

/**
 * Assemble everything needed to launch one worker, without launching it.
 *
 * Split out from `executeTask` so the launch contract (argv, env, cwd, log
 * path, audit) is unit-testable and reviewable on its own — the E5 env map is
 * the kind of thing that must be asserted, not trusted.
 *
 * @param {object} opts
 * @param {object} opts.task - task row
 * @param {string} opts.projectRoot
 * @param {string} opts.worktreePath
 * @param {object} [opts.config]
 * @param {object|null} [opts.model] - {provider, id}
 * @param {string|null} [opts.tierOverlay]
 * @param {string|null} [opts.sessionId]
 * @param {string} [opts.profile]
 * @returns {object} launch plan
 */
export function planWorkerLaunch({
  task, projectRoot, worktreePath, config = {}, model = null,
  tierOverlay = null, sessionId = null, profile = 'sdlc-worker',
} = {}) {
  const attempt = attemptOf(task);
  const runId = workerRunId(task.id, attempt);
  const nonce = nonceFor(runId);
  const prompt = buildTaskPrompt(task, { runId, attempt, nonce });
  const logPath = workerLogPath(projectRoot, task.id, runId);
  const { env, audit } = buildWorkerEnv({
    dshHome: config.dshHome ?? process.env.DSH_HOME ?? null,
    baseEnv: process.env,
    workerEnvKeys: config.execution?.workerEnvKeys ?? config.workerEnvKeys ?? [],
  });
  const argv = buildSpawnArgv({ profile, tierOverlay, prompt, sessionId });
  // The context manifest records what the worker was TOLD and what it was
  // ALLOWED to inherit — context decisions and credential exposure audit.
  const contextManifest = {
    prompt,
    blocks: [{ name: 'task-contract', bytes: Buffer.byteLength(prompt, 'utf8') }],
    attempt,
    runId,
    credentialPolicy: audit.credentialPolicy,
    forwardedEnvKeys: audit.forwardedEnvKeys,
    dshHome: audit.DSH_HOME,
  };
  return {
    runId, nonce, argv, env, audit, cwd: worktreePath, logPath,
    attempt, contextManifest, model, timeoutMs: config.execution?.workerTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Persist the worker's captured NDJSON stream to its evidence log.
 *
 * The log is the durable artifact a human or the verifier reads when a run
 * fails; it is written before classification so a crashed run still leaves
 * evidence behind. Failure to write is not fatal to the run itself.
 *
 * @returns {string} the path attempted (recorded either way)
 */
export function writeWorkerLog(logPath, stdout, stderr) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const body = [
      '# stdout',
      String(stdout ?? ''),
      '# stderr',
      String(stderr ?? ''),
    ].join('\n');
    writeFileSync(logPath, body);
    return logPath;
  } catch {
    return logPath;
  }
}

/**
 * Run one worker process to completion and return its raw outcome.
 *
 * This is the thin, testable core: it owns process lifecycle (spawn, collect,
 * timeout, terminate escalation) and NOTHING about state transitions. A caller
 * that injects a fake `spawn` gets deterministic behaviour with no OS process,
 * which is how the engine is verified offline.
 *
 * @param {object} opts
 * @param {Function} opts.spawn - ctx.subprocess.spawn-compatible
 * @param {string[]} opts.argv
 * @param {string} opts.cwd
 * @param {object} opts.env
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number|null, signal:string|null, timedOut:boolean, pid:number|null, spawnError:string|null}>}
 */
export async function runWorkerProcess({ spawn, argv, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof spawn !== 'function') {
    return {
      stdout: '', stderr: '', exitCode: null, signal: null,
      timedOut: false, pid: null, spawnError: 'no spawn function provided',
    };
  }

  let handle;
  try {
    handle = await spawn({ argv, cwd, env });
  } catch (err) {
    // A spawn that throws (missing binary, ENOENT, EACCES) is a real failed
    // run with a real reason — never a silent skip.
    return {
      stdout: '', stderr: '', exitCode: null, signal: null,
      timedOut: false, pid: null, spawnError: err?.message ?? String(err),
    };
  }

  const pid = handle?.pid ?? null;
  let timedOut = false;
  let timer = null;
  let killTimer = null;

  const wait = Promise.resolve()
    .then(() => (typeof handle?.waitForExit === 'function'
      ? handle.waitForExit()
      : (handle?.exited ?? null)))
    .catch((err) => ({ exitCode: null, signal: null, error: err?.message ?? String(err) }));

  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof handle?.terminate === 'function') {
    timer = setTimeout(() => {
      timedOut = true;
      try { handle.terminate('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { handle.terminate('SIGKILL'); } catch { /* already gone */ }
      }, SIGKILL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  let outcome = null;
  try {
    outcome = await wait;
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }

  // Output may be exposed either as a collected string on the handle or by
  // awaiting a stream reader; accept both shapes without inventing content.
  let stdout = typeof handle?.stdout === 'string' ? handle.stdout : '';
  let stderr = typeof handle?.stderr === 'string' ? handle.stderr : '';
  if (typeof handle?.readOutput === 'function') {
    try {
      const out = await handle.readOutput();
      if (out && typeof out === 'object') {
        stdout = typeof out.stdout === 'string' ? out.stdout : stdout;
        stderr = typeof out.stderr === 'string' ? out.stderr : stderr;
      }
    } catch { /* keep whatever we already have */ }
  }

  return {
    stdout,
    stderr,
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    timedOut,
    pid,
    spawnError: outcome?.error ?? null,
  };
}

/**
 * Parse a raw process outcome into what the runtime records.
 *
 * `tokens`/`costUsd` come from the worker's own `final` event when it reports
 * them; absent that they stay null so the panel renders "—" instead of a
 * fabricated zero (the never-fabricate rule).
 *
 * @param {object} raw - runWorkerProcess() output
 * @returns {{status:string, exitCode:number|null, tokens:object|null, costUsd:number|null, finalText:string|null, events:object[]}}
 */
export function interpretWorkerOutcome(raw = {}) {
  const { events } = parseNdjson(raw.stdout);
  const reason = turnEndReason(events);
  const status = raw.spawnError
    ? 'failed'
    : classifyExit({ exitCode: raw.exitCode, signal: raw.signal, turnEndReason: reason });
  const final = finalText(events);

  let tokens = null;
  let costUsd = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    const usage = ev?.usage ?? ev?.tokens ?? null;
    if (usage && typeof usage === 'object') {
      const inTok = usage.in ?? usage.input ?? usage.prompt_tokens;
      const outTok = usage.out ?? usage.output ?? usage.completion_tokens;
      if (inTok != null || outTok != null) {
        tokens = { in: inTok ?? 0, out: outTok ?? 0 };
      }
      if (typeof usage.costUsd === 'number') costUsd = usage.costUsd;
    }
    if (tokens && costUsd != null) break;
  }

  return {
    status: raw.timedOut ? 'timeout' : status,
    exitCode: raw.exitCode ?? null,
    tokens,
    costUsd,
    finalText: final,
    events,
  };
}

/** The per-task branch the worker commits to (spec v3 §B.10). */
export function taskBranch(taskId) {
  return `sdlc/task-${taskId}`;
}

/** The worktree path a task's worker runs in. */
export function worktreePathFor(projectRoot, taskId) {
  return join(projectRoot, '.sdlc', 'worktrees', taskId);
}

/**
 * Run one argv-based command to completion; never a shell string.
 *
 * A spawn that THROWS (missing binary, ENOENT, EACCES) is a describable
 * failure, not an exception: provisioning must be able to report `why` and
 * let the caller persist a failed run with that reason instead of crashing
 * the loop.
 */
async function runArgv({ spawn, argv, cwd, env = { PATH: process.env.PATH } }) {
  try {
    const handle = await spawn({ argv, cwd, env });
    const outcome = await (typeof handle?.waitForExit === 'function' ? handle.waitForExit() : handle?.exited);
    let stdout = typeof handle?.stdout === 'string' ? handle.stdout : '';
    if (!stdout && typeof handle?.readOutput === 'function') {
      try { stdout = (await handle.readOutput())?.stdout ?? ''; } catch { /* keep empty */ }
    }
    return { exitCode: outcome?.exitCode ?? null, stdout: String(stdout ?? ''), error: null };
  } catch (err) {
    return { exitCode: null, stdout: '', error: err?.message ?? String(err) };
  }
}

/**
 * Provision the task's git worktree, idempotently.
 *
 * Spec v3 §B.10: `git worktree add .sdlc/worktrees/<task-id> -b sdlc/task-<id>
 * <base>`. Three real cases must be distinguished, because "the directory
 * exists" does NOT mean "the worktree is usable":
 *
 *   - already a valid worktree  → reuse it (a retry resumes in place, E8),
 *   - directory exists but is NOT a worktree (a stale/partial run) → prune and
 *     re-create, reporting `recreated: true` so the caller starts a FRESH
 *     session rather than resuming against files that changed underneath it,
 *   - absent → create.
 *
 * @returns {Promise<{ok:boolean, path:string, branch:string, created:boolean, recreated:boolean, base:string|null, reason:string|null}>}
 */
export async function ensureWorktree({
  spawn, projectRoot, taskId, baseBranch = 'sdlc/integration', worktreePath = null,
} = {}) {
  const path = worktreePath ?? worktreePathFor(projectRoot, taskId);
  const branch = taskBranch(taskId);
  if (typeof spawn !== 'function') {
    return { ok: false, path, branch, created: false, recreated: false, base: null, reason: 'no spawn function provided' };
  }

  const isWorktree = existsSync(join(path, '.git'));
  if (isWorktree) {
    return { ok: true, path, branch, created: false, recreated: false, base: null, reason: null };
  }

  let recreated = false;
  if (existsSync(path)) {
    // A directory that is not a worktree is a partial artefact; remove and
    // rebuild rather than running a worker in a tree git does not track.
    try {
      const pruned = await runArgv({ spawn, argv: ['git', 'worktree', 'prune'], cwd: projectRoot });
      void pruned;
      mkdirSync(path, { recursive: true });
    } catch { /* fall through to the add attempt, which reports the real error */ }
    recreated = true;
  }

  // Prefer the integration branch; fall back to HEAD when it does not exist
  // yet (a fresh repo with no integration branch must still be runnable).
  const bases = [baseBranch, 'HEAD'];
  let lastReason = null;
  for (const base of bases) {
    const check = await runArgv({
      spawn, argv: ['git', 'rev-parse', '--verify', '--quiet', base], cwd: projectRoot,
    });
    if (check.error) { lastReason = `spawn error: ${check.error}`; continue; }
    if (check.exitCode !== 0) { lastReason = `base branch ${base} does not exist`; continue; }
    const add = await runArgv({
      spawn,
      argv: ['git', 'worktree', 'add', path, '-b', branch, base],
      cwd: projectRoot,
    });
    if (add.error) { lastReason = `spawn error: ${add.error}`; continue; }
    if (add.exitCode === 0) {
      return { ok: true, path, branch, created: true, recreated, base, reason: null };
    }
    // The branch may already exist from a previous attempt: attach to it.
    const attach = await runArgv({
      spawn, argv: ['git', 'worktree', 'add', path, branch], cwd: projectRoot,
    });
    if (attach.error) { lastReason = `spawn error: ${attach.error}`; continue; }
    if (attach.exitCode === 0) {
      return { ok: true, path, branch, created: true, recreated, base, reason: null };
    }
    lastReason = `git worktree add failed (${add.exitCode})`;
  }
  return { ok: false, path, branch, created: false, recreated, base: null, reason: lastReason };
}

/**
 * Run the worker's post-exit git diff so the recorded `files_changed` is real.
 *
 * The orchestrator derives from git; it never trusts the worker's own claim
 * (L.1.2). When git is unavailable the diff is null — "unknown", not "nothing
 * changed".
 *
 * @param {object} opts
 * @param {Function} opts.spawn
 * @param {string} opts.cwd
 * @returns {Promise<string[]|null>}
 */
export async function collectChangedFiles({ spawn, cwd } = {}) {
  if (typeof spawn !== 'function') return null;
  try {
    const handle = await spawn({ argv: ['git', 'status', '--porcelain'], cwd, env: { PATH: process.env.PATH } });
    const outcome = await (typeof handle?.waitForExit === 'function' ? handle.waitForExit() : handle?.exited);
    const stdout = typeof handle?.stdout === 'string'
      ? handle.stdout
      : (typeof handle?.readOutput === 'function' ? (await handle.readOutput())?.stdout : '');
    if (outcome?.exitCode !== 0) return null;
    return String(stdout ?? '')
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The per-attempt cost from the user's own authored price table, or null.
 *
 * A worker that reports `usage.costUsd` wins (the provider's number). When it
 * reports only tokens, the price table the user wrote in `.sdlc/config.yml`
 * produces the estimate the router itself would produce — and an UNKNOWN
 * price stays null so the panel renders "—" instead of a fabricated zero.
 */
export function estimateCostUsd(config, model, tokens) {
  if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string') return null;
  if (!tokens || typeof tokens !== 'object') return null;
  const key = `${model.provider}/${model.id}`;
  const price = config?.pricing?.[key] ?? config?.pricing?.[model.id] ?? null;
  if (!price || !Number.isFinite(Number(price.input)) || !Number.isFinite(Number(price.output))) return null;
  return ((tokens.in ?? 0) * Number(price.input) + (tokens.out ?? 0) * Number(price.output)) / 1_000_000;
}

/**
 * Execute one ASSIGNED task end-to-end: transition, spawn, wait, record,
 * ingest. Ordering is deliberate and each step is durable before the next:
 *   1. normalize the state (READY→ASSIGNED, then ASSIGNED→IN_PROGRESS —
 *      "first worker event", the worker-mgr's own matrix rows),
 *   2. provision the worktree,
 *   3. insert the `worker_runs` row as `running` (so a crash leaves a trace
 *      and recovery can find the orphan),
 *   4. spawn and wait,
 *   5. write the evidence log,
 *   6. ingest the derived result through the runtime's own authority path,
 *   7. settle the lifecycle state: VERIFYING when the worker completed,
 *      FAILED when it did not (a FAILED task is retryable through the
 *      scheduler's own retry path; nothing here burns authority).
 *
 * The runtime owns every write; this function owns process lifecycle plus the
 * worker-mgr's own state-machine rows — and nothing else.
 *
 * @param {object} opts
 * @param {object} opts.runtime - open Runtime
 * @param {object} opts.task - task row (must be READY or ASSIGNED)
 * @param {Function} opts.spawn - ctx.subprocess.spawn-compatible
 * @param {string} opts.worktreePath
 * @param {object} [opts.config]
 * @param {object|null} [opts.model]
 * @param {string|null} [opts.tierOverlay]
 * @param {string|null} [opts.sessionId]
 * @param {boolean} [opts.dryRun] - plan and record nothing; return the plan
 * @returns {Promise<object>} execution report
 */
export async function executeTask({
  runtime, task, spawn, worktreePath, projectRoot = runtime?.projectRoot,
  config = runtime?.config ?? {}, model = null, tierOverlay = null, sessionId = null,
  profile = 'sdlc-worker', dryRun = false, provision = true,
} = {}) {
  if (!runtime) throw new Error('executeTask: runtime is required');
  if (!task || typeof task.id !== 'string') throw new Error('executeTask: a task row is required');

  // Dry-run: plan only — no state change, no provisioning, no run row.
  if (dryRun) {
    const session = resolveSession({ task, sessionId });
    const plan = planWorkerLaunch({
      task, projectRoot, worktreePath, config, model, tierOverlay,
      sessionId: session.sessionId, profile,
    });
    return { ok: true, dryRun: true, ...plan };
  }

  // ── lifecycle normalization: the worker-mgr's own matrix rows ──────────
  // READY→ASSIGNED is the scheduler's row; executeTask reaches it only when
  // the caller handed over a READY task directly (tests, the run loop's
  // fallback), with the same empty-locks context dispatchBatch would pass.
  let current = runtime.getTask(task.id);
  if (!current) {
    return { ok: false, status: 'failed', reason: `task ${task.id} no longer exists`, runId: null, filesChanged: null };
  }
  if (current.state === 'READY') {
    const assigned = runtime.transition(task.id, 'ASSIGNED', 'scheduler', { locks: [], available: true });
    if (!assigned?.ok) {
      return {
        ok: false, status: 'failed', reason: `READY→ASSIGNED rejected: ${assigned?.reason ?? 'unknown'}`,
        runId: null, filesChanged: null,
      };
    }
    current = runtime.getTask(task.id);
  }
  if (current.state === 'ASSIGNED') {
    const started = runtime.transition(task.id, 'IN_PROGRESS', 'worker-mgr', {});
    if (!started?.ok) {
      return {
        ok: false, status: 'failed', reason: `ASSIGNED→IN_PROGRESS rejected: ${started?.reason ?? 'unknown'}`,
        runId: null, filesChanged: null,
      };
    }
  } else if (current.state !== 'IN_PROGRESS') {
    return {
      ok: false, status: 'skipped', reason: `task ${task.id} is ${current.state}, not dispatchable`,
      runId: null, filesChanged: null,
    };
  }

  // Provision before planning the session: whether the worktree was RECREATED
  // is exactly what decides resume-vs-fresh (E8). A provisioning failure is a
  // PERSISTED failed attempt with the real reason — never a thrown exception
  // and never a silent skip.
  let worktree = null;
  if (provision) {
    worktree = await ensureWorktree({ spawn, projectRoot, taskId: task.id, worktreePath });
    if (!worktree.ok) {
      const reason = `worktree unavailable: ${worktree.reason}`;
      const plan = planWorkerLaunch({
        task, projectRoot, worktreePath: worktreePath ?? worktree.path, config, model, tierOverlay,
        sessionId: resolveSession({ task, sessionId }).sessionId, profile,
      });
      const runId = runtime.startWorkerRun({
        taskId: task.id, attempt: plan.attempt, sessionId: null,
        model, worktreePath, contextManifest: plan.contextManifest, nonce: plan.nonce, id: plan.runId,
      });
      runtime.finishWorkerRun(runId, {
        status: 'failed', exitCode: null, durationMs: 0,
        result: { status: 'failed', reason, filesChanged: null, logPath: plan.logPath },
      });
      settleFailure(runtime, task.id, reason);
      return { ok: false, status: 'failed', reason, worktree, runId, durationMs: 0, filesChanged: null };
    }
    worktreePath = worktree.path;
  }

  const session = resolveSession({
    task,
    sessionId,
    worktreeRecreated: Boolean(worktree?.recreated),
  });

  const plan = planWorkerLaunch({
    task, projectRoot, worktreePath, config, model, tierOverlay,
    sessionId: session.sessionId, profile,
  });

  const runId = runtime.startWorkerRun({
    taskId: task.id,
    attempt: plan.attempt,
    sessionId: session.sessionId,
    model,
    worktreePath,
    contextManifest: plan.contextManifest,
    nonce: plan.nonce,
    id: plan.runId,
  });

  const startedAt = Date.now();
  const raw = await runWorkerProcess({
    spawn, argv: plan.argv, cwd: worktreePath, env: plan.env, timeoutMs: plan.timeoutMs,
  });
  const durationMs = Date.now() - startedAt;

  writeWorkerLog(plan.logPath, raw.stdout, raw.stderr);
  const outcome = interpretWorkerOutcome(raw);

  // The worker's own outbox (the prompt's preferred reporting channel). Read
  // it back, then REMOVE it: a stale outbox from a previous attempt must
  // never be ingested as this attempt's claims, and it must not leak into the
  // changed-file set the gates run against. The fenced-block fallback in the
  // final text needs no file and stays available either way.
  let outboxRaw = null;
  const outboxPath = join(worktreePath, '.sdlc', 'task-outbox.json');
  try {
    outboxRaw = readFileSync(outboxPath, 'utf8');
  } catch { /* no outbox — the fenced-block fallback still applies */ }
  try { rmSync(outboxPath, { force: true }); } catch { /* nothing to clean */ }

  const filesChanged = await collectChangedFiles({ spawn, cwd: worktreePath });

  // A run whose process never started has no diff to ingest: record the
  // failure with its reason instead of letting ingest interpret empty output
  // as "worker changed nothing".
  if (raw.spawnError) {
    runtime.finishWorkerRun(runId, {
      status: 'failed',
      exitCode: null,
      durationMs,
      result: { status: 'failed', reason: raw.spawnError, filesChanged: null, logPath: plan.logPath },
    });
    settleFailure(runtime, task.id, raw.spawnError);
    return {
      ok: false, runId, status: 'failed', reason: raw.spawnError,
      durationMs, logPath: plan.logPath, filesChanged,
    };
  }

  // The provider's own number wins; the user's authored price table is the
  // documented estimate; an unknown price stays null ("—" in the panel).
  const costUsd = outcome.costUsd ?? estimateCostUsd(config, model, outcome.tokens);

  const ingest = runtime.ingestResult({
    runId,
    filesChanged: filesChanged ?? [],
    contract: {
      id: task.id,
      acceptance_criteria: task.acceptance_criteria ?? [],
      allowed_paths: task.allowed_paths ?? [],
      forbidden_paths: task.forbidden_paths ?? [],
    },
    outboxRaw,
    finalText: outcome.finalText,
    runMeta: { runId, taskId: task.id, attempt: plan.attempt, nonce: plan.nonce },
    runtime: {
      exitCode: outcome.exitCode,
      durationMs,
      tokens: outcome.tokens,
      costUsd,
    },
  });

  // Routing history: one model_runs row per attempt, the same row shape the
  // router reads back to rank models by outcome.
  try {
    if (model?.provider && model?.id) {
      runtime.recordModelRun({
        model_id: `${model.provider}/${model.id}`,
        task_id: task.id,
        task_type: task.role ?? 'default',
        complexity: task.complexity ?? null,
        duration_ms: durationMs,
        tokens: outcome.tokens ? (outcome.tokens.in ?? 0) + (outcome.tokens.out ?? 0) : 0,
        cost_usd: costUsd ?? 0,
        attempts: plan.attempt + 1,
        outcome: outcome.status === 'completed' ? 'success' : 'failure',
        escalated: 0,
      });
    }
  } catch { /* routing history is evidence, never a hard failure */ }

  // Settle the lifecycle: completed work moves to VERIFYING (the verifier
  // owns the next row); anything else FAILED — retryable via the scheduler.
  const settled = settleAfterRun(runtime, task.id, outcome, ingest);
  // The authoritative post-ingest row: ingestResult is the one that finishes
  // the run (status, tokens, cost, result), so the report must read the row
  // AFTER it, never the pre-ingest snapshot.
  const stored = runtime.getWorkerRun(runId);
  return {
    ok: outcome.status === 'completed',
    runId,
    status: stored?.status ?? outcome.status,
    processStatus: outcome.status,
    exitCode: outcome.exitCode,
    durationMs,
    tokens: outcome.tokens,
    costUsd,
    logPath: plan.logPath,
    filesChanged,
    ingest,
    taskState: settled,
  };
}

/** IN_PROGRESS→FAILED with the reason as event evidence (worker-mgr's row). */
function settleFailure(runtime, taskId, reason) {
  try {
    runtime.transition(taskId, 'FAILED', 'worker-mgr', {
      hardFailure: true,
      payload: { code: 'WORKER_LAUNCH_FAILED', reason },
    });
  } catch { /* the run row already carries the failure */ }
}

/**
 * The post-ingest lifecycle settlement. VERIFYING for a completed run — the
 * verifier owns the next transition; FAILED for everything else. The budget
 * path inside ingestResult may already have moved the task to FAILED; only
 * a task still IN_PROGRESS is settled here.
 */
function settleAfterRun(runtime, taskId, outcome, ingest) {
  const row = runtime.getTask(taskId);
  if (!row || row.state !== 'IN_PROGRESS') return row?.state ?? null;
  if (outcome.status === 'completed') {
    const res = runtime.transition(taskId, 'VERIFYING', 'worker-mgr', {});
    return res?.ok ? 'VERIFYING' : row.state;
  }
  settleFailure(runtime, taskId, `worker ${outcome.status}`);
  return 'FAILED';
}

export default {
  DEFAULT_TIMEOUT_MS, SIGKILL_GRACE_MS,
  buildTaskPrompt, attemptOf, resolveSession, planWorkerLaunch, writeWorkerLog,
  runWorkerProcess, interpretWorkerOutcome, collectChangedFiles, executeTask, estimateCostUsd,
};
