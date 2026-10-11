/**
 * tests/unit/cli.test.mjs — the `sdlc` control plane (packages/sdlc-cli/src/cli.mjs).
 *
 * The CLI is exercised the way a user runs it: as a REAL child process through
 * `node packages/sdlc-cli/bin/sdlc.mjs`, in a temp git repository, never by
 * importing the handlers directly. That is deliberate — the module had no test
 * coverage at all, so argument parsing, exit codes and the on-disk effects of
 * `init` were all unverified.
 *
 * Every case asserts BOTH the exit code and an output substring. A command that
 * prints the right text but exits non-zero is a failure (and vice versa).
 *
 * Determinism: temp dirs only, real `git init` in the temp dir, no network, no
 * model. SDLC_* environment overrides are neutralised so the host environment
 * cannot change what `config get`/`validate` report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, core, tempDir, cleanup, makeRepo, run, git } from '../lib/helpers.mjs';

const CLI = join(ROOT, 'packages', 'sdlc-cli', 'bin', 'sdlc.mjs');

// spawnSync drops keys whose value is undefined, so these entries REMOVE any
// inherited override rather than setting it to the empty string.
const NEUTRAL_ENV = {
  SDLC_DB_PATH: undefined,
  SDLC_LOG_LEVEL: undefined,
  SDLC_WORKER_MODE: undefined,
  SDLC_MAX_PARALLEL: undefined,
  SDLC_CONFIG_PATH: undefined,
};

function sdlc(cwd, args) {
  return run('node', [CLI, ...args], { cwd, env: NEUTRAL_ENV });
}

/** A real git repo with the pnpm markers `sdlc init` recognises. */
function pnpmRepo() {
  return makeRepo({
    'package.json': JSON.stringify({ name: 'fixture', devDependencies: {} }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  });
}

function init(repo) {
  const res = sdlc(repo, ['init']);
  assert.equal(res.status, 0, `sdlc init failed (${res.status}):\n${res.stdout}\n${res.stderr}`);
  return res;
}

/** Open the library Runtime against a temp project (the CLI's own code path). */
async function withRuntime(repo, fn) {
  const { Runtime } = await core.runtime();
  const runtime = new Runtime({ projectRoot: repo });
  runtime.open();
  try {
    return await fn(runtime);
  } finally {
    runtime.close();
  }
}

function parseJson(res) {
  return JSON.parse(res.stdout);
}

// ── usage ───────────────────────────────────────────────────────────────────

test('cli: --help and no args print usage and exit 0; unknown command exits 2', () => {
  const dir = tempDir();
  try {
    for (const args of [['--help'], []]) {
      const res = sdlc(dir, args);
      assert.equal(res.status, 0, `usage exit code for ${JSON.stringify(args)}`);
      assert.match(res.stdout, /sdlc — deterministic control plane/);
      assert.match(res.stdout, /sdlc init/);
    }

    const unknown = sdlc(dir, ['frobnicate']);
    assert.equal(unknown.status, 2, 'unknown command must exit 2');
    assert.match(unknown.stderr, /frobnicate/, 'unknown command must name the command');
    assert.match(unknown.stderr, /unknown command/);
  } finally {
    cleanup(dir);
  }
});

// ── init ────────────────────────────────────────────────────────────────────

test('cli: init detects pnpm, creates .sdlc/ state and the integration branch', () => {
  const repo = pnpmRepo();
  try {
    const res = init(repo);
    assert.match(res.stdout, /stack\s*:\s*pnpm/);
    assert.match(res.stdout, /integration\s*:\s*created/);

    assert.ok(existsSync(join(repo, '.sdlc', 'config.yml')), 'init creates .sdlc/config.yml');
    assert.ok(existsSync(join(repo, '.sdlc', 'sdlc.db')), 'init creates .sdlc/sdlc.db');

    const branches = git(['branch', '--list', 'sdlc/integration'], repo);
    assert.match(branches, /sdlc\/integration/, 'init creates the sdlc/integration branch');
  } finally {
    cleanup(repo);
  }
});

test('cli: init is idempotent — config and .gitignore are not rewritten', () => {
  const repo = pnpmRepo();
  try {
    init(repo);

    const configPath = join(repo, '.sdlc', 'config.yml');
    const gitignorePath = join(repo, '.gitignore');
    const configBefore = readFileSync(configPath, 'utf8');
    const configMtime = statSync(configPath).mtimeMs;
    const gitignoreBefore = readFileSync(gitignorePath, 'utf8');
    const gitignoreMtime = statSync(gitignorePath).mtimeMs;

    const second = init(repo);
    assert.match(second.stdout, /stack\s*:\s*pnpm/);
    assert.match(second.stdout, /integration\s*:\s*exists/);

    assert.equal(readFileSync(configPath, 'utf8'), configBefore, 'config.yml content must not change');
    assert.equal(statSync(configPath).mtimeMs, configMtime, 'config.yml must not be rewritten');
    assert.equal(readFileSync(gitignorePath, 'utf8'), gitignoreBefore, '.gitignore content must not change');
    assert.equal(statSync(gitignorePath).mtimeMs, gitignoreMtime, '.gitignore must not be rewritten');
    assert.match(git(['branch', '--list', 'sdlc/integration'], repo), /sdlc\/integration/);
  } finally {
    cleanup(repo);
  }
});

test('cli: init with no recognised stack marker exits 1 and never guesses', () => {
  const repo = makeRepo({ 'README.md': '# no stack here\n' });
  try {
    const res = sdlc(repo, ['init']);
    assert.equal(res.status, 1, 'unrecognised stack must fail');
    assert.match(res.stdout + res.stderr, /UNRECOGNISED_STACK|never guesses/);
  } finally {
    cleanup(repo);
  }
});

// ── status / tasks / explain ────────────────────────────────────────────────

test('cli: status before init is non-fatal and points at `sdlc init`', () => {
  const dir = tempDir();
  try {
    const json = sdlc(dir, ['status', '--json']);
    assert.equal(json.status, 0, 'status without a project must still exit 0');
    const report = parseJson(json);
    assert.equal(report.ok, false);
    assert.equal(report.error, 'NO_PROJECT');
    assert.match(report.detail, /sdlc init/);

    const human = sdlc(dir, ['status']);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /sdlc init/);
  } finally {
    cleanup(dir);
  }
});

