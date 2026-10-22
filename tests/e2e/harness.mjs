/**
 * tests/e2e/harness.mjs — the shared orchestrator-runner for the §53 acceptance
 * layer (spec v3 K.8, G.4, D.1).
 *
 * WHY THIS EXISTS
 * ---------------
 * The DSH-hosted Lead cannot be launched in this workspace (no pnpm, no
 * profiles, no funded provider). Rather than fake the pipeline, the runner
 * drives the SAME runtime services the Lead would drive, in-process:
 *
 *   initProject  →  Runtime.open  →  addTask (real `sdlc.db` rows)
 *   scheduler.planStep (real BACKLOG→READY→ASSIGNED matrix)
 *   workerResult.deriveWorkerResult (real git diff owns truth)
 *   gates.runVerification (real gate runner, INJECTABLE executor)
 *   verifier.decideAcceptance (real decision table)
 *   integration.* (real `git merge --no-ff` into `sdlc/integration`)
 *
 * Every assertion in the eight tests is made against RUNTIME EVIDENCE ONLY:
 * git history, `sdlc.db` rows, `events`, `test_results`, `task_resources`,
 * `decisions` and the gate logs written under `.sdlc/verification/`.
 * Model prose is never asserted — a `MockLlm` response is parsed into a
 * structured decision exactly where the real Lead would have made one.
 *
 * Everything is offline and deterministic: temp git repos only, no network, no
 * real model, no `$DSH_HOME`, no workspace `.sdlc/`.
 */

import {
  makeRepo, git, writeFiles, cleanup, core,
} from '../lib/helpers.mjs';
import { join } from 'node:path';

// ── modules under test (loaded once) ───────────────────────────────────────

export const M = {
  config: await core.config(),
  project: await core.project(),
  runtime: await core.runtime(),
  scheduler: await core.scheduler(),
  stateMachine: await core.stateMachine(),
  complexity: await core.complexity(),
  budget: await core.budget(),
  risk: await core.risk(),
  gates: await core.gates(),
  verifier: await core.verifier(),
  workerResult: await core.workerResult(),
  integration: await core.integration(),
  loop: await core.loop(),
  router: await core.router(),
  escalation: await core.escalation(),
  recovery: await core.recovery(),
  presets: await core.presets(),
  mockLlm: await core.mockLlm(),
};

export const {
  defaultScenarios, MockLlm, parseMockModel, hashRequest,
} = M.mockLlm;

// ── deterministic gate runners ─────────────────────────────────────────────

/** Every gate command exits 0. */
export function passRunner() {
  return { status: 0, stdout: 'ok\n', stderr: '' };
}

/**
 * Fail the first `times` gate invocations with `message`, then pass.
 * The invocation order is the fail-fast GATE_ORDER of the selected gate list.
 */
export function failRunner({ message = 'gate failure', times = 1 } = {}) {
  let n = 0;
  return () => {
    n += 1;
    if (n <= times) return { status: 1, stdout: '', stderr: message };
    return { status: 0, stdout: 'ok\n', stderr: '' };
  };
}

// ── repo fixtures ──────────────────────────────────────────────────────────

/**
 * A minimal but realistic npm project. `package.json` is the shared resource
 * that Tests 2 and 6 collide on; `@playwright/test` makes `init` detect a
 * browser stack so e2e/visual gates exist. The lockfile is required: per the
 * spec F.5 table `package-lock.json` — not a bare `package.json` — is the
 * npm marker (`npm ci` needs it); without it this fixture is a markerless
 * workspace and explicit init fails rather than guessing.
 */
export const DEFAULT_REPO_FILES = {
  'package.json': JSON.stringify({
    name: 'sdlc-e2e-app',
    version: '1.0.0',
    private: true,
    scripts: { test: 'node --test', build: 'node -e "process.exit(0)"' },
    devDependencies: { '@playwright/test': '^1.44.0' },
  }, null, 2) + '\n',
  'package-lock.json': JSON.stringify({
    name: 'sdlc-e2e-app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'sdlc-e2e-app', version: '1.0.0' } },
  }, null, 2) + '\n',
  'src/app.js': 'export function app() { return 1; }\n',
  'src/app.css': '.btn { color: blue; }\n',
  'tests/app.test.mjs': "import { test } from 'node:test';\ntest('app', () => {});\n",
};

