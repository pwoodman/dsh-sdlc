/**
 * packages/sdlc-core/src/services.js — DSH service wiring (spec v3 C.2, C.4).
 *
 * This is the ONLY file in sdlc-core that touches the DSH host API, so the
 * platform surface stays isolated (Part E residual risk 1). Everything it
 * mounts comes from ./runtime.js and the pure modules.
 *
 * The patch declares one row per service (`sdlc-tasks`, `sdlc-router`, …), each
 * invoking this module with `config.service`. All rows share ONE runtime — the
 * single writer to sdlc.db (P23).
 */

import { readFileSync } from 'node:fs';
import { Runtime } from './runtime.js';
import { contributeSelftest, setSelftestMeta } from './selftest.js';

export const SERVICE_NAMES = [
  'tasks', 'scheduler', 'router', 'verifier', 'integration',
  'evidence', 'escalation', 'worker-mgr', 'recovery',
];

/**
 * Single source of truth for the facade methods each service row exposes.
 * The M0 selftest contract pins `profiles/sdlc-probe/profile.json`'
 * `selftest.requires.services` against SERVICE_NAMES; this table pins the
 * per-service METHOD surface against the same check, so the three
 * declarations (SERVICE_NAMES, facades, probe profile) cannot drift silently
 * (audit #6). Probe only asserts the service LIST; method drift is caught by
 * tests/unit/services.test.mjs.
 */
export const SERVICE_METHODS = {
  tasks: ['getTask', 'listTasks', 'addTask', 'projectTasks', 'transition', 'proposeTransition'],
  scheduler: ['canDispatch', 'guardFor', 'spentTotals'],
  router: ['route', 'recordModelRun'],
  verifier: ['ingestResult', 'recordTestResults'],
  integration: ['listTasks'],
  evidence: ['getEvents', 'assertIntegrity'],
  escalation: ['recordDecision', 'listDecisions'],
  'worker-mgr': ['startWorkerRun', 'finishWorkerRun', 'getWorkerRun', 'listWorkerRuns'],
  recovery: ['getEvents', 'listTasks'],
};

const RUNTIME_KEY = '__SDLC_RUNTIME__';

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

function dshVersion() {
  return process.env.SDLC_DSH_VERSION ?? null;
}

/** One runtime per project root, per process (single-writer invariant). */
export function getRuntime(config = {}, { ctx = null, projectRoot = process.cwd() } = {}) {
  const g = globalThis;
  g[RUNTIME_KEY] ??= new Map();
  const key = projectRoot;
  if (!g[RUNTIME_KEY].has(key)) {
    g[RUNTIME_KEY].set(key, new Runtime({ projectRoot, config }));
  }
  return g[RUNTIME_KEY].get(key);
}

export function closeRuntime(projectRoot = process.cwd()) {
  const g = globalThis;
  const runtime = g[RUNTIME_KEY]?.get(projectRoot);
  if (runtime) {
    runtime.close();
    g[RUNTIME_KEY].delete(projectRoot);
  }
}

/** A per-service facade: namespaced access to the shared runtime. */
export function makeService(runtime, service) {
  const names = SERVICE_METHODS;
  const api = { service, runtime, config: runtime.config };
  for (const method of names[service] ?? []) {
    if (typeof runtime[method] === 'function') api[method] = runtime[method].bind(runtime);
  }
  return api;
}

/**
 * DSH plugin entry. Registering a service is idempotent: the runtime is created
 * once and every row shares it.
 *
 * MUST return nothing: the Cordis runner interprets a plugin's return value as
 * an effect (`TypeError: Invalid effect` for a non-constructible apply;
 * silently dropped for this regular-function apply). Callers that need the
 * runtime handle use `getRuntime(config, { projectRoot })` — the same
 * per-project-root singleton this entry creates.
 * @returns {undefined}
 */
export function apply(ctx, config = {}) {
  setSelftestMeta({ version: pkgVersion(), dsh: dshVersion() });
  const projectRoot = config.projectRoot ?? process.env.SDLC_PROJECT_ROOT ?? process.cwd();
  const service = config.service ?? null;
  contributeSelftest({
    services: service ? [service] : SERVICE_NAMES,
    guard: {
      orchestratorPaths: config.orchestratorPaths ?? ['.sdlc/**', '.dsh/**'],
      forbiddenPatterns: config.guardForbiddenPatterns ?? config.safety?.guardForbiddenPatterns ?? [],
    },
  });

  const runtime = getRuntime(config, { ctx, projectRoot });
  if (!runtime.db) {
    try {
      runtime.open();
    } catch (err) {
      if (ctx?.logger?.error) ctx.logger.error('sdlc-core: %s', err?.message ?? err);
      else process.stderr.write(`sdlc-core: ${err?.message ?? err}\n`);
      throw err;
    }
  }

  if (service && typeof ctx?.provide === 'function') {
    ctx.provide(`sdlc.${service}`, makeService(runtime, service));
  } else if (typeof ctx?.provide === 'function') {
    ctx.provide('sdlc.runtime', runtime);
  }
}
