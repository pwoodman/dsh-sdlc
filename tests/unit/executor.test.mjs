/**
 * tests/unit/executor.test.mjs — the worker execution engine.
 *
 * The engine exists because `dispatchBatch` stops at ASSIGNED and the caller
 * that would launch a process was never written, so `worker_runs` stayed empty
 * and every downstream surface (gates, spend, Review) was structurally blank.
 *
 * These tests are offline and deterministic: a fake `spawn` stands in for
 * `ctx.subprocess`, so the process lifecycle (spawn → wait → timeout → kill),
 * the E5 credential-safe env map, exit classification and the durable
 * `worker_runs` row are all asserted without an OS process or a model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  planWorkerLaunch, runWorkerProcess, interpretWorkerOutcome, executeTask,
  buildTaskPrompt, attemptOf, resolveSession, DEFAULT_TIMEOUT_MS,
} from '../../packages/sdlc-core/src/executor.js';

const { core } = await import('../lib/helpers.mjs');
const { Runtime } = await core.runtime();
const { initProject } = await core.project();
const { loadConfig } = await core.config();

function tempWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-executor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Open the runtime against a REAL config (the same `loadConfig` the CLI and
 * the host plugin use). Hand-rolling a config here previously produced an
 * undefined model tier and failed at the SQLite bind — the engine must be
 * exercised against the shipping configuration, not a convenient fiction.
 */
function openRuntime(root) {
  const { config } = loadConfig(root);
  const runtime = new Runtime({ projectRoot: root, config, useLock: false });
  runtime.open();
  return runtime;
}

/**
 * A controllable stand-in for `ctx.subprocess.spawn`.
 * Records every spawn so tests can assert argv/env/cwd, and returns a handle
 * whose exit the test decides.
 */
function fakeSpawn({ stdout = '', stderr = '', exitCode = 0, signal = null, pid = 4242, throwOnSpawn = null } = {}) {
  const calls = [];
  const spawn = async (opts) => {
    calls.push(opts);
    if (throwOnSpawn) throw new Error(throwOnSpawn);
    return {
      pid,
      stdout,
      stderr,
      waitForExit: async () => ({ exitCode, signal }),
      terminate: () => { calls.push({ terminated: true }); },
    };
  };
  spawn.calls = calls;
  return spawn;
}

/** NDJSON as a real headless worker emits it. */
function ndjson({ reason = 'completed', text = 'done', usage = null } = {}) {
  const lines = [
    JSON.stringify({ type: 'session', id: 'sess-1' }),
    JSON.stringify({ type: 'text', text: 'working' }),
  ];
  if (usage) lines.push(JSON.stringify({ type: 'status', usage }));
  lines.push(JSON.stringify({ type: 'turn_end', reason }));
  lines.push(JSON.stringify({ type: 'final', text }));
  return lines.join('\n');
}

// ── launch contract (E5: the credential scrub) ────────────────────────────

test('the launch plan carries DSH_HOME explicitly — the scrub strips it otherwise', () => {
  const plan = planWorkerLaunch({
    task: { id: 'T-1', objective: 'x', attempt: 0 },
    projectRoot: '/tmp/p',
    worktreePath: '/tmp/p/.sdlc/worktrees/T-1',
    config: { dshHome: '/home/u/.dsh' },
  });
  // E5: ctx.subprocess removes every DSH_* name, so DSH_HOME must be passed
  // as an explicit string (a deliberate opt-in) or the worker cannot resolve
  // its own home.
  assert.equal(plan.env.DSH_HOME, '/home/u/.dsh');
  assert.equal(plan.env.PATH, process.env.PATH);
});

test('provider keys are NOT forwarded by default (credential-store auth)', () => {
  process.env.SDLC_TEST_FAKE_KEY = 'secret-value';
  try {
    const plan = planWorkerLaunch({
      task: { id: 'T-1', objective: 'x', attempt: 0 },
      projectRoot: '/tmp/p',
      worktreePath: '/tmp/w',
      config: { dshHome: '/tmp/dsh' },
    });
    assert.equal(plan.env.SDLC_TEST_FAKE_KEY, undefined);
    assert.equal(plan.contextManifest.credentialPolicy, 'credential-store');
    assert.deepEqual(plan.contextManifest.forwardedEnvKeys, []);
  } finally {
    delete process.env.SDLC_TEST_FAKE_KEY;
  }
});

