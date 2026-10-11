/**
 * packages/sdlc-core/src/metrics.js — Prometheus metrics export (spec v3 H.1).
 *
 * Closes audit item #5: `observability.metricsExport` was a dead knob —
 * declared in the default config and read nowhere. It now does one honest
 * thing: when `observability.metricsExport` is `true`, `sdlc status --metrics`
 * (and `Runtime.exportMetrics()`) renders the spend + task-state snapshot in
 * Prometheus exposition format to `.sdlc/metrics.prom`. No HTTP server, no
 * pushgateway — a file the operator's scraper can read. When the flag is
 * `false` (default), export is a no-op that reports `enabled: false`.
 *
 * Pure + offline: reads the already-open DatabaseSync handle, writes one file.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const METRICS_FILENAME = 'metrics.prom';

/** Escape a Prometheus label value. */
export function escapeLabel(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Collect the snapshot the exporter renders. All numbers come from live DB
 * queries — never fabricated.
 */
export function collectMetricsSnapshot(runtime) {
  const tasks = runtime.listTasks();
  const byState = {};
  for (const t of tasks) byState[t.state] = (byState[t.state] ?? 0) + 1;
  const runs = runtime.listWorkerRuns();
  const spend = runtime.spentTotals();
  let events = 0;
  try {
    const row = runtime.db.prepare('SELECT COUNT(*) AS n FROM events').get();
    events = row?.n ?? 0;
  } catch { events = 0; }
  return {
    tasksTotal: tasks.length,
    tasksByState: byState,
    workerRunsTotal: runs.length,
    workerRunsOrphaned: runs.filter((r) => r.orphaned).length,
    spendCostUsd: Number(spend.costUsd ?? 0),
    spendTokens: Number(spend.tokens ?? 0),
    spendDurationMs: Number(spend.durationMs ?? 0),
    eventsTotal: events,
  };
}

/** Render the snapshot in Prometheus exposition format. */
export function renderPrometheus(snapshot, { project = 'sdlc' } = {}) {
  const L = [];
  const labels = `project="${escapeLabel(project)}"`;
  L.push('# HELP sdlc_tasks_total Tasks known to the orchestrator.');
  L.push('# TYPE sdlc_tasks_total gauge');
  L.push(`sdlc_tasks_total{${labels}} ${snapshot.tasksTotal}`);
  L.push('# HELP sdlc_tasks_by_state Tasks per state-machine state.');
  L.push('# TYPE sdlc_tasks_by_state gauge');
  for (const [state, n] of Object.entries(snapshot.tasksByState).sort()) {
    L.push(`sdlc_tasks_by_state{${labels},state="${escapeLabel(state)}"} ${n}`);
  }
  L.push('# HELP sdlc_worker_runs_total Worker runs started.');
  L.push('# TYPE sdlc_worker_runs_total counter');
  L.push(`sdlc_worker_runs_total{${labels}} ${snapshot.workerRunsTotal}`);
  L.push('# HELP sdlc_spend_cost_usd_estimate Estimated spend in USD (no currency metadata exists upstream).');
  L.push('# TYPE sdlc_spend_cost_usd_estimate counter');
  L.push(`sdlc_spend_cost_usd_estimate{${labels}} ${snapshot.spendCostUsd}`);
  L.push('# HELP sdlc_spend_tokens_total Tokens attributed to worker runs.');
  L.push('# TYPE sdlc_spend_tokens_total counter');
  L.push(`sdlc_spend_tokens_total{${labels}} ${snapshot.spendTokens}`);
  L.push('# HELP sdlc_spend_duration_ms_total Worker wall-clock in milliseconds.');
  L.push('# TYPE sdlc_spend_duration_ms_total counter');
  L.push(`sdlc_spend_duration_ms_total{${labels}} ${snapshot.spendDurationMs}`);
  L.push('# HELP sdlc_events_total Rows in the append-only event log.');
  L.push('# TYPE sdlc_events_total counter');
  L.push(`sdlc_events_total{${labels}} ${snapshot.eventsTotal}`);
  return L.join('\n') + '\n';
}

/**
 * Export metrics for an open runtime. Returns `{ enabled, path }`.
 * Disabled (the default) writes nothing and reports `enabled: false` —
 * the knob no longer lies.
 */
export function exportMetrics(runtime, { projectRoot = null, outPath = null } = {}) {
  const enabled = Boolean(runtime?.config?.observability?.metricsExport);
  if (!enabled) return { enabled: false, path: null };
  const root = projectRoot ?? runtime.projectRoot ?? process.cwd();
  const target = outPath ?? join(root, '.sdlc', METRICS_FILENAME);
  mkdirSync(dirname(target), { recursive: true });
  const project = projectNameOf(runtime);
  const text = renderPrometheus(collectMetricsSnapshot(runtime), { project });
  writeFileSync(target, text);
  return { enabled: true, path: target };
}

function projectNameOf(runtime) {
  try {
    const rows = runtime.db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').all();
    return rows[0]?.id ?? 'sdlc';
  } catch { return 'sdlc'; }
}

export default { collectMetricsSnapshot, renderPrometheus, exportMetrics, METRICS_FILENAME };
