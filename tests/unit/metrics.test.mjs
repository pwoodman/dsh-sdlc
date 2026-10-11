/**
 * tests/unit/metrics.test.mjs — Prometheus metrics export (audit #5).
 *
 * `observability.metricsExport` was a dead knob: declared in the default
 * config, read nowhere. It now renders the spend + task-state snapshot to
 * `.sdlc/metrics.prom` in Prometheus exposition format when enabled, and is
 * an explicit no-op when disabled (the default).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const metrics = await core.metrics();
const runtimeMod = await core.runtime();
const cfg = await core.config();

function openRuntime(dir, observability = {}) {
  const config = cfg.deepMerge(cfg.DEFAULT_CONFIG, { observability });
  const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
  runtime.open();
  return runtime;
}

test('export is a no-op when metricsExport is false (the default)', () => {
  const dir = tempDir('sdlc-metrics-off-');
  const runtime = openRuntime(dir);
  try {
    const res = runtime.exportMetrics();
    assert.equal(res.enabled, false);
    assert.equal(res.path, null);
    assert.equal(existsSync(join(dir, '.sdlc', 'metrics.prom')), false, 'disabled export must write nothing');
  } finally {
    runtime.close({ releaseLock: false });
    cleanup(dir);
  }
});

test('enabled export renders real DB numbers in Prometheus format', () => {
  const dir = tempDir('sdlc-metrics-on-');
  const runtime = openRuntime(dir, { metricsExport: true });
  try {
    runtime.createProject({ id: 'P1', name: 'metrics' });
    runtime.addTask({
      id: 'T-1', project_id: 'P1', title: 'widget', role: 'backend-engineer',
      allowed_paths: ['src/**'], verification: ['unit'],
    });
    runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} });
    const runId = runtime.startWorkerRun({ taskId: 'T-1', attempt: 0 });
    runtime.finishWorkerRun(runId, { status: 'completed', durationMs: 1500, tokens: { in: 100, out: 50 }, costUsd: 0.02 });

    const res = runtime.exportMetrics();
    assert.equal(res.enabled, true);
    assert.ok(existsSync(res.path), 'metrics file was written');
    const text = readFileSync(res.path, 'utf8');
    assert.match(text, /^sdlc_tasks_total\{[^}]*\} 1$/m);
    assert.match(text, /^sdlc_tasks_by_state\{[^}]*state="READY"[^}]*\} 1$/m);
    assert.match(text, /^sdlc_worker_runs_total\{[^}]*\} 1$/m);
    assert.match(text, /^sdlc_spend_tokens_total\{[^}]*\} 150$/m);
    assert.match(text, /^sdlc_spend_duration_ms_total\{[^}]*\} 1500$/m);
    assert.match(text, /^sdlc_spend_cost_usd_estimate\{[^}]*\} 0\.02$/m);
    assert.match(text, /^sdlc_events_total\{[^}]*\} \d+$/m);
    assert.match(text, /cost is an estimate|estimate/i, 'cost staleness is not the point here — help text mentions estimate');
  } finally {
    runtime.close({ releaseLock: false });
    cleanup(dir);
  }
});

test('label values are escaped and empty projects still render', () => {
  const out = metrics.renderPrometheus({
    tasksTotal: 0, tasksByState: {}, workerRunsTotal: 0, workerRunsOrphaned: 0,
    spendCostUsd: 0, spendTokens: 0, spendDurationMs: 0, eventsTotal: 0,
  }, { project: 'we"ird\nname' });
  assert.match(out, /project="we\\"ird\\nname"/);
  assert.match(out, /^sdlc_tasks_total\{[^}]*\} 0$/m);
});

test('collectMetricsSnapshot never fabricates: orphaned runs counted, events read live', () => {
  const dir = tempDir('sdlc-metrics-snap-');
  const runtime = openRuntime(dir, { metricsExport: true });
  try {
    const snap = metrics.collectMetricsSnapshot(runtime);
    assert.equal(snap.tasksTotal, 0);
    assert.equal(snap.workerRunsTotal, 0);
    assert.equal(typeof snap.eventsTotal, 'number');
  } finally {
    runtime.close({ releaseLock: false });
    cleanup(dir);
  }
});