test('cli: status, tasks and explain reflect library-created state', async () => {
  const repo = pnpmRepo();
  try {
    init(repo);

    const empty = parseJson(sdlc(repo, ['status', '--json']));
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.projects, []);
    assert.equal(empty.tasks.total, 0);
    assert.ok(empty.spend && typeof empty.spend.costUsd === 'number');

    await withRuntime(repo, (runtime) => {
      runtime.createProject({ id: 'P1', name: 'Fixture project' });
      runtime.addTask({
        id: 'T-1',
        project_id: 'P1',
        title: 'Add the widget',
        role: 'backend-engineer',
        allowed_paths: ['src/**'],
        verification: ['unit'],
      });
      const moved = runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} });
      assert.equal(moved.ok, true, `library transition failed: ${moved.reason}`);
    });

    const status = parseJson(sdlc(repo, ['status', '--json']));
    assert.equal(status.ok, true);
    assert.equal(status.projects.length, 1);
    assert.equal(status.projects[0].id, 'P1');
    assert.equal(status.tasks.total, 1);

    const tasksJson = sdlc(repo, ['tasks', '--json']);
    assert.equal(tasksJson.status, 0);
    const tasks = parseJson(tasksJson);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'T-1');

    const human = sdlc(repo, ['tasks']);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /T-1/, 'human task list shows the id');
    assert.match(human.stdout, /READY/, 'human task list shows the state');

    const explain = sdlc(repo, ['explain', 'T-1', '--json']);
    assert.equal(explain.status, 0);
    const detail = parseJson(explain);
    assert.equal(detail.task.id, 'T-1');
    assert.ok(Array.isArray(detail.events) && detail.events.length >= 1, 'explain returns events');
    assert.ok(Array.isArray(detail.workerRuns), 'explain returns worker runs');

    const missing = sdlc(repo, ['explain', 'T-NOPE']);
    assert.equal(missing.status, 1, 'explain of a missing id exits 1');
    assert.match(missing.stderr, /no such task/);

    const noId = sdlc(repo, ['explain']);
    assert.equal(noId.status, 2, 'explain with no id exits 2');
    assert.match(noId.stderr, /usage: sdlc explain/);
  } finally {
    cleanup(repo);
  }
});