/**
 * Create an isolated real git repo, run the real `sdlc init`, open a real
 * Runtime and create a real project row.
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.files]
 * @param {object} [opts.configOverrides] deep-merged onto DEFAULT_CONFIG
 * @param {object} [opts.gateCommands]    merged over the detected gate commands
 * @param {Function} [opts.runner]        default injectable gate executor
 */
export async function createHarness({
  files = DEFAULT_REPO_FILES,
  configOverrides = {},
  gateCommands = {},
  runner = passRunner,
  prefix = 'sdlc-e2e-',
  useLock = true,
} = {}) {
  const repo = makeRepo(files, { prefix });
  const baseConfig = M.config.deepMerge(M.config.DEFAULT_CONFIG, configOverrides);

  const init = M.project.initProject({ projectRoot: repo, config: baseConfig });
  if (!init.ok) {
    cleanup(repo);
    throw new Error(`sdlc init failed in harness: ${init.error} — ${init.message}`);
  }

  const gates = { ...init.gateCommands, ...gateCommands };
  const config = M.config.deepMerge(baseConfig, { verification: { gates } });

  const runtime = new M.runtime.Runtime({ projectRoot: repo, config, useLock });
  runtime.open();

  const projectId = 'P-E2E';
  runtime.createProject({ id: projectId, name: 'sdlc-e2e', repoPath: repo });

  let closed = false;
  return {
    repo,
    projectId,
    config,
    init,
    gateCommands: gates,
    runtime,
    runner,
    /** Real path of the on-disk artifact/log evidence root. */
    verificationDir: join(repo, '.sdlc', 'verification'),
    close() {
      if (closed) return;
      closed = true;
      try { runtime.close(); } catch { /* best effort */ }
      cleanup(repo);
    },
  };
}

// ── DAG persistence ────────────────────────────────────────────────────────

/** Persist a task DAG through the runtime (real `tasks`/`task_resources` rows). */
export function addTasks(h, tasks, { projectId = h.projectId } = {}) {
  return tasks.map((t) => h.runtime.addTask({ project_id: projectId, ...t }));
}

/** Select the required gates for a task: declared verification, else risk-derived. */
export function gatesForTask(task, { uiChange = false, appearanceOnly = false, hasBrowserStack = true, gateCommands = {} } = {}) {
  if (Array.isArray(task.verification) && task.verification.length > 0) {
    return orderGates(task.verification);
  }
  return M.risk
    .requiredGates(task.risk_class, { uiChange, appearanceOnly, hasBrowserStack, gateCommands })
    .map((g) => g.gate);
}

export function orderGates(list) {
  const set = new Set(list);
  return M.risk.GATE_ORDER.filter((g) => set.has(g));
}

// ── the scheduler ──────────────────────────────────────────────────────────

/**
 * Run the real `scheduler.planStep` against the persisted DAG until it reaches
 * a fixed point, applying each transition through the real state service.
 * Returns the applied transitions (runtime evidence, also in `events`).
 */
export function schedule(h, {
  maxParallelWorkers = 4,
  maxSharedResourceTasks = 1,
  maxSteps = 50,
} = {}) {
  const applied = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const tasks = h.runtime.projectTasks(h.projectId);
    const transitions = M.scheduler.planStep(
      { tasks },
      { maxParallelWorkers, maxSharedResourceTasks },
    );
    if (transitions.length === 0) break;
    let any = false;
    for (const t of transitions) {
      const res = h.runtime.state.transition(t.taskId, t.to, t.actor, t.ctx);
      if (res.ok) {
        applied.push({ ...t, from: res.from });
        any = true;
      }
    }
    if (!any) break;
  }
  return applied;
}

/** Pure view of the scheduler's decision for the persisted DAG (no writes). */
export function planNow(h, opts = {}) {
  return M.scheduler.planStep({ tasks: h.runtime.projectTasks(h.projectId) }, opts);
}

// ── worker + verification ──────────────────────────────────────────────────

/**
 * Simulate a worker: check out a task branch from `sdlc/integration`, commit
 * the changed files, then return the AUTHORITATIVE `git diff --name-only`
 * (the diff owns truth — B.3.2). Leaves the repo on `sdlc/integration`.
 */
