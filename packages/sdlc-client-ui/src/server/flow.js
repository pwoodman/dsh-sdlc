/**
 * packages/sdlc-client-ui/src/server/flow.js — the SDLC flow visualizer model.
 *
 * One read-only snapshot for the right-sidebar panel: task DAG (nodes + edges),
 * subagent/worker runs, routing decisions, gate states, recent events, resource
 * locks and escalations. Bounded by construction; every field that cannot be
 * known is null with a reason rather than a fabricated zero.
 *
 * The panel exists because the orchestrator's most important state — which
 * agent is doing what, why this model was chosen, what is blocking the DAG — is
 * otherwise only visible in logs. It is a VIEW: no writes, no lock, no model.
 */

import { existsSync, readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

import { Runtime } from '../../../sdlc-core/src/runtime.js';
import { loadConfig } from '../../../sdlc-core/src/config.js';
import {
  activeTasks, checkNoOverlap, depsBlocking, effectiveParallelism, resourcesOf, topoSort,
} from '../../../sdlc-core/src/scheduler.js';

/** Host build serving this snapshot (see handlers.js — used for mismatch diagnosis). */
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

export const FLOW_LIMITS = {
  tasks: 200,
  runsPerTask: 3,
  events: 100,
  escalations: 50,
};

const EVENT_COLUMNS = 'id, ts, task_id, actor, action, model, result, duration_ms, payload_json';

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function gateClass(status) {
  const text = String(status ?? '');
  if (text === 'pass') return 'pass';
  if (text === 'fail' || text.startsWith('fail:')) return 'fail';
  if (text.startsWith('skipped')) return 'skipped';
  return 'unknown';
}

function tokensOf(row) {
  if (row.tokens_in == null && row.tokens_out == null) return null;
  return (row.tokens_in ?? 0) + (row.tokens_out ?? 0);
}

function durationOf(row, nowMs) {
  if (row.duration_ms != null) return { durationMs: row.duration_ms, durationSource: 'recorded' };
  if (row.started_at) {
    const started = Date.parse(row.started_at);
    if (Number.isFinite(started)) return { durationMs: Math.max(0, nowMs - started), durationSource: 'live' };
  }
  return { durationMs: null, durationSource: 'unavailable' };
}

function tierOf(config, provider, model) {
  for (const [tier, entries] of Object.entries(config.tiers ?? {})) {
    if ((entries ?? []).some((entry) => entry.provider === provider && entry.model === model)) return tier;
  }
  return null;
}

function openRuntime(projectRoot, { quickCheck = false } = {}) {
  const { config } = loadConfig(projectRoot);
  const effective = quickCheck
    ? config
    : { ...config, storage: { ...(config.storage ?? {}), requireQuickCheckOnOpen: false } };
  const runtime = new Runtime({ projectRoot, config: effective, useLock: false });
  runtime.open();
  return { runtime, config: effective };
}

function closeRuntime(runtime) {
  try { runtime.close({ releaseLock: false }); } catch { /* already closed */ }
}

/**
 * Build the bounded flow snapshot.
 *
 * @param {string} projectRoot
 * @param {object} [options]
 * @returns {object}
 */
export function buildFlowModel(projectRoot, {
  taskId = null,
  taskLimit = FLOW_LIMITS.tasks,
  runsPerTask = FLOW_LIMITS.runsPerTask,
  eventLimit = FLOW_LIMITS.events,
  afterEventId = 0,
  escalationLimit = FLOW_LIMITS.escalations,
  now = () => new Date().toISOString(),
} = {}) {
  const { runtime, config } = openRuntime(projectRoot);
  try {
    // Only this workspace's project. A stale DB can contain a project row from
    // another checkout (the old demo seed did); rendering it would present
    // foreign data as if it were real. If no row matches this root, the panel
    // shows the honest "no project here" state instead of somebody else's DAG.
    const rootPath = resolve(projectRoot);
    const sourceProjects = runtime.db.prepare('SELECT * FROM projects ORDER BY created_at').all();
    const project = sourceProjects.find((candidate) => (
      !candidate.repo_path || resolve(candidate.repo_path) === rootPath
    )) ?? null;
    const projectMismatch = !project && sourceProjects.length > 0;
    const sourceTasks = runtime.listTasks();
    const allTasks = project
      ? sourceTasks.filter((task) => task.project_id == null || task.project_id === project.id)
      : [];
    const projectTaskIds = new Set(allTasks.map((task) => task.id));
    const tasks = allTasks.slice(0, taskLimit);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ids = tasks.map((t) => t.id);

    // Newest N runs per task, from the ASC list the runtime returns.
    const allRuns = runtime.listWorkerRuns().filter((run) => projectTaskIds.has(run.task_id));
    const runsByTask = new Map();
    for (const run of allRuns) {
      const list = runsByTask.get(run.task_id) ?? [];
      list.push(run);
      if (list.length > runsPerTask) list.shift();
      runsByTask.set(run.task_id, list);
    }

    const nowMs = Date.parse(now());
    const runs = tasks.flatMap((task) => (runsByTask.get(task.id) ?? []).slice().reverse().map((run) => {
      const timing = durationOf(run, Number.isFinite(nowMs) ? nowMs : Date.now());
      return {
        taskId: run.task_id,
        runId: run.id,
        attempt: run.attempt ?? null,
        role: task.role ?? null,
        status: run.status ?? 'unknown',
        pid: run.pid ?? null,
        modelProvider: run.model_provider ?? null,
        modelId: run.model_id ?? null,
        tokensIn: run.tokens_in ?? null,
        tokensOut: run.tokens_out ?? null,
        tokensTotal: tokensOf(run),
        durationMs: timing.durationMs,
        durationSource: timing.durationSource,
        costUsdEstimate: run.cost_usd ?? null,
        branch: task.branch ?? null,
        worktreePath: run.worktree_path ?? null,
        orphaned: Boolean(run.orphaned),
        startedAt: run.started_at ?? null,
        finishedAt: run.finished_at ?? null,
      };
    }));

    const routing = tasks.map((task) => {
      const lastRun = (runsByTask.get(task.id) ?? []).at(-1) ?? null;
      const recorded = lastRun?.model_id
        ? { provider: lastRun.model_provider ?? null, model: lastRun.model_id, tier: tierOf(config, lastRun.model_provider, lastRun.model_id) }
        : null;
      let computed = null;
      try {
        computed = runtime.route({
          attempt: task.attempt ?? 0,
          task_class: task.task_class ?? 'normal',
          task_type: task.role ?? 'default',
          complexity: task.complexity ?? null,
        });
      } catch { computed = null; }
      const tier = task.model_tier ?? recorded?.tier ?? computed?.tier ?? null;
      return {
        taskId: task.id,
        tier,
        rule: computed?.rule ?? null,
        provider: recorded?.provider ?? computed?.provider ?? null,
        model: recorded?.model ?? computed?.model ?? null,
        reason: computed?.reason ?? (recorded ? 'recorded run' : 'unavailable'),
        source: recorded ? 'recorded' : (computed ? 'computed' : 'unavailable'),
        partial: !recorded,
        available: tier !== null,
      };
    });
    const routingById = new Map(routing.map((r) => [r.taskId, r]));

    // DAG layers (longest path) and edges.
    const topo = topoSort(tasks) ?? ids;
    const layer = new Map();
    for (const id of topo) {
      const deps = byId.get(id)?.depends_on ?? [];
      layer.set(id, deps.length ? 1 + Math.max(...deps.map((dep) => layer.get(dep) ?? 0)) : 0);
    }
    const edges = tasks.flatMap((task) => (task.depends_on ?? []).map((dep) => ({
      from: dep,
      to: task.id,
      kind: 'depends_on',
      blocking: depsBlocking(task, byId),
      missing: !byId.has(dep),
    })));
    const nodes = tasks.map((task) => ({
      id: task.id,
      title: task.title ?? task.id,
      state: task.state,
      role: task.role ?? null,
      riskClass: task.risk_class ?? null,
      taskClass: task.task_class ?? null,
      attempt: task.attempt ?? 0,
      layer: layer.get(task.id) ?? 0,
      tier: routingById.get(task.id)?.tier ?? null,
      model: routingById.get(task.id)?.model ?? null,
      dependsOn: task.depends_on ?? [],
      resources: task.resources ?? [],
      branch: task.branch ?? null,
      worktreePath: task.worktree_path ?? null,
      waitingOn: task.waiting_on ?? null,
    }));

    // Latest gate result per (task, gate).
    const gates = [];
    const gateSummary = { pass: 0, fail: 0, skipped: 0, unknown: 0, total: 0 };
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = runtime.db.prepare(
        `SELECT task_id, gate, status, run_id, finished_at, log_path FROM test_results
         WHERE task_id IN (${placeholders}) ORDER BY finished_at, id`,
      ).all(...ids);
      const latest = new Map();
      for (const row of rows) latest.set(`${row.task_id}/${row.gate}`, row);
      for (const row of latest.values()) {
        const result = gateClass(row.status);
        gateSummary[result] += 1;
        gateSummary.total += 1;
        gates.push({
          taskId: row.task_id,
          gate: row.gate,
          status: row.status ?? 'unknown',
          result,
          runId: row.run_id ?? null,
          finishedAt: row.finished_at ?? null,
          logPath: row.log_path ?? null,
        });
      }
    }

    // Recent events, newest-limited and returned in ascending order.
    // Initial load shows the most recent N; a polling cursor (after > 0)
    // reads forward in ascending id order so no event is skipped or repeated.
    const eventRows = afterEventId > 0
      ? runtime.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`)
        .all(afterEventId, eventLimit)
      : runtime.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id > ? ORDER BY id DESC LIMIT ?`)
        .all(afterEventId, eventLimit).reverse();
    const events = eventRows.map((row) => {
      const payload = parseJson(row.payload_json, {});
      return {
        id: row.id,
        ts: row.ts ?? null,
        taskId: row.task_id ?? null,
        actor: row.actor ?? null,
        action: row.action ?? null,
        model: row.model ?? null,
        result: row.result ?? null,
        durationMs: row.duration_ms ?? null,
        detail: { from: payload.from ?? null, to: payload.to ?? null, guard: payload.guard ?? null },
      };
    }).filter((event) => project && (event.taskId == null || projectTaskIds.has(event.taskId)));

    // Resource locks and ownership overlap.
    const active = activeTasks(tasks);
    const holders = new Map();
    for (const task of active) {
      for (const resource of resourcesOf(task)) {
        holders.set(resource, [...(holders.get(resource) ?? []), task.id]);
      }
    }
    const locks = {
      cap: 1,
      resources: [...holders.entries()].map(([resource, list]) => ({
        resource,
        holders: list,
        status: list.length > 1 ? 'over-cap' : 'held',
      })),
      pathOwners: active.map((task) => ({ taskId: task.id, patterns: task.allowed_paths ?? [] })),
      violations: checkNoOverlap(tasks),
    };

    // Recorded escalations plus task-state-derived ones (honest source labels).
    let recordedEscalations = [];
    try {
      recordedEscalations = runtime.db.prepare(
        `SELECT id, task_id, level, packet_json, resolution, resolved_by, created_at, resolved_at
         FROM escalations ORDER BY created_at DESC LIMIT ?`,
      ).all(escalationLimit);
    } catch { recordedEscalations = []; }
    const projectEscalations = recordedEscalations
      .filter((row) => projectTaskIds.has(row.task_id));
    const escalations = projectEscalations
      .map((row) => {
      const block = parseJson(row.packet_json, {});
      return {
        id: row.id,
        taskId: row.task_id ?? null,
        level: row.level ?? null,
        trigger: block.trigger ?? null,
        question: clip(block.question, 500),
        recommendation: clip(block.recommendation, 200),
        options: (block.options ?? []).slice(0, 8).map((o) => ({ id: o.id, label: clip(o.label, 120) })),
        resolution: row.resolution ?? null,
        resolvedBy: row.resolved_by ?? null,
        createdAt: row.created_at ?? null,
        resolvedAt: row.resolved_at ?? null,
        source: 'recorded',
      };
    });
    const recordedTaskIds = new Set(escalations.map((e) => e.taskId));
    for (const task of tasks) {
      if (['ESCALATED', 'BLOCKED'].includes(task.state) && !recordedTaskIds.has(task.id)) {
        escalations.push({
          id: `task-state:${task.id}`,
          taskId: task.id,
          level: task.state,
          trigger: null,
          question: clip(task.waiting_on, 500),
          options: [],
          resolution: null,
          createdAt: task.updated_at ?? null,
          source: 'task-state',
        });
      }
    }

    // Spend is computed from this project's runs only. `runtime.spentTotals()`
    // sums every run in the DB, including rows from a foreign/stale project.
    // A field is null when runs exist but none recorded it — the panel renders
    // "—" rather than a fabricated zero. No runs at all is a real zero.
    const spendKnown = {
      cost: allRuns.length === 0 || allRuns.some((run) => run.cost_usd != null),
      duration: allRuns.length === 0 || allRuns.some((run) => run.duration_ms != null),
      tokens: allRuns.length === 0 || allRuns.some((run) => run.tokens_in != null || run.tokens_out != null),
    };
    const totals = allRuns.reduce((total, run) => {
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
    const selected = taskId && byId.has(taskId) ? taskId : null;

    // Effective parallelism (B.10): the same min(cores/2, ram/2, provider,
    // configured) rule the scheduler uses. The panel shows this number instead
    // of guessing from the raw "auto" setting; an older host that omits the
    // field makes the client render "—" rather than invent a cap.
    const configuredParallel = config.execution?.maxParallelWorkers ?? 'auto';
    const projectParallel = config.budgets?.perProject?.maxParallelWorkers ?? 'auto';
    const projectCap = projectParallel === 'auto' ? Infinity : Number(projectParallel);
    let effectiveParallel = null;
    try {
      effectiveParallel = effectiveParallelism({
        maxParallelWorkers: configuredParallel,
        cpus: cpus().length,
        ramGb: totalmem() / (1024 ** 3),
        configured: Number.isFinite(projectCap) ? projectCap : Infinity,
      });
    } catch {
      effectiveParallel = null;
    }

    return {
      ok: true,
      generatedAt: now(),
      project: project
        ? { available: true, id: project.id, name: project.name ?? project.id, state: project.state, blockedState: project.blocked_state ?? null }
        : {
          available: false,
          reason: projectMismatch ? 'project row belongs to another workspace' : 'no projects row',
        },
      limits: { tasks: taskLimit, runsPerTask, events: eventLimit, escalations: escalationLimit },
      totals: {
        tasks: allTasks.length,
        tasksTruncated: allTasks.length > tasks.length,
        workerRuns: allRuns.length,
        orphaned: allRuns.filter((r) => r.orphaned).length,
        byState: nodes.reduce((acc, t) => { acc[t.state] = (acc[t.state] ?? 0) + 1; return acc; }, {}),
        activeTasks: active.length,
        maxParallelWorkers: config.execution?.maxParallelWorkers ?? 'auto',
        parallelism: {
          configured: configuredParallel,
          projectCap: projectParallel,
          effective: effectiveParallel,
          active: active.length,
          saturated: effectiveParallel != null && active.length >= effectiveParallel,
          source: 'config+host',
        },
        spend: { ...spend, costIsEstimate: true },
      },
      tasks: nodes,
      edges,
      runs,
      routing,
      gates,
      gateSummary,
      events,
      eventsMeta: {
        returned: events.length,
        limit: eventLimit,
        hasMore: events.length === eventLimit,
        nextAfterId: eventRows.at(-1)?.id ?? afterEventId,
      },
      locks,
      escalations,
      escalationsMeta: {
        available: projectEscalations.length > 0,
        recorded: projectEscalations.length,
        derived: escalations.length - projectEscalations.length,
      },
      selectedTaskId: selected,
      unavailable: [
        ...(project ? [] : [{
          section: 'project',
          reason: projectMismatch ? 'project row belongs to another workspace' : 'no projects row',
        }]),
        ...(Object.keys(config.tiers ?? {}).length === 0 ? [{ section: 'routing', reason: 'no tiers configured' }] : []),
      ],
    };
  } finally {
    closeRuntime(runtime);
  }
}

/** GET /api/sdlc.flow — bounded visualizer snapshot. */
export function handleFlow(projectRoot, query = {}) {
  if (!existsSync(join(projectRoot, '.sdlc', 'sdlc.db'))) {
    return {
      status: 404,
      body: { ok: false, error: 'NO_PROJECT', detail: 'no complete .sdlc project — auto-setup did not run here; `sdlc init` prints the reason', root: projectRoot, pluginVersion: pluginVersion() },
    };
  }
  const model = buildFlowModel(projectRoot, {
    taskId: query.task ?? null,
    taskLimit: intParam(query.tasks, FLOW_LIMITS.tasks, 1, 1000),
    runsPerTask: intParam(query.runs, FLOW_LIMITS.runsPerTask, 1, 10),
    eventLimit: intParam(query.events, FLOW_LIMITS.events, 1, 500),
    afterEventId: intParam(query.after, 0, 0, Number.MAX_SAFE_INTEGER),
    escalationLimit: intParam(query.escalations, FLOW_LIMITS.escalations, 0, 200),
  });
  // A DB with no project row for THIS workspace is NOT a setup failure — the
  // workspace is ready, it just has no project yet. The distinct code lets
  // the panel say so ("create one with `/sdlc run`") instead of showing the
  // auto-setup-failed card for a healthy, empty workspace.
  if (!model.project.available) {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'NO_PROJECT_ROW',
        detail: `${model.project.reason ? `${model.project.reason} — ` : ''}create one with \`/sdlc run\` in the lead session`,
        root: projectRoot,
        pluginVersion: pluginVersion(),
      },
    };
  }
  return {
    status: 200,
    body: { ...model, pluginVersion: pluginVersion() },
  };
}

export default { buildFlowModel, handleFlow, FLOW_LIMITS };