// ── config ──────────────────────────────────────────────────────────────────

test('cli: config validate/get/show/set operate on the project config', () => {
  const repo = pnpmRepo();
  try {
    init(repo);

    const validate = sdlc(repo, ['config', 'validate']);
    assert.equal(validate.status, 0, `config validate failed:\n${validate.stdout}${validate.stderr}`);
    assert.match(validate.stdout, /config: ok/);

    const dbPath = sdlc(repo, ['config', 'get', 'storage.dbPath', '--json']);
    assert.equal(dbPath.status, 0);
    assert.equal(parseJson(dbPath), '.sdlc/sdlc.db');

    const show = sdlc(repo, ['config', 'show']);
    assert.equal(show.status, 0);
    assert.match(show.stdout, /^tiers:/m);

    const set = sdlc(repo, ['config', 'set', 'observability.logLevel', 'warn']);
    assert.equal(set.status, 0);
    assert.match(set.stdout, /config set observability\.logLevel = warn/);

    const get = sdlc(repo, ['config', 'get', 'observability.logLevel', '--json']);
    assert.equal(get.status, 0);
    assert.equal(parseJson(get), 'warn');
  } finally {
    cleanup(repo);
  }
});

// ── lock ────────────────────────────────────────────────────────────────────

test('cli: lock status/release tracks the Runtime instance lock', async () => {
  const repo = pnpmRepo();
  const { Runtime } = await core.runtime();
  try {
    init(repo);

    const initial = sdlc(repo, ['lock', 'status', '--json']);
    assert.equal(initial.status, 0);
    assert.equal(parseJson(initial).held, false);

    const runtime = new Runtime({ projectRoot: repo });
    runtime.open(); // takes .sdlc/sdlc.lock as this (live) process
    try {
      const held = sdlc(repo, ['lock', 'status', '--json']);
      assert.equal(held.status, 0);
      const report = parseJson(held);
      assert.equal(report.held, true);
      assert.equal(report.holder.pid, process.pid, 'lock holder pid is the live process');

      const release = sdlc(repo, ['lock', 'release', '--force']);
      assert.equal(release.status, 0);
      assert.match(release.stdout, /lock released/);
      assert.equal(existsSync(join(repo, '.sdlc', 'sdlc.lock')), false, 'release removes the lock file');
    } finally {
      runtime.close({ releaseLock: false });
    }
  } finally {
    cleanup(repo);
  }
});

// ── db / logs / verify / resume ─────────────────────────────────────────────

test('cli: db export-events/integrity, logs, verify and resume are well-formed', async () => {
  const repo = pnpmRepo();
  try {
    init(repo);
    await withRuntime(repo, (runtime) => {
      runtime.createProject({ id: 'P1', name: 'Fixture project' });
      runtime.addTask({
        id: 'T-1',
        project_id: 'P1',
        title: 'Add the widget',
        role: 'backend-engineer',
        allowed_paths: ['src/**'],
        verification: ['unit'],
      });
    });

    const exportRes = sdlc(repo, ['db', 'export-events']);
    assert.equal(exportRes.status, 0);
    const lines = exportRes.stdout.split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.length >= 1, 'export-events emits at least one JSON line');
    for (const line of lines) {
      const event = JSON.parse(line);
      assert.ok(typeof event.action === 'string', `event line has an action: ${line}`);
    }

    const integrity = sdlc(repo, ['db', 'integrity', '--json']);
    assert.equal(integrity.status, 0);
    assert.equal(parseJson(integrity).ok, true);

    const logs = sdlc(repo, ['logs', '--json']);
    assert.equal(logs.status, 0);
    const logsReport = parseJson(logs);
    assert.ok(typeof logsReport.dir === 'string');
    assert.ok(Array.isArray(logsReport.files));

    const verify = sdlc(repo, ['verify', '--task', 'T-1', '--gates', 'syntax']);
    assert.ok(verify.status === 0 || verify.status === 1, `verify exit ${verify.status}`);
    assert.match(verify.stdout, /verification:/);

    const resume = sdlc(repo, ['resume', '--json']);
    assert.equal(resume.status, 0);
    const resumed = parseJson(resume);
    assert.equal(typeof resumed, 'object');
    assert.equal(typeof resumed.reconciled, 'number');
    assert.ok(Array.isArray(resumed.transitions));
  } finally {
    cleanup(repo);
  }
});

