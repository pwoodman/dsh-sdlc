/**
 * packages/sdlc-client-ui/src/server/handlers.js — host route handlers.
 *
 * Read-only over the live `sdlc.db` (Runtime, useLock:false — never takes the
 * instance lock, so the UI cannot block the lead). The single POST route
 * (`/api/sdlc.config`) reuses the CLI's dotted-key `setPath` + `validateConfig`
 * + `dumpConfigYaml` path: a write that fails validation is rejected with
 * 400 and the file is never touched.
 *
 * All handlers are pure functions of ({ projectRoot, query, body }) so they
 * are unit-testable without a DSH boot.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Runtime } from '../../../sdlc-core/src/runtime.js';
import { loadConfig, validateConfig, deepMerge, dumpConfigYaml } from '../../../sdlc-core/src/config.js';
import { parseYaml } from '../../../sdlc-core/src/yaml-lite.js';
import { setPath } from '../../../sdlc-cli/src/cli.mjs';
import { compareRuns } from '../../../sdlc-core/src/debug.js';
import { collectMetricsSnapshot, renderPrometheus } from '../../../sdlc-core/src/metrics.js';
import { hostModelAdoption } from '../../../sdlc-core/src/host-model.js';
import { readPackageVersion } from '../../../sdlc-guard/src/package-version.js';

/**
 * The host build serving this payload. The panel compares it with its own
 * build when `/api/sdlc.flow` is missing: an older host answers status but not
 * flow, and the user needs to know which half to update.
 * Resolves beside the source tree and beside the folded `lib/rows/ui/` copy.
 */
function pluginVersion() {
  return readPackageVersion(import.meta.url, 3);
}

function noProject(projectRoot) {
  // Pure-handler guard: the plugin layer auto-bootstraps before these run, so
  // reaching this means setup failed or the project vanished mid-session.
  return { status: 404, body: { ok: false, error: 'NO_PROJECT', detail: 'no complete .sdlc project — auto-setup did not run here; `sdlc init` prints the reason', root: projectRoot, pluginVersion: pluginVersion() } };
}

function openRuntime(projectRoot) {
  const { config } = loadConfig(projectRoot);
  const runtime = new Runtime({ projectRoot, config, useLock: false });
  runtime.open();
  return { runtime, config };
}

function closeRuntime(runtime) {
  try { runtime.close({ releaseLock: false }); } catch { /* already closed */ }
}

/**
 * Project rows and tasks that belong to the workspace on screen.
 *
 * A DB can outlive a checkout move or carry a stale row from another project
 * (the removed demo seed wrote `DEMO` into this repo's DB). Only rows whose
 * `repo_path` matches the resolved workspace are real for this session.
 */
function workspaceScopes(runtime, projectRoot) {
  const rootPath = resolve(projectRoot);
  const projects = runtime.db.prepare('SELECT * FROM projects ORDER BY created_at').all()
    .filter((p) => !p.repo_path || resolve(p.repo_path) === rootPath);
  const projectIds = new Set(projects.map((p) => p.id));
  const tasks = projects.length === 0
    ? []
    : runtime.listTasks().filter((t) => t.project_id == null || projectIds.has(t.project_id));
  return { projects, projectIds, tasks, taskIds: new Set(tasks.map((t) => t.id)) };
}

function inWorkspaceTask(scope, task) {
  if (scope.projects.length === 0 || !task) return false;
  return task.project_id == null || scope.projectIds.has(task.project_id);
}

/** GET /api/sdlc.status — project + task + spend summary (mirrors `sdlc status --json`). */
export function handleStatus(projectRoot) {
  const dbPath = join(projectRoot, '.sdlc', 'sdlc.db');
  if (!existsSync(dbPath)) return noProject(projectRoot);
  const { runtime } = openRuntime(projectRoot);
  try {
    const scope = workspaceScopes(runtime, projectRoot);
    const { projects, taskIds } = scope;
    const taskRows = scope.tasks;
    const byState = {};
    for (const t of taskRows) byState[t.state] = (byState[t.state] ?? 0) + 1;
    const runs = runtime.listWorkerRuns().filter((r) => taskIds.has(r.task_id));
    // Unknown totals stay null when runs exist but recorded no value; no runs
    // at all is a real zero. The panel renders "—" for null, never "0".
    const spendKnown = {
      cost: runs.length === 0 || runs.some((run) => run.cost_usd != null),
      duration: runs.length === 0 || runs.some((run) => run.duration_ms != null),
      tokens: runs.length === 0 || runs.some((run) => run.tokens_in != null || run.tokens_out != null),
    };
    const totals = runs.reduce((total, run) => {
      total.costUsd += Number(run.cost_usd ?? 0);
      total.durationMs += Number(run.duration_ms ?? 0);
      total.tokens += Number(run.tokens_in ?? 0) + Number(run.tokens_out ?? 0);
      return total;
    }, { costUsd: 0, durationMs: 0, tokens: 0 });
    const spend = {
      costUsd: spendKnown.cost ? totals.costUsd : null,
      durationMs: spendKnown.duration ? totals.durationMs : null,
      tokens: spendKnown.tokens ? totals.tokens : null,
    };
    return {
      status: 200,
      body: {
        ok: true,
        pluginVersion: pluginVersion(),
        dbPath,
        projects: projects.map((p) => ({ id: p.id, name: p.name, state: p.state, blocked_state: p.blocked_state })),
        tasks: {
          total: taskRows.length,
          byState,
          items: taskRows.map((t) => ({
            id: t.id, title: t.title, state: t.state, role: t.role,
            riskClass: t.risk_class, attempt: t.attempt ?? 0,
          })),
        },
        workerRuns: { total: runs.length, orphaned: runs.filter((r) => r.orphaned).length },
        spend,
      },
    };
  } finally { closeRuntime(runtime); }
}

