/**
 * tests/unit/debug.test.mjs — the debug compare surface (time/tokens/tracepaths).
 *
 * The debug plugin option: two worker runs of one task, side by side —
 * wall-clock, tokens, cost, gate outcomes, state-machine trace path. All
 * numbers come from `sdlc.db` rows; a missing run renders as unavailable,
 * never as zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const debug = await core.debug();
const runtimeMod = await core.runtime();
const cfg = await core.config();

function openRuntime(dir) {
  const config = cfg.deepMerge(cfg.DEFAULT_CONFIG, {});
  const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
  runtime.open();
  return runtime;
}

/** Drive a task to a failed attempt, retry, then accept — two real runs. */
function twoAttemptFixture(runtime) {
  runtime.createProject({ id: 'P1', name: 'debug' });
  runtime.addTask({
    id: 'T-1', project_id: 'P1', title: 'Add the widget', role: 'backend-engineer',
    allowed_paths: ['src/**'], verification: ['unit'],
  });
  runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} });
  runtime.transition('T-1', 'ASSIGNED', 'scheduler', { available: true });
  runtime.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {});
  const runA = runtime.startWorkerRun({ taskId: 'T-1', attempt: 0, id: 'RUN-A' });
  runtime.finishWorkerRun(runA, { status: 'failed', exitCode: 1, durationMs: 9000, tokens: { in: 4000, out: 1000 }, costUsd: 0.05 });
  runtime.transition('T-1', 'VERIFYING', 'worker-mgr', {});
  runtime.recordTestResults('T-1', runA, { unit: { status: 'fail:1', logPath: 'unit.log' } });
  runtime.transition('T-1', 'FAILED', 'verifier', { gatesPass: false });
  runtime.transition('T-1', 'READY', 'scheduler', { attempt: 0, retryBudget: 3 });
  runtime.transition('T-1', 'ASSIGNED', 'scheduler', { available: true });
  runtime.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {});
  const runB = runtime.startWorkerRun({ taskId: 'T-1', attempt: 1, id: 'RUN-B' });
  runtime.finishWorkerRun(runB, { status: 'completed', exitCode: 0, durationMs: 4000, tokens: { in: 2000, out: 500 }, costUsd: 0.02 });
  runtime.transition('T-1', 'VERIFYING', 'worker-mgr', {});
  runtime.recordTestResults('T-1', runB, { unit: { status: 'pass', logPath: 'unit.log' } });
  return { runA, runB };
}

test('compareRuns shows time/tokens/cost side by side with deltas', () => {
  const dir = tempDir('sdlc-debug-');
  const runtime = openRuntime(dir);
  try {
    const { runA, runB } = twoAttemptFixture(runtime);
    const report = debug.compareRuns(runtime, 'T-1', runA, runB, { labelA: 'first', labelB: 'retry' });
    assert.equal(report.task.id, 'T-1');
    assert.equal(report.runs.A.status, 'failed');
    assert.equal(report.runs.B.status, 'completed');
    assert.equal(report.runs.A.tokensTotal, 5000);
    assert.equal(report.runs.B.tokensTotal, 2500);
    assert.equal(report.deltas.tokensTotal.delta, -2500);
    assert.equal(report.deltas.durationMs.delta, -5000);
    assert.ok(report.deltas.costUsdEstimate.delta < 0, 'retry cost less than the failed attempt');
    const unit = report.gatesCompared.find((g) => g.gate === 'unit');
    assert.ok(unit, 'unit gate compared');
    assert.equal(unit.changed, true);
  } finally {
    runtime.close({ releaseLock: false });
    cleanup(dir);
  }
});

test('tracePathFor replays the state machine from the event log', () => {
  const dir = tempDir('sdlc-debug-trace-');
  const runtime = openRuntime(dir);
  try {
    twoAttemptFixture(runtime);
    const path = debug.tracePathFor(runtime, 'T-1');
    const states = path.map((p) => p.to).filter(Boolean);
    assert.ok(states.includes('READY'), `trace visits READY (got ${states.join(',')})`);
    assert.ok(states.includes('FAILED'), `trace visits FAILED (got ${states.join(',')})`);
    assert.ok(states.filter((s) => s === 'READY').length >= 2, 'retry re-visits READY — the loop is visible');
  } finally {
    runtime.close({ releaseLock: false });
    cleanup(dir);
  }
});

test('a missing run is unavailable, never zero', () => {
  const dir = tempDir('sdlc-debug-missing-');
  const runtime = openRuntime(dir);
  try {
    twoAttemptFixture(runtime);
    const report = debug.compareRuns(runtime, 'T-1', 'RUN-A', 'RUN-NOPE');
    assert.equal(report.runs.A.available, true);
    assert.equal(report.runs.B.available, false);
    assert.match(report.runs.B.reason, /no worker_runs row/);
    assert.equal(report.deltas, null, 'no deltas without two real runs');
    const text = debug.renderSideBySide(report);
    assert.match(text, /missing/);
    assert.doesNotMatch(text, /\| tokens total \| 5000 \| 0 \|/);
  } finally {
    runtime.close({ releaseLock: false });
    cleanup(dir);
  }
});

test('renderSideBySide emits the review table with gates + trace', () => {
  const dir = tempDir('sdlc-debug-render-');
  const runtime = openRuntime(dir);
  try {
    const { runA, runB } = twoAttemptFixture(runtime);
    const text = debug.renderSideBySide(debug.compareRuns(runtime, 'T-1', runA, runB));
    assert.match(text, /# Debug compare — T-1/);
    assert.match(text, /\| wall-clock \|/);
    assert.match(text, /\| tokens total \|/);
    assert.match(text, /\| cost \(est\.\) \|/);
    assert.match(text, /## Gates/);
    assert.match(text, /## Trace path/);
    assert.match(text, /Cost is an estimate/);
  } finally {
    runtime.close({ releaseLock: false });
    cleanup(dir);
  }
});