test('an explicit workerEnvKeys opt-in is forwarded AND audited', () => {
  process.env.SDLC_TEST_FAKE_KEY = 'secret-value';
  try {
    const plan = planWorkerLaunch({
      task: { id: 'T-1', objective: 'x', attempt: 0 },
      projectRoot: '/tmp/p',
      worktreePath: '/tmp/w',
      config: { dshHome: '/tmp/dsh', execution: { workerEnvKeys: ['SDLC_TEST_FAKE_KEY'] } },
    });
    assert.equal(plan.env.SDLC_TEST_FAKE_KEY, 'secret-value');
    assert.equal(plan.contextManifest.credentialPolicy, 'env-keys');
    assert.deepEqual(plan.contextManifest.forwardedEnvKeys, ['SDLC_TEST_FAKE_KEY']);
  } finally {
    delete process.env.SDLC_TEST_FAKE_KEY;
  }
});

test('argv is argv-based (never a shell string) and carries the one-shot profile', () => {
  const plan = planWorkerLaunch({
    task: { id: 'T-1', objective: 'add auth', attempt: 0 },
    projectRoot: '/tmp/p',
    worktreePath: '/tmp/w',
    tierOverlay: '/tmp/tier.yml',
    config: {},
  });
  assert.ok(Array.isArray(plan.argv));
  assert.equal(plan.argv[0], 'dsh');
  assert.equal(plan.argv[1], '--profile');
  assert.equal(plan.argv[2], 'sdlc-worker');
  assert.ok(plan.argv.includes('--patch'));
  assert.ok(plan.argv.includes('/tmp/tier.yml'));
  assert.ok(plan.argv.includes('--json'));
  assert.ok(plan.argv.at(-1).includes('add auth'));
});

test('the prompt carries the objective, ACs and allowed paths verbatim', () => {
  const prompt = buildTaskPrompt({
    id: 'T-9', objective: 'Fix the leak',
    acceptance_criteria: [{ id: 'AC-1', text: 'no leak' }],
    allowed_paths: ['src/**'],
  });
  assert.ok(prompt.includes('Fix the leak'));
  assert.ok(prompt.includes('AC-1: no leak'));
  assert.ok(prompt.includes('src/**'));
  assert.ok(prompt.includes('.sdlc/task-outbox.json'));
});

// ── process lifecycle ─────────────────────────────────────────────────────

test('a spawned worker is waited on and its exit is returned', async () => {
  const spawn = fakeSpawn({ stdout: ndjson(), exitCode: 0 });
  const raw = await runWorkerProcess({
    spawn, argv: ['dsh'], cwd: '/tmp/w', env: { PATH: '/bin' }, timeoutMs: 1000,
  });
  assert.equal(raw.exitCode, 0);
  assert.equal(raw.pid, 4242);
  assert.equal(raw.timedOut, false);
  assert.equal(spawn.calls[0].cwd, '/tmp/w');
});

test('a throwing spawn becomes a described failure, never a silent skip', async () => {
  const spawn = fakeSpawn({ throwOnSpawn: 'spawn dsh ENOENT' });
  const raw = await runWorkerProcess({ spawn, argv: ['dsh'], cwd: '/tmp/w', env: {} });
  assert.equal(raw.spawnError, 'spawn dsh ENOENT');
  assert.equal(raw.exitCode, null);
});

test('no spawn function is reported, not crashed', async () => {
  const raw = await runWorkerProcess({ spawn: null, argv: ['dsh'], cwd: '/tmp/w', env: {} });
  assert.equal(raw.spawnError, 'no spawn function provided');
});

// ── exit classification ───────────────────────────────────────────────────

test('exit 0 with a completed turn_end is completed', () => {
  const out = interpretWorkerOutcome({ stdout: ndjson({ reason: 'completed' }), exitCode: 0 });
  assert.equal(out.status, 'completed');
  assert.equal(out.finalText, 'done');
});

test('exit 1 with no turn_end reason is failed', () => {
  // classifyExit: exit 0 + completed ⇒ completed; anything else is failed
  // unless the worker's own stream declares the abort.
  const out = interpretWorkerOutcome({
    stdout: JSON.stringify({ type: 'final', text: 'boom' }),
    exitCode: 1,
  });
  assert.equal(out.status, 'failed');
});

test('a worker that reports its own abort is aborted, not failed', () => {
  const out = interpretWorkerOutcome({ stdout: ndjson({ reason: 'aborted' }), exitCode: 1 });
  assert.equal(out.status, 'aborted');
});

