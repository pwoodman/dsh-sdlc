/**
 * tests/unit/ui-execution.test.mjs — the panel's execution tier.
 *
 * The spawn adapter is tested against REAL child processes (node -e): the
 * handle contract (stdout/stderr getters, waitForExit, terminate, the
 * described-not-thrown ENOENT) is exactly what the executor awaits, so a
 * regression here is a broken worker launch everywhere.
 *
 * The execution service is tested with a fake spawn through a real Runtime:
 * one advance tick takes a READY task through a real worker launch, records
 * the run, and settles the lifecycle — the panel-side proof that "dispatch"
 * now means "a worker actually ran".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostSpawn } from '../../packages/sdlc-client-ui/src/server/spawn-adapter.js';
import { createExecutionService } from '../../packages/sdlc-client-ui/src/server/execution.js';

const { core, tempDir, cleanup } = await import('../lib/helpers.mjs');
const runtimeMod = await core.runtime();
const cfgMod = await core.config();

test('the node spawn adapter returns the handle contract the executor awaits', async () => {
  const spawn = hostSpawn(null);
  const handle = await spawn({
    argv: [process.execPath, '-e', 'process.stdout.write("out"); process.stderr.write("err");'],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
  });
  assert.ok(handle.pid, 'a real pid');
  const outcome = await handle.waitForExit();
  assert.equal(outcome.exitCode, 0);
  assert.equal(handle.stdout, 'out');
  assert.equal(handle.stderr, 'err');
  const read = await handle.readOutput();
  assert.equal(read.stdout, 'out');
});

test('a missing binary becomes a described failure on the handle, not a crash', async () => {
  const spawn = hostSpawn(null);
  const handle = await spawn({
    argv: ['/nonexistent/binary/that/cannot/exist', '--flag'],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
  });
  const outcome = await handle.waitForExit();
  assert.equal(outcome.exitCode, null);
  assert.match(outcome.error, /nonexistent|ENOENT/i, 'the spawn error is described');
});

test('terminate stops a long-running child', async () => {
  const spawn = hostSpawn(null);
  const handle = await spawn({
    argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
  });
  assert.ok(handle.pid);
  handle.terminate('SIGTERM');
  const outcome = await handle.waitForExit();
  assert.equal(outcome.signal, 'SIGTERM');
});

test('the execution service advances a READY task through a real worker launch', async (t) => {
  const dir = tempDir('sdlc-execsvc-');
  t.after(() => cleanup(dir));
  // A real git repo with one commit: the executor provisions a real worktree.
  execGit(['init', '-q', '-b', 'main'], dir);
  execGit(['config', 'user.email', 't@sdlc.local'], dir);
  execGit(['config', 'user.name', 'sdlc test'], dir);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  execGit(['add', '-A'], dir);
  execGit(['commit', '-q', '-m', 'fixture'], dir);

  const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
  const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
  runtime.open();
  try {
    runtime.createProject({ id: 'P1', name: 'svc', repoPath: dir });
    runtime.addTask({ id: 'T-SVC', project_id: 'P1', title: 'svc work', role: 'implementer', risk_class: 'R1' });
    runtime.transition('T-SVC', 'READY', 'scheduler', { deps: [], depStates: {} });
  } finally { runtime.close({ releaseLock: false }); }

  // A worker that starts, reports usage, and fails: the service must record
  // the run and settle the task to FAILED — a REAL row, honestly classified.
  const workerScript = join(tmpdir(), 'sdlc-execsvc-worker.mjs');
  writeFileSync(workerScript, [
    "process.stdout.write(JSON.stringify({ type: 'session', id: 's' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'status', usage: { in: 10, out: 5, costUsd: 0.001 } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'turn_end', reason: 'error' }) + '\\n');",
    'process.exit(1);',
  ].join('\n'));
  const spawn = async ({ argv, cwd, env }) => hostSpawn(null)({
    argv: argv[0] === 'dsh' ? [process.execPath, workerScript, ...argv.slice(1)] : argv,
    cwd, env,
  });

  const service = createExecutionService({ spawn });
  const advanced = await service.advance({ projectRoot: dir, projectId: 'P1' });
  assert.equal(advanced.report.dispatched.length, 1, 'the READY task was dispatched');
  await advanced.completion;

  const check = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
  check.open();
  try {
    assert.equal(check.getTask('T-SVC').state, 'FAILED', 'the failed worker settled the task');
    const runs = check.listWorkerRuns({ taskId: 'T-SVC' });
    assert.equal(runs.length, 1, 'exactly one worker run is recorded');
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].exit_code, 1);
    assert.equal(runs[0].tokens_in, 10, 'the worker-reported usage landed on the row');
  } finally { check.close({ releaseLock: false }); }
});

test('advance on a workspace without .sdlc resolves into an empty report, never a crash', async (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'sdlc-execsvc-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const service = createExecutionService({ spawn: hostSpawn(null) });
  const advanced = await service.advance({ projectRoot: empty });
  assert.equal(advanced.report.dispatched.length, 0);
  assert.ok(advanced.report.skipped.length > 0, 'the missing project is reported');
  await advanced.completion;
});

/** git helper that throws on failure — setup must not silently skip. */
import { execFileSync } from 'node:child_process';
function execGit(args, cwd) {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── the ctx.subprocess branch (P25) ────────────────────────────────────────

test('the adapter prefers ctx.subprocess and normalizes its handle', async () => {
  const calls = [];
  const serviceSpawn = async (opts) => {
    calls.push(opts);
    return {
      pid: 4242,
      stdout: 'service-out',
      waitForExit: async () => ({ exitCode: 0, signal: null }),
      terminate: () => {},
    };
  };
  const spawn = hostSpawn({ subprocess: { spawn: serviceSpawn } });
  const handle = await spawn({ argv: ['dsh', '--profile', 'sdlc-worker'], cwd: tmpdir(), env: {} });
  assert.equal(handle.pid, 4242);
  assert.equal((await handle.waitForExit()).exitCode, 0);
  assert.equal(handle.stdout, 'service-out');
  const read = await handle.readOutput();
  assert.equal(read.stdout, 'service-out');
  assert.deepEqual(calls[0].argv, ['dsh', '--profile', 'sdlc-worker']);
});

test('a ctx.subprocess handle without readOutput falls back to its fields', async () => {
  const spawn = hostSpawn({ subprocess: { spawn: async () => ({ pid: 1, stdout: 'x', stderr: 'y', waitForExit: async () => ({ exitCode: 3 }) }) } });
  const handle = await spawn({ argv: ['dsh'], cwd: tmpdir(), env: {} });
  const outcome = await handle.waitForExit();
  assert.equal(outcome.exitCode, 3);
  const read = await handle.readOutput();
  assert.equal(read.stdout, 'x');
  assert.equal(read.stderr, 'y');
});

test('a service handle with only an exit value still resolves', async () => {
  const spawn = hostSpawn({ subprocess: { spawn: async () => ({ pid: 9, exited: { exitCode: 7 } }) } });
  const handle = await spawn({ argv: ['dsh'], cwd: tmpdir(), env: {} });
  assert.equal((await handle.waitForExit()).exitCode, 7);
});

test('a ctx whose service read throws falls back to the node adapter', async () => {
  const hostile = new Proxy({}, {
    get() { throw new Error('cannot get property "subprocess" without inject'); },
  });
  const spawn = hostSpawn(hostile);
  const handle = await spawn({
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
  });
  assert.equal((await handle.waitForExit()).exitCode, 0);
});

test('waitForExit after the child already exited resolves immediately', async () => {
  const spawn = hostSpawn(null);
  const handle = await spawn({
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((await handle.waitForExit()).exitCode, 0, 'the already-exited branch is taken');
});

test('a service that throws surfaces the error as a rejected spawn', async () => {
  const spawn = hostSpawn({ subprocess: { spawn: async () => { throw new Error('service refused'); } } });
  await assert.rejects(() => spawn({ argv: ['dsh'], cwd: tmpdir(), env: {} }), /service refused/);
});