export function stageTaskWork(h, { taskId, files = {}, message = null, branch = `sdlc/task-${taskId}` } = {}) {
  git(['checkout', '-q', '-B', branch, 'sdlc/integration'], h.repo);
  writeFiles(h.repo, files);
  const paths = Object.keys(files);
  if (paths.length) git(['add', '--', ...paths], h.repo);
  git(['commit', '-q', '-m', message ?? `feat(${taskId}): task work`], h.repo);
  const filesChanged = git(['diff', '--name-only', `sdlc/integration...${branch}`], h.repo)
    .split('\n').map((l) => l.trim()).filter(Boolean);
  git(['checkout', '-q', 'sdlc/integration'], h.repo);
  return { branch, filesChanged };
}

/**
 * Drive one worker attempt through the real services:
 *   ASSIGNED → IN_PROGRESS (startWorkerRun) → VERIFYING (ingestResult)
 *   → gates.runVerification → verifier.decideAcceptance → ACCEPTED | FAILED.
 *
 * `filesChanged` must be the runtime-derived diff (never a worker claim).
 */
export function runAttempt(h, {
  taskId,
  filesChanged = [],
  contract = null,
  claim = { status: 'completed', summary: 'implemented as specified', evidence_claims: [], tests_run: [] },
  runRuntime = { exitCode: 0, turnEndReason: 'completed' },
  gateList = null,
  runner = h.runner,
  skipGates = [],
  review = null,
  blockedBySkippedGate = false,
  worktreePath = null,
  model = { provider: 'mock', id: 'mock/implement' },
} = {}) {
  const task = h.runtime.getTask(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const attempt = task.attempt ?? 0;

  const toRun = h.runtime.state.transition(taskId, 'IN_PROGRESS', 'worker-mgr', {});
  if (!toRun.ok) throw new Error(`${taskId} ASSIGNED→IN_PROGRESS rejected: ${toRun.reason}`);

  const runId = h.runtime.startWorkerRun({ taskId, attempt, model, worktreePath });

  const effectiveContract = contract ?? {
    allowed_paths: task.allowed_paths,
    forbidden_paths: task.forbidden_paths,
  };

  const outboxRaw = M.workerResult.buildOutbox({
    runId,
    taskId,
    attempt,
    nonce: `nonce-${taskId}-${attempt}`,
    claims: claim,
  });

  const ingested = h.runtime.ingestResult({
    runId,
    filesChanged,
    contract: effectiveContract,
    outboxRaw,
    runMeta: { runId, taskId, attempt },
    runtime: runRuntime,
  });
  const { result, scope } = ingested;

  const toVerify = h.runtime.state.transition(taskId, 'VERIFYING', 'worker-mgr', {});
  if (!toVerify.ok) throw new Error(`${taskId} IN_PROGRESS→VERIFYING rejected: ${toVerify.reason}`);

  const gates = gateList ?? gatesForTask(task, { gateCommands: h.gateCommands });
  const logDir = join(h.verificationDir, taskId);
  const gateResults = M.gates.runVerification({
    cwd: h.repo,
    gates,
    config: h.config,
    runner,
    taskId,
    logDir,
    skipGates,
    changedFiles: result.files_changed,
  });
  h.runtime.recordTestResults(taskId, runId, gateResults.gates);

  // The reference caller passes the risk-derived required set. Gates skipped
  // by explicit policy (skipGates) or absent from this task's configured list
  // are not required; everything else must be present AND passing.
  const requiredSpec = Array.isArray(task.verification) && task.verification.length > 0
    ? task.verification.map((gate) => ({ gate, required: true }))
    : M.risk.requiredGates(task.risk_class, { gateCommands: h.gateCommands });
  const requiredGates = requiredSpec
    .filter((g) => g.required)
    .map((g) => g.gate)
    .filter((gate) => gates.includes(gate) && !skipGates.includes(gate));

  const decision = M.verifier.decideAcceptance({
    riskClass: task.risk_class,
    requiredGates,
    gateResults: gateResults.gates,
    scope,
    review,
    filesChanged: result.files_changed,
    claims: {
      status: result.worker_claimed_status,
      __malformed: result.result_malformed,
      __suspect: result.suspect,
    },
    runtimeStatus: result.status,
    blockedBySkippedGate,
  });

  let settled = null;
  if (decision.accept) {
    settled = h.runtime.state.transition(taskId, 'ACCEPTED', 'verifier', { gatesPass: true });
  } else if (decision.status !== 'BLOCKED') {
    settled = h.runtime.state.transition(taskId, 'FAILED', 'verifier', {
      gatesPass: false,
      payload: { code: decision.code },
    });
  }

  return {
    taskId, attempt, runId, result, scope, gates, gateResults, decision, settled,
  };
}

// ── integration (real `git merge --no-ff`) ─────────────────────────────────

/**
 * Perform the real B.9 merge for an ACCEPTED task using the argv the
 * integration module emits, then tag `sdlc/accepted/<id>`.
 */
export function mergeAcceptedTask(h, { taskId, branch = `sdlc/task-${taskId}`, title = null } = {}) {
  const task = h.runtime.getTask(taskId);
  const merging = h.runtime.state.transition(taskId, 'MERGING', 'integration-mgr', { mergeSlotFree: true });
  if (!merging.ok) throw new Error(`${taskId} ACCEPTED→MERGING rejected: ${merging.reason}`);

  git(['checkout', '-q', 'sdlc/integration'], h.repo);
  const taskRef = { id: taskId, title: title ?? task.title, branch };
  const steps = M.integration.integrationSteps(taskRef);
  const mergeStep = steps.find((s) => s.step === 'merge');
  git(mergeStep.argv.slice(1), h.repo);

  const mergeCommit = git(['rev-parse', 'HEAD'], h.repo);
  const message = M.integration.mergeCommitMessage(taskRef);

  git(['tag', `sdlc/accepted/${taskId}`], h.repo);
  const done = h.runtime.state.transition(taskId, 'DONE', 'integration-mgr', {
    merged: true,
    postMergeGatesPass: true,
  });
  if (!done.ok) throw new Error(`${taskId} MERGING→DONE rejected: ${done.reason}`);

  return { branch, mergeCommit, message };
}

/** runAttempt then merge on acceptance; throws on rejection. */
export function completeTask(h, opts) {
  const attempt = runAttempt(h, opts);
  if (!attempt.decision.accept) {
    throw new Error(`task ${opts.taskId} was rejected: ${attempt.decision.code}`);
  }
  const merge = mergeAcceptedTask(h, { taskId: opts.taskId, branch: opts.branch });
  return { ...attempt, merge };
}

// ── team-composition rule (B.4) ────────────────────────────────────────────

/** Roles active for a project = distinct `task.role` values ∪ {lead}. */
export function activeRoles(tasks) {
  const roles = new Set(tasks.map((t) => t.role).filter(Boolean));
  roles.add('lead');
  return [...roles].sort();
}

/** Roles in the 26-role registry that carry no task in this DAG (must be zero). */
export function unnecessaryRoles(tasks) {
  const active = new Set(activeRoles(tasks));
  return M.presets.ROLES.filter((r) => !active.has(r.id)).map((r) => r.id);
}

// ── model-decision helper (MockLlm, never prose) ───────────────────────────

/** Parse a MockLlm JSON response into the structured decision the Lead would store. */
export function modelDecision(mock, model) {
  const response = mock.respond({ model });
  return { ...JSON.parse(response.text), __tokens: response.usage };
}

export function makeMock(overrides = {}) {
  return new MockLlm({ scenarios: { ...defaultScenarios(), ...overrides } });
}

// ── misc evidence helpers ──────────────────────────────────────────────────

const plain = (rows) => rows.map((r) => ({ ...r }));

export function gatewayEvidence(h, taskId) {
  return plain(h.runtime.db
    .prepare('SELECT gate, status, log_path, signature FROM test_results WHERE task_id = ? ORDER BY gate, rowid')
    .all(taskId));
}

export function resourceRows(h) {
  return plain(h.runtime.db
    .prepare('SELECT task_id, resource FROM task_resources ORDER BY task_id, resource')
    .all());
}

export function dependencyRows(h) {
  return plain(h.runtime.db
    .prepare('SELECT task_id, depends_on FROM task_dependencies ORDER BY task_id, depends_on')
    .all());
}

export function eventsFor(h, taskId) {
  return h.runtime.getEvents({ taskId });
}
