/**
 * tests/unit/run-loop.test.mjs — the production scheduler tick.
 *
 * This is the suite that pins the product's actual promise: one `advanceFlow`
 * call takes a READY task through a REAL worker process launch, a REAL git
 * worktree, real gates in a real child process, the real acceptance decision,
 * the verifier's transition — and (for R1) the real `git merge --no-ff` into
 * `sdlc/integration`, landing DONE.
 *
 * The only fake is the `dsh` binary itself: the injected `spawn` maps the
 * worker launch onto a real `node` child, so process lifecycle, NDJSON
 * parsing, git and the gate child are all real. A second wave exercises
 * dependency ordering (a dependent task unlocks and runs after its dependency
 * lands DONE).
 *
 * R2 work intentionally ends `awaitingReview`: independent review above R1 is
 * a human/reviewer input the loop must not fabricate (L.1 rule 3) — the task
 * stays VERIFYING and the report says why.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn as cpSpawn } from 'node:child_process';

import { advanceFlow, gateSpecFor } from '../../packages/sdlc-core/src/run-loop.js';

const { core } = await import('../lib/helpers.mjs');
const { Runtime } = await core.runtime();
const { initProject } = await core.project();
const { loadConfig, deepMerge, dumpConfigYaml } = await core.config();

function tempWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-runloop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * The fake `dsh`: a real node child that plays the headless worker — emits
 * NDJSON with usage, writes a NON-PRODUCTION file (work-log.md) in its cwd
 * (the task worktree), and exits 0. Any other argv (git, gates-child) runs
 * as the real binary.
 */
const WORKER_PATH = join(tmpdir(), 'sdlc-runloop-worker.mjs');

function writeWorkerScript({ fail = false } = {}) {
  const lines = [];
  if (!fail) {
    lines.push("import { appendFileSync } from 'node:fs';");
    lines.push("appendFileSync('work-log.md', 'worker ran\\n');");
  }
  lines.push("process.stdout.write(JSON.stringify({ type: 'session', id: 'sess-w1' }) + '\\n');");
  lines.push("process.stdout.write(JSON.stringify({ type: 'status', usage: { in: 100, out: 50, costUsd: 0.002 } }) + '\\n');");
  lines.push(`process.stdout.write(JSON.stringify({ type: 'turn_end', reason: ${fail ? "'error'" : "'completed'"} }) + '\\n');`);
  if (!fail) {
    // The prompt's fallback reporting channel: a fenced sdlc-result block in
    // the final message. This is what a real worker that does not know its
    // run identity emits.
    lines.push("const claims = JSON.stringify({ status: 'completed', summary: 'appended to work-log', evidence_claims: [], tests_run: [], requests: [] });");
    lines.push("const finalText = `done\\n\\`\\`\\`sdlc-result\\n${claims}\\n\\`\\`\\``;");
    lines.push("process.stdout.write(JSON.stringify({ type: 'final', text: finalText }) + '\\n');");
  }
  lines.push(`process.exit(${fail ? 1 : 0});`);
  writeFileSync(WORKER_PATH, `${lines.join('\n')}\n`);
}

/** spawn({argv,cwd,env}) → handle, mapping the worker's `dsh` onto node. */
function dshToNodeSpawn({ workerPath = WORKER_PATH } = {}) {
  return async ({ argv, cwd, env }) => {
    const mapped = argv[0] === 'dsh' ? [process.execPath, workerPath, ...argv.slice(1)] : argv;
    const child = cpSpawn(mapped[0], mapped.slice(1), { cwd, env: { ...(env ?? {}) } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    return {
      pid: child.pid,
      get stdout() { return stdout; },
      get stderr() { return stderr; },
      waitForExit: () => new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
      }),
      terminate: (sig) => { try { child.kill(sig); } catch { /* gone */ } },
    };
  };
}

/** A real repo with an integration branch and a real, fast unit gate. */
function makeRepo(t, { gates = null } = {}) {
  const root = tempWorkspace(t);
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@sdlc.local'], root);
  git(['config', 'user.name', 'sdlc test'], root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'runloop-fixture', private: true,
  }));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'smoke.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('smoke', () => { assert.ok(true); });\n");
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'fixture'], root);
  initProject({ projectRoot: root, undetected: 'manual', createBranch: true });
  if (gates) writeGates(root, gates);
  return root;
}

/** Author the verification gates the way a user would: merged + re-dumped. */
function writeGates(root, gates) {
  const cfgPath = join(root, '.sdlc', 'config.yml');
  const { config } = loadConfig(root);
  const next = deepMerge(config, { verification: { gateTimeoutMs: 60000, gates } });
  writeFileSync(cfgPath, dumpConfigYaml(next));
}