test('a timeout is classified timeout even with exit 0', () => {
  const out = interpretWorkerOutcome({ stdout: ndjson(), exitCode: 0, timedOut: true });
  assert.equal(out.status, 'timeout');
});

test('SIGTERM is aborted and SIGKILL is timeout', () => {
  assert.equal(interpretWorkerOutcome({ stdout: '', exitCode: null, signal: 'SIGTERM' }).status, 'aborted');
  assert.equal(interpretWorkerOutcome({ stdout: '', exitCode: null, signal: 'SIGKILL' }).status, 'timeout');
});

test('tokens and cost are read from the worker usage event', () => {
  const out = interpretWorkerOutcome({
    stdout: ndjson({ usage: { in: 120, out: 340, costUsd: 0.0042 } }),
    exitCode: 0,
  });
  assert.deepEqual(out.tokens, { in: 120, out: 340 });
  assert.equal(out.costUsd, 0.0042);
});

test('missing usage leaves tokens null — never a fabricated zero', () => {
  const out = interpretWorkerOutcome({ stdout: ndjson(), exitCode: 0 });
  assert.equal(out.tokens, null);
  assert.equal(out.costUsd, null);
});

// ── resume rule (E8) ──────────────────────────────────────────────────────

test('a first attempt starts a fresh session', () => {
  const r = resolveSession({ task: { attempt: 0 } });
  assert.equal(r.sessionId, null);
  assert.equal(r.fresh, true);
  assert.equal(r.reason, 'first-attempt');
});

test('a retry resumes the same session while the worktree is unchanged', () => {
  const r = resolveSession({ task: { attempt: 1 }, sessionId: 'sess-9' });
  assert.equal(r.sessionId, 'sess-9');
  assert.equal(r.fresh, false);
});

test('a recreated worktree starts fresh instead of resuming', () => {
  const r = resolveSession({ task: { attempt: 2 }, sessionId: 'sess-9', worktreeRecreated: true });
  assert.equal(r.sessionId, null);
  assert.equal(r.reason, 'worktree-recreated');
});

test('attemptOf defaults to 0 for a missing attempt', () => {
  assert.equal(attemptOf({}), 0);
  assert.equal(attemptOf({ attempt: 3 }), 3);
  assert.equal(attemptOf({ attempt: -1 }), 0);
});

// ── end-to-end against a real runtime and DB ──────────────────────────────

test('executeTask writes a real worker_runs row and records the outcome', async (t) => {
  const root = tempWorkspace(t);
  initProject({ projectRoot: root, undetected: 'manual', createBranch: false });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));

  const project = runtime.createProject({ name: 'p', repoPath: root });
  const task = runtime.addTask({
    project_id: project.id, id: 'T-EXEC-1', title: 'do work',
    objective: 'do the work', role: 'implementer',
  });
  runtime.transition(task.id, 'READY', 'scheduler', {});
  runtime.transition(task.id, 'ASSIGNED', 'scheduler', { locks: [], available: true });

  const spawn = fakeSpawn({ stdout: ndjson({ usage: { in: 10, out: 20, costUsd: 0.001 } }), exitCode: 0 });
  const worktree = join(root, '.sdlc', 'worktrees', task.id);
  const report = await executeTask({
    runtime, task: runtime.getTask(task.id), spawn, worktreePath: worktree,
    projectRoot: root, config: runtime.config,
  });

  assert.ok(report.runId, 'a run id is returned');
  const row = runtime.getWorkerRun(report.runId);
  assert.ok(row, 'the worker_runs row exists');
  assert.equal(row.task_id, 'T-EXEC-1');
  assert.equal(row.attempt, 0);
  assert.equal(row.exit_code, 0);
  assert.ok(row.started_at && row.finished_at, 'the run is bracketed in time');
  // The nonce is persisted so outbox provenance can be checked later.
  assert.ok(row.context_manifest?.nonce, 'the nonce is recorded for provenance');
});

