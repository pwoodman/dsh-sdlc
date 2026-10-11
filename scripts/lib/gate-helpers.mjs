/**
 * scripts/lib/gate-helpers.mjs — shared setup for the M2–M8 milestone gates.
 *
 * Every gate must be deterministic, offline and side-effect-free outside its
 * temp directory (spec v3 K.1). These helpers keep that true by construction.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

export function importPkg(rel) {
  return import(`file://${join(ROOT, rel)}`);
}

export function tempDir(prefix = 'sdlc-gate-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeoutMs ?? 60_000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ok: res.status === 0 };
}

export function git(args, cwd) {
  const res = run('git', args, { cwd });
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** A real git repository in a temp dir with one commit. */
export function makeRepo(files = {}, prefix = 'sdlc-gate-repo-') {
  const dir = tempDir(prefix);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate@example.test'], dir);
  git(['config', 'user.name', 'SDLC Gate'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFiles(dir, files);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

export function testConfig(overrides = {}) {
  return {
    storage: { dbPath: '.sdlc/sdlc.db', requireQuickCheckOnOpen: true },
    safety: { instanceLock: false, guardForbiddenPatterns: ['git push --force*', 'rm -rf /'] },
    budgets: {},
    verification: { gateTimeoutMs: 30000, gates: {} },
    ...overrides,
  };
}

/** Open a Runtime on a temp project (lock disabled unless asked for). */
export async function openRuntime(dir, { useLock = false, config = testConfig(), projectId = 'P1', tasks = [] } = {}) {
  const { Runtime } = await importPkg('packages/sdlc-core/src/runtime.js');
  const runtime = new Runtime({ projectRoot: dir, config, useLock });
  runtime.open();
  if (projectId) runtime.createProject({ id: projectId, name: projectId });
  for (const task of tasks) runtime.addTask({ project_id: projectId, ...task });
  return runtime;
}

/** Drive a task through the happy path to DONE (used as a fixture). */
export function driveToDone(runtime, taskId, deps = []) {
  const depStates = Object.fromEntries(deps.map((d) => [d, 'DONE']));
  const steps = [
    ['READY', 'scheduler', { depStates }],
    ['ASSIGNED', 'scheduler', { available: true }],
    ['IN_PROGRESS', 'worker-mgr', {}],
    ['VERIFYING', 'worker-mgr', {}],
    ['ACCEPTED', 'verifier', { gatesPass: true }],
    ['MERGING', 'integration-mgr', { mergeSlotFree: true }],
    ['DONE', 'integration-mgr', { merged: true }],
  ];
  for (const [to, actor, ctx] of steps) {
    const res = runtime.state.transition(taskId, to, actor, ctx);
    if (!res.ok) throw new Error(`${taskId} → ${to} rejected: ${res.reason}`);
  }
  return runtime.getTask(taskId);
}

/** A deterministic runner for gates.runVerification. */
export function fakeRunner(outcomes = {}) {
  return (argv) => {
    const key = argv.join(' ');
    const outcome = outcomes[key] ?? outcomes[argv[0]] ?? { status: 0 };
    return { status: outcome.status ?? 0, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' };
  };
}

export async function withDir(fn, prefix) {
  const dir = tempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    cleanup(dir);
  }
}

export { spawnSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, join, dirname };