// Node 24: `--test` args are glob patterns, not directories — `test/` would
// be executed as a module entry and fail. The glob is node's own.
const UNIT_GATE = { command: ['node', '--test', 'test/*.test.mjs'], timeoutMs: 60000 };

function openRuntime(root) {
  const { config } = loadConfig(root);
  const runtime = new Runtime({ projectRoot: root, config, useLock: false });
  runtime.open();
  return runtime;
}

test('gateSpecFor: task-pinned verification list wins over risk defaults', () => {
  const spec = gateSpecFor({ risk_class: 'R2', verification: ['unit'] }, {});
  assert.deepEqual(spec, [{ gate: 'unit', required: true }]);
  const fallback = gateSpecFor({ risk_class: 'R1' }, {});
  assert.ok(fallback.length > 0, 'risk defaults still apply when the task pins none');
});

test('advanceFlow runs a READY task to DONE through a real process, worktree, gates and merge', async (t) => {
  writeWorkerScript();
  const root = makeRepo(t, { gates: { unit: UNIT_GATE } });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));

  const project = runtime.createProject({ name: 'p', repoPath: root });
  // R1 + a pinned gate list: no independent review required, so the loop can
  // reach ACCEPTED and the real merge can land DONE.
  runtime.addTask({
    project_id: project.id, id: 'T-R1', title: 'append work', objective: 'append a line',
    role: 'implementer', risk_class: 'R1', verification: ['unit'], allowed_paths: ['**'],
  });
  const queued = runtime.transition('T-R1', 'READY', 'scheduler', { deps: [], depStates: {} });
  assert.ok(queued.ok, `queue rejected: ${queued.reason}`);

  const { report, completion } = await advanceFlow({
    runtime, projectRoot: root, spawn: dshToNodeSpawn(), projectId: project.id,
    maxParallel: 2, config: runtime.config,
  });
  const settled = await completion;
  assert.ok(settled === report);

  // The task landed DONE through the real chain.
  const row = runtime.getTask('T-R1');
  assert.equal(row.state, 'DONE', `task state is ${row.state}`);
  assert.equal(report.dispatched.length, 1);
  assert.equal(report.executed[0].taskId, 'T-R1');
  assert.equal(report.executed[0].status, 'completed');
  assert.ok(report.executed[0].runId, 'a real run id is reported');

  // A real worker_runs row with real usage.
  const run = runtime.getWorkerRun(report.executed[0].runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.tokens_in, 100);
  assert.equal(run.tokens_out, 50);

  // Real gate evidence recorded from the real child process.
  const gates = runtime.db.prepare('SELECT gate, status FROM test_results WHERE task_id = ?').all('T-R1');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].gate, 'unit');
  assert.ok(String(gates[0].status).startsWith('pass'), `unit status ${gates[0].status}`);

  // The merge really happened on the integration branch.
  const merged = git(['log', '--oneline', 'sdlc/integration'], root);
  assert.match(merged, /T-R1/);

  // The worktree exists and the worker's change is in it.
  const workLog = join(root, '.sdlc', 'worktrees', 'T-R1', 'work-log.md');
  assert.equal(readFileSync(workLog, 'utf8'), 'worker ran\n');
});

test('advanceFlow holds green R2 work in VERIFYING as awaitingReview — no fabricated reviewer', async (t) => {
  writeWorkerScript();
  const root = makeRepo(t, { gates: { unit: UNIT_GATE } });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));

  const project = runtime.createProject({ name: 'p', repoPath: root });
  runtime.addTask({
    project_id: project.id, id: 'T-R2', title: 'r2 work', objective: 'append a line',
    role: 'implementer', risk_class: 'R2', verification: ['unit'], allowed_paths: ['**'],
  });
  runtime.transition('T-R2', 'READY', 'scheduler', { deps: [], depStates: {} });

  const { report, completion } = await advanceFlow({
    runtime, projectRoot: root, spawn: dshToNodeSpawn(), projectId: project.id,
    maxParallel: 2, config: runtime.config, integrate: true,
  });
  await completion;

  const row = runtime.getTask('T-R2');
  assert.equal(row.state, 'VERIFYING', 'green R2 work waits for review, it is not failed');
  assert.equal(report.awaitingReview.length, 1);
  assert.equal(report.awaitingReview[0].taskId, 'T-R2');
  assert.equal(report.integrated.length, 0, 'unreviewed work is never merged');
});