/** GET /api/sdlc.board — tasks grouped into state columns for the board. */
export function handleBoard(projectRoot) {
  const res = handleStatus(projectRoot);
  if (res.status !== 200) return res;
  const groups = new Map();
  for (const t of res.body.tasks.items) {
    if (!groups.has(t.state)) groups.set(t.state, []);
    groups.get(t.state).push(t);
  }
  const order = ['BACKLOG', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'VERIFYING', 'ACCEPTED', 'MERGING', 'DONE', 'FAILED', 'ESCALATED', 'BLOCKED', 'CANCELLED'];
  const columns = [...groups.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([state, tasks]) => ({ state, tasks }));
  return { status: 200, body: { ok: true, columns, totals: res.body.tasks } };
}

/** GET /api/sdlc.task?id=<id> — one task + events + gates + worker runs. */
export function handleTask(projectRoot, query = {}) {
  const id = query.id ?? query.task;
  if (!id) return { status: 400, body: { ok: false, error: 'MISSING_ID', detail: 'query ?id=<task-id> is required' } };
  const dbPath = join(projectRoot, '.sdlc', 'sdlc.db');
  if (!existsSync(dbPath)) return noProject(projectRoot);
  const { runtime } = openRuntime(projectRoot);
  try {
    const scope = workspaceScopes(runtime, projectRoot);
    const task = runtime.getTask(id);
    if (!inWorkspaceTask(scope, task)) return { status: 404, body: { ok: false, error: 'NO_SUCH_TASK', id } };
    const events = runtime.getEvents({ taskId: id });
    const workerRuns = runtime.listWorkerRuns({ taskId: id }).map((r) => ({
      id: r.id, attempt: r.attempt, status: r.status, exitCode: r.exit_code,
      durationMs: r.duration_ms, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
    }));
    let gates = [];
    try {
      gates = runtime.db.prepare('SELECT gate, status, log_path FROM test_results WHERE task_id = ? ORDER BY gate').all(id)
        .map((r) => ({ gate: r.gate, status: r.status, logPath: r.log_path ?? null }));
    } catch { gates = []; }
    return { status: 200, body: { ok: true, task, events, workerRuns, gates } };
  } finally { closeRuntime(runtime); }
}

/** GET /api/sdlc.compare?task=<id>&a=<run>&b=<run> — compareRuns() JSON. */
export function handleCompare(projectRoot, query = {}) {
  const { task, a, b } = query;
  if (!task || !a || !b) {
    return { status: 400, body: { ok: false, error: 'MISSING_PARAMS', detail: 'query ?task=<id>&a=<run>&b=<run> is required' } };
  }
  const dbPath = join(projectRoot, '.sdlc', 'sdlc.db');
  if (!existsSync(dbPath)) return noProject(projectRoot);
  const { runtime } = openRuntime(projectRoot);
  try {
    const scope = workspaceScopes(runtime, projectRoot);
    if (!inWorkspaceTask(scope, runtime.getTask(task))) {
      return { status: 404, body: { ok: false, error: 'NO_SUCH_TASK', id: task } };
    }
    const report = compareRuns(runtime, task, a, b);
    const missing = [!report.runs.A.available, !report.runs.B.available].filter(Boolean).length;
    return { status: missing ? 404 : 200, body: { ok: missing === 0, ...report } };
  } finally { closeRuntime(runtime); }
}

/** Public projection of the host model (never the local profile path). */
function publicHostModel(hostModel) {
  if (!hostModel || typeof hostModel.provider !== 'string' || typeof hostModel.model !== 'string') return null;
  return {
    provider: hostModel.provider,
    model: hostModel.model,
    reasoningEffort: hostModel.reasoningEffort ?? null,
  };
}

/** GET /api/sdlc.config — parsed config + validation result + host model. */
export function handleConfigGet(projectRoot, hostModel = null) {
  const configPath = join(projectRoot, '.sdlc', 'config.yml');
  const exists = existsSync(configPath);
  const { config } = loadConfig(projectRoot, { configPath });
  const validation = validateConfig(config, { projectRoot });
  return {
    status: 200,
    body: { ok: true, exists, path: configPath, config, validation, hostModel: publicHostModel(hostModel) },
  };
}