test('the run is persisted as running BEFORE the process is spawned', async (t) => {
  const root = tempWorkspace(t);
  initProject({ projectRoot: root, undetected: 'manual', createBranch: false });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));
  const project = runtime.createProject({ name: 'p', repoPath: root });
  const task = runtime.addTask({
    project_id: project.id, id: 'T-EXEC-2', title: 'w', objective: 'w',
    role: 'implementer',
  });
  runtime.transition('T-EXEC-2', 'READY', 'scheduler', {});
  runtime.transition('T-EXEC-2', 'ASSIGNED', 'scheduler', { locks: [], available: true });

  // A crash mid-run must still leave a trace: assert the row already exists at
  // spawn time, which is what makes orphan recovery possible.
  let rowsAtSpawn = null;
  const spawn = async () => {
    rowsAtSpawn = runtime.listWorkerRuns({ taskId: 'T-EXEC-2' }).length;
    return {
      pid: 1, stdout: ndjson(), stderr: '',
      waitForExit: async () => ({ exitCode: 0, signal: null }),
      terminate: () => {},
    };
  };

  await executeTask({
    runtime, task: runtime.getTask(task.id), spawn,
    worktreePath: join(root, '.sdlc', 'worktrees', task.id),
    projectRoot: root, config: runtime.config,
  });

  assert.equal(rowsAtSpawn, 1, 'the row is inserted before spawn');
});

test('a spawn failure is persisted as a failed run with its reason', async (t) => {
  const root = tempWorkspace(t);
  initProject({ projectRoot: root, undetected: 'manual', createBranch: false });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));
  const project = runtime.createProject({ name: 'p', repoPath: root });
  const task = runtime.addTask({
    project_id: project.id, id: 'T-EXEC-3', title: 'w', objective: 'w',
    role: 'implementer',
  });
  runtime.transition('T-EXEC-3', 'READY', 'scheduler', {});
  runtime.transition('T-EXEC-3', 'ASSIGNED', 'scheduler', { locks: [], available: true });

  const spawn = fakeSpawn({ throwOnSpawn: 'ENOENT: dsh not found' });
  const report = await executeTask({
    runtime, task: runtime.getTask(task.id), spawn,
    worktreePath: join(root, '.sdlc', 'worktrees', task.id),
    projectRoot: root, config: runtime.config,
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'failed');
  const row = runtime.getWorkerRun(report.runId);
  assert.equal(row.status, 'failed');
  assert.ok(String(row.result_json).includes('ENOENT'), 'the reason is on the row');
});

test('the worker NDJSON stream is written to the evidence log', async (t) => {
  const root = tempWorkspace(t);
  initProject({ projectRoot: root, undetected: 'manual', createBranch: false });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));
  const project = runtime.createProject({ name: 'p', repoPath: root });
  const task = runtime.addTask({
    project_id: project.id, id: 'T-EXEC-4', title: 'w', objective: 'w',
    role: 'implementer',
  });
  runtime.transition('T-EXEC-4', 'READY', 'scheduler', {});
  runtime.transition('T-EXEC-4', 'ASSIGNED', 'scheduler', { locks: [], available: true });

  const spawn = fakeSpawn({ stdout: ndjson({ text: 'evidence-marker' }), stderr: 'warn-line', exitCode: 0 });
  const report = await executeTask({
    runtime, task: runtime.getTask(task.id), spawn,
    worktreePath: join(root, '.sdlc', 'worktrees', task.id),
    projectRoot: root, config: runtime.config,
  });

  assert.ok(existsSync(report.logPath), 'the log file exists');
  const body = readFileSync(report.logPath, 'utf8');
  assert.ok(body.includes('evidence-marker'));
  assert.ok(body.includes('warn-line'));
});

test('dryRun plans the launch without spawning or recording', async (t) => {
  const root = tempWorkspace(t);
  initProject({ projectRoot: root, undetected: 'manual', createBranch: false });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));

  const spawn = fakeSpawn({});
  const report = await executeTask({
    runtime, task: { id: 'T-DRY', objective: 'x', attempt: 0 }, spawn,
    worktreePath: join(root, '.sdlc', 'worktrees', 'T-DRY'),
    projectRoot: root, config: runtime.config, dryRun: true,
  });

  assert.equal(report.dryRun, true);
  assert.ok(Array.isArray(report.argv));
  assert.equal(spawn.calls.length, 0, 'nothing was spawned');
  assert.equal(runtime.listWorkerRuns().length, 0, 'nothing was recorded');
});

test('executeTask refuses a missing runtime instead of half-running', async () => {
  await assert.rejects(
    () => executeTask({ runtime: null, task: { id: 'T-1' } }),
    /runtime is required/,
  );
});

test('the timeout default is a real bound, not unlimited', () => {
  assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS));
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
});