test('advanceFlow waves through a dependency chain: the child unlocks and runs after the parent', async (t) => {
  writeWorkerScript();
  const root = makeRepo(t, { gates: { unit: UNIT_GATE } });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));

  const project = runtime.createProject({ name: 'p', repoPath: root });
  runtime.addTask({
    project_id: project.id, id: 'T-P', title: 'parent', objective: 'append a line',
    role: 'implementer', risk_class: 'R1', verification: ['unit'], allowed_paths: ['**'],
  });
  runtime.addTask({
    project_id: project.id, id: 'T-C', title: 'child', objective: 'append another line',
    role: 'implementer', risk_class: 'R1', verification: ['unit'], allowed_paths: ['**'], depends_on: ['T-P'],
  });
  runtime.transition('T-P', 'READY', 'scheduler', { deps: [], depStates: {} });
  assert.equal(runtime.getTask('T-C').state, 'BACKLOG', 'the child starts in the backlog');

  const { report, completion } = await advanceFlow({
    runtime, projectRoot: root, spawn: dshToNodeSpawn(), projectId: project.id,
    maxParallel: 2, config: runtime.config,
  });
  await completion;

  assert.equal(runtime.getTask('T-P').state, 'DONE');
  assert.equal(runtime.getTask('T-C').state, 'DONE');
  assert.equal(report.executed.length, 2, 'both tasks executed');
});

test('a failing gate fails the task honestly with the gate as evidence', async (t) => {
  writeWorkerScript();
  const root = makeRepo(t, { gates: { syntax: { command: ['node', '-e', 'process.exit(1)'], timeoutMs: 60000 } } });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));

  const project = runtime.createProject({ name: 'p', repoPath: root });
  runtime.addTask({
    project_id: project.id, id: 'T-F', title: 'bad gate', objective: 'append a line',
    role: 'implementer', risk_class: 'R1', verification: ['syntax'], allowed_paths: ['**'],
  });
  runtime.transition('T-F', 'READY', 'scheduler', { deps: [], depStates: {} });

  const { report, completion } = await advanceFlow({
    runtime, projectRoot: root, spawn: dshToNodeSpawn(), projectId: project.id,
    maxParallel: 2, config: runtime.config,
  });
  await completion;

  assert.equal(runtime.getTask('T-F').state, 'FAILED');
  assert.equal(report.verified[0].decision, 'GATE_FAILED');
  const gates = runtime.db.prepare('SELECT gate, status FROM test_results WHERE task_id = ?').all('T-F');
  assert.ok(String(gates[0].status).startsWith('fail'), 'the failing gate is recorded');
});

test('a worker that fails leaves a FAILED task and a real run row — retryable', async (t) => {
  writeWorkerScript({ fail: true });
  const root = makeRepo(t, { gates: { unit: UNIT_GATE } });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));

  const project = runtime.createProject({ name: 'p', repoPath: root });
  runtime.addTask({
    project_id: project.id, id: 'T-X', title: 'crash', objective: 'append a line',
    role: 'implementer', risk_class: 'R1', verification: ['unit'], allowed_paths: ['**'],
  });
  runtime.transition('T-X', 'READY', 'scheduler', { deps: [], depStates: {} });

  const { report, completion } = await advanceFlow({
    runtime, projectRoot: root, spawn: dshToNodeSpawn(), projectId: project.id,
    maxParallel: 2, config: runtime.config,
  });
  await completion;

  assert.equal(runtime.getTask('T-X').state, 'FAILED');
  assert.equal(report.executed[0].status, 'failed');
  const run = runtime.getWorkerRun(report.executed[0].runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.exit_code, 1);
  // The failed task is retryable through the scheduler's own row.
  const row = runtime.getTask('T-X');
  const retry = runtime.transition('T-X', 'READY', 'scheduler', {
    attempt: row.attempt, retryBudget: row.retry_budget,
  });
  assert.ok(retry.ok, `retry rejected: ${retry.reason}`);
});

test('inFlight dedupe: a second tick never double-executes a running task', async (t) => {
  writeWorkerScript();
  const root = makeRepo(t, { gates: { unit: UNIT_GATE } });
  const runtime = openRuntime(root);
  t.after(() => runtime.close({ releaseLock: false }));

  const project = runtime.createProject({ name: 'p', repoPath: root });
  runtime.addTask({
    project_id: project.id, id: 'T-D', title: 'dedupe', objective: 'append a line',
    role: 'implementer', risk_class: 'R1', verification: ['unit'], allowed_paths: ['**'],
  });
  runtime.transition('T-D', 'READY', 'scheduler', { deps: [], depStates: {} });

  const inFlight = new Map();
  const opts = {
    runtime, projectRoot: root, spawn: dshToNodeSpawn(), projectId: project.id,
    maxParallel: 2, config: runtime.config, inFlight,
  };
  const first = await advanceFlow(opts);
  const second = await advanceFlow(opts);
  await Promise.all([first.completion, second.completion]);

  const runs = runtime.listWorkerRuns({ taskId: 'T-D' });
  assert.equal(runs.length, 1, `expected exactly one run, saw ${runs.length}`);
  assert.equal(runtime.getTask('T-D').state, 'DONE');
});