/**
 * POST /api/sdlc.host — adopt the Harness's current provider/model.
 *
 * Explicit user action (the Settings button): rewrite the three tiers to the
 * route DSH already resolves and record an explicit "unknown" price. No API
 * key is introduced; the worker/subagent uses the host's credential store.
 */
export function handleHostAdopt(projectRoot, hostModel = null) {
  // Adoption is a config write: it requires a complete project (config.yml),
  // so it can never wedge the done marker on a bootstrap-failed leftover.
  // The plugin guard bootstraps before this runs; direct callers get the
  // same fail-closed answer.
  if (!existsSync(join(projectRoot, '.sdlc', 'config.yml'))) return noProject(projectRoot);
  const host = publicHostModel(hostModel);
  if (!host) {
    return {
      status: 409,
      body: { ok: false, error: 'HOST_MODEL_UNAVAILABLE', detail: 'the Harness did not report a default provider/model' },
    };
  }
  const configPath = join(projectRoot, '.sdlc', 'config.yml');
  const { config: current } = loadConfig(projectRoot, { configPath });
  // Defaults fill missing SECTIONS; the price table comes from the user's FILE
  // plus the adopted route — adoption never re-introduces legacy rows that no
  // tier references (the same rule as the CLI's use-host-model).
  const fileConfig = existsSync(configPath) ? (parseYaml(readFileSync(configPath, 'utf8')) ?? {}) : {};
  const adoption = hostModelAdoption(host);
  const candidate = {
    ...current,
    tiers: adoption.tiers,
    pricing: {
      ...(typeof fileConfig.pricing === 'object' && fileConfig.pricing !== null ? fileConfig.pricing : {}),
      ...adoption.pricing,
    },
  };
  const validation = validateConfig(candidate, { projectRoot });
  if (!validation.ok) return { status: 400, body: { ok: false, error: 'VALIDATION_FAILED', validation } };
  writeFileSync(configPath, dumpConfigYaml(candidate));
  return { status: 200, body: { ok: true, hostModel: host, config: candidate, validation } };
}

function coerceBody(value) {
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  }
  return value;
}

/**
 * POST /api/sdlc.config { path, value } — validated config write.
 * Rejects unknown top-level sections and failed validation with 400;
 * the file is only written when the FULL merged config validates.
 */
export function handleConfigPost(projectRoot, body = {}) {
  // The request may name a session workspace (`?cwd=`). Never create `.sdlc`
  // content in a directory that is not already a COMPLETE SDLC project: gate
  // on config.yml, not the directory — a failed auto-bootstrap leaves the
  // tree behind, and writing a config there would wedge the done marker on
  // an OpenAI-default file with no detected gates.
  if (!existsSync(join(projectRoot, '.sdlc', 'config.yml'))) return noProject(projectRoot);
  const { path, value } = body;
  if (typeof path !== 'string' || !path) {
    return { status: 400, body: { ok: false, error: 'MISSING_PATH', detail: 'body { path, value } is required' } };
  }
  const knownRoots = ['tiers', 'pricing', 'execution', 'budgets', 'verification', 'escalation', 'context', 'storage', 'safety', 'router', 'observability'];
  const root = String(path).split('.')[0];
  if (!knownRoots.includes(root)) {
    return { status: 400, body: { ok: false, error: 'UNKNOWN_SECTION', detail: `unknown config section "${root}"` } };
  }
  const configPath = join(projectRoot, '.sdlc', 'config.yml');
  try {
    setPath({}, path, coerceBody(value));
  } catch (err) {
    return { status: 400, body: { ok: false, error: 'BAD_PATH', detail: err.message } };
  }
  // Validate the would-be file content merged over defaults.
  const { config: current } = loadConfig(projectRoot, { configPath });
  const candidate = deepMerge(current, setPath({}, path, coerceBody(value)));
  const validation = validateConfig(candidate, { projectRoot });
  if (!validation.ok) {
    return { status: 400, body: { ok: false, error: 'VALIDATION_FAILED', validation } };
  }
  writeFileSync(configPath, dumpConfigYaml(candidate));
  return { status: 200, body: { ok: true, path, value: coerceBody(value), validation } };
}

/** GET /api/sdlc.metrics — Prometheus exposition of the live snapshot. */
export function handleMetrics(projectRoot) {
  const dbPath = join(projectRoot, '.sdlc', 'sdlc.db');
  if (!existsSync(dbPath)) return { status: 404, body: 'no project — auto-setup did not run here; `sdlc init` prints the reason' };
  const { runtime } = openRuntime(projectRoot);
  try {
    const text = renderPrometheus(collectMetricsSnapshot(runtime));
    return { status: 200, body: text, contentType: 'text/plain; version=0.0.4' };
  } finally { closeRuntime(runtime); }
}

export default { handleStatus, handleBoard, handleTask, handleCompare, handleConfigGet, handleConfigPost, handleMetrics };
