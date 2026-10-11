/**
 * tests/lib/helpers.mjs — shared, dependency-free test helpers.
 *
 * Every helper is deterministic and offline: temp dirs only, no network, no
 * model, no global state that leaks between tests. Where a test needs a real
 * repository it gets a real `git init` in a temp dir.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const ROOT = resolve(import.meta.dirname, '..', '..');

/** Import a package's source module by workspace-relative path. */
export async function load(relPath) {
  return import(`file://${join(ROOT, relPath)}`);
}

export const core = {
  schema: () => load('packages/sdlc-core/src/schema.js'),
  stateMachine: () => load('packages/sdlc-core/src/state-machine.js'),
  complexity: () => load('packages/sdlc-core/src/complexity/index.js'),
  workerResult: () => load('packages/sdlc-core/src/worker-result.js'),
  risk: () => load('packages/sdlc-core/src/risk.js'),
  a11y: () => load('packages/sdlc-core/src/a11y.js'),
  visual: () => load('packages/sdlc-core/src/visual.js'),
  loop: () => load('packages/sdlc-core/src/loop.js'),
  router: () => load('packages/sdlc-core/src/router.js'),
  budget: () => load('packages/sdlc-core/src/budget.js'),
  config: () => load('packages/sdlc-core/src/config.js'),
  gates: () => load('packages/sdlc-core/src/gates.js'),
  context: () => load('packages/sdlc-core/src/context.js'),
  scheduler: () => load('packages/sdlc-core/src/scheduler.js'),
  verifier: () => load('packages/sdlc-core/src/verifier.js'),
  escalation: () => load('packages/sdlc-core/src/escalation.js'),
  integration: () => load('packages/sdlc-core/src/integration.js'),
  recovery: () => load('packages/sdlc-core/src/recovery.js'),
  workerMgr: () => load('packages/sdlc-core/src/worker-mgr.js'),
  runtime: () => load('packages/sdlc-core/src/runtime.js'),
  yaml: () => load('packages/sdlc-core/src/yaml-lite.js'),
  instanceLock: () => load('packages/sdlc-core/src/instance-lock.js'),
  project: () => load('packages/sdlc-core/src/project.js'),
  metrics: () => load('packages/sdlc-core/src/metrics.js'),
  debug: () => load('packages/sdlc-core/src/debug.js'),
  uiRoutes: () => load('packages/sdlc-client-ui/src/routes.js'),
  uiHandlers: () => load('packages/sdlc-client-ui/src/server/handlers.js'),
  uiPlugin: () => load('packages/sdlc-client-ui/src/server/plugin.js'),
  uiApi: () => load('packages/sdlc-client-ui/src/client/api.js'),
  uiStore: () => load('packages/sdlc-client-ui/src/client/store.js'),
  selftest: () => load('packages/sdlc-core/src/selftest.js'),
  guard: () => load('packages/sdlc-guard/src/index.js'),
  guardPlugin: () => load('packages/sdlc-guard/src/plugin.js'),
  tools: () => load('packages/sdlc-tools/src/index.js'),
  presets: () => load('packages/sdlc-presets/src/roles.js'),
  mockLlm: () => load('packages/sdlc-mock-llm/src/index.js'),
};

export function tempDir(prefix = 'sdlc-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Run a process, never throwing. */
export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeoutMs ?? 60_000,
  });
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

/**
 * Create a real git repository with an initial commit. Used by the integration
 * and adversarial layers, which must exercise real `git diff` semantics.
 */
export function makeRepo(files = {}, { prefix = 'sdlc-repo-' } = {}) {
  const dir = tempDir(prefix);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'sdlc@example.test'], dir);
  git(['config', 'user.name', 'SDLC Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFiles(dir, files);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

export function addCommit(repo, files, message = 'change') {
  writeFiles(repo, files);
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', message], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

/** Deterministic PRNG for property tests (K.3 requires a seeded generator). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function intBetween(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function exists(path) {
  return existsSync(path);
}

/** A config object with no environment-dependent behaviour (for tests). */
export async function fixedConfig(overrides = {}) {
  const { DEFAULT_CONFIG, deepMerge } = await core.config();
  return deepMerge(DEFAULT_CONFIG, overrides);
}

/**
 * A deterministic 2-task DAG used across integration tests: DB-001 must land
 * before API-001, both touch `package.json` (resource collision, Test 6).
 */
export function sampleTaskGraph(projectId = 'P1') {
  return [
    {
      id: 'DB-001', project_id: projectId, title: 'Add customers table', role: 'database-engineer',
      objective: 'create the customers table', task_class: 'architectural', risk_class: 'R2',
      resources: ['package.json'], allowed_paths: ['src/db/**', 'migrations/**'],
      verification: ['syntax', 'lint', 'unit', 'integration'],
      acceptance_criteria: [{ id: 'AC1', statement: 'table exists', check: 'integration:test_migration' }],
    },
    {
      id: 'API-001', project_id: projectId, title: 'GET /api/customers', role: 'api-engineer',
      objective: 'expose the customers list', depends_on: ['DB-001'], task_class: 'normal', risk_class: 'R2',
      resources: ['package.json'], allowed_paths: ['src/api/**'],
      verification: ['syntax', 'lint', 'unit', 'integration', 'api'],
      acceptance_criteria: [{ id: 'AC1', statement: 'list returned', check: 'api:test_list' }],
    },
  ];
}

/** Drive a task through the full happy path using the real state machine. */
export function driveToDone(runtime, taskId, { filesChanged = [] } = {}) {
  const task = runtime.getTask(taskId);
  const steps = [
    ['READY', 'scheduler', { depStates: Object.fromEntries((task.depends_on ?? []).map((d) => [d, 'DONE'])) }],
    ['ASSIGNED', 'scheduler', { available: true }],
    ['IN_PROGRESS', 'worker-mgr', {}],
    ['VERIFYING', 'worker-mgr', {}],
    ['ACCEPTED', 'verifier', { gatesPass: true }],
    ['MERGING', 'integration-mgr', { mergeSlotFree: true }],
    ['DONE', 'integration-mgr', { merged: true }],
  ];
  const results = [];
  for (const [to, actor, ctx] of steps) {
    const res = runtime.state.transition(taskId, to, actor, ctx);
    results.push(res);
    if (!res.ok) throw new Error(`${taskId} → ${to} rejected: ${res.reason}`);
  }
  return results;
}

export { spawnSync, join, dirname, resolve, writeFileSync, readFileSync, mkdirSync, mkdtempSync };