// ── stop ────────────────────────────────────────────────────────────────────

test('cli: stop cancels a dispatchable task and records a kill-switch event', async () => {
  const repo = pnpmRepo();
  try {
    init(repo);
    await withRuntime(repo, (runtime) => {
      runtime.createProject({ id: 'P1', name: 'Fixture project' });
      runtime.addTask({
        id: 'T-1',
        project_id: 'P1',
        title: 'Add the widget',
        role: 'backend-engineer',
        allowed_paths: ['src/**'],
        verification: ['unit'],
      });
      assert.equal(runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} }).ok, true);
    });

    const stop = sdlc(repo, ['stop', '--json']);
    assert.equal(stop.status, 0, `stop failed:\n${stop.stdout}${stop.stderr}`);
    const report = parseJson(stop);
    assert.deepEqual(report.stopped, ['T-1']);

    const tasks = parseJson(sdlc(repo, ['tasks', '--json']));
    assert.equal(tasks[0].state, 'CANCELLED');

    const exported = sdlc(repo, ['db', 'export-events']);
    assert.equal(exported.status, 0);
    const actions = exported.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l).action);
    assert.ok(actions.includes('kill-switch'), `kill-switch event recorded (got ${actions.join(', ')})`);
  } finally {
    cleanup(repo);
  }
});

// ── doctor ──────────────────────────────────────────────────────────────────

test('cli: doctor always emits a parseable report with the node check', () => {
  const repo = pnpmRepo();
  try {
    init(repo);

    const res = sdlc(repo, ['doctor', '--json']);
    assert.ok(res.status === 0 || res.status === 1, `doctor exit ${res.status}`);
    const report = parseJson(res);
    assert.equal(typeof report.errors, 'number');
    assert.ok(Array.isArray(report.checks));

    const node = report.checks.find((c) => c.id === 'node>=22.5');
    assert.ok(node, 'doctor reports a node>=22.5 check');
    assert.equal(node.ok, true, `node check must pass on ${process.version}`);

    const failing = report.checks.filter((c) => !c.ok).length;
    assert.equal(report.errors, failing, 'errors counts the failing checks');
    assert.equal(res.status, failing ? 1 : 0);
  } finally {
    cleanup(repo);
  }
});

// ── selftest ────────────────────────────────────────────────────────────────

test('cli: selftest --mock passes all four steps; --live refuses', () => {
  const dir = tempDir();
  try {
    const mock = sdlc(dir, ['selftest', '--mock']);
    assert.equal(mock.status, 0, `selftest --mock failed:\n${mock.stdout}${mock.stderr}`);
    for (const step of ['init', 'schema', 'state-machine', 'append-only']) {
      assert.match(mock.stdout, new RegExp(`ok\\s+${step}`), `selftest reports ${step} ok`);
    }

    const live = sdlc(dir, ['selftest', '--live']);
    assert.equal(live.status, 1, 'selftest --live must refuse and exit 1');
    assert.match(live.stderr, /live/, 'selftest --live explains the refusal on stderr');
  } finally {
    cleanup(dir);
  }
});
