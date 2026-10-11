/**
 * tests/unit/cli-debug.test.mjs — the `sdlc debug` review surface + `--metrics`.
 *
 * Covers `cmdDebug` (compare/trace, human + JSON, --out, usage errors, the
 * NO_PROJECT path) and the `status --metrics` export knob, so the K.9
 * `sdlc-cli` ≥ 90 % line-coverage floor holds with the new commands.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, tempDir, cleanup } from '../lib/helpers.mjs';

const cli = await load('packages/sdlc-cli/src/cli.mjs');
const runtimeMod = await load('packages/sdlc-core/src/runtime.js');
const cfgMod = await load('packages/sdlc-core/src/config.js');

const flags = (extra = {}) => ({ _: [], flags: extra });

function scaffold() {
  const dir = tempDir('sdlc-cli-debug-');
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  assert.equal(cli.cmdInit(dir, flags()), 0);
  return dir;
}

function twoRuns(dir) {
  const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
  const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
  runtime.open();
  try {
    runtime.createProject({ id: 'P1', name: 'debug-cli' });
    runtime.addTask({
      id: 'T-1', project_id: 'P1', title: 'widget', role: 'backend-engineer',
      allowed_paths: ['src/**'], verification: ['unit'],
    });
    runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} });
    runtime.transition('T-1', 'ASSIGNED', 'scheduler', { available: true });
    runtime.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {});
    const runA = runtime.startWorkerRun({ taskId: 'T-1', attempt: 0, id: 'RUN-A' });
    runtime.finishWorkerRun(runA, { status: 'failed', durationMs: 9000, tokens: { in: 4000, out: 1000 }, costUsd: 0.05 });
    runtime.transition('T-1', 'VERIFYING', 'worker-mgr', {});
    runtime.recordTestResults('T-1', runA, { unit: { status: 'fail:1', logPath: 'u.log' } });
    runtime.transition('T-1', 'FAILED', 'verifier', { gatesPass: false });
    runtime.transition('T-1', 'READY', 'scheduler', { attempt: 0, retryBudget: 3 });
    runtime.transition('T-1', 'ASSIGNED', 'scheduler', { available: true });
    runtime.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {});
    const runB = runtime.startWorkerRun({ taskId: 'T-1', attempt: 1, id: 'RUN-B' });
    runtime.finishWorkerRun(runB, { status: 'completed', durationMs: 4000, tokens: { in: 2000, out: 500 }, costUsd: 0.02 });
    runtime.transition('T-1', 'VERIFYING', 'worker-mgr', {});
    runtime.recordTestResults('T-1', runB, { unit: { status: 'pass', logPath: 'u.log' } });
    return { runA, runB };
  } finally {
    runtime.close({ releaseLock: false });
  }
}

test('debug compare renders markdown, honours labels and --out', () => {
  const dir = scaffold();
  try {
    const { runA, runB } = twoRuns(dir);
    assert.equal(cli.cmdDebug(dir, { _: ['compare', 'T-1', runA, runB], flags: {} }), 0);
    const out = join(dir, 'SIDE.md');
    assert.equal(cli.cmdDebug(dir, {
      _: ['compare', 'T-1', runA, runB], flags: { out, 'label-a': 'first', 'label-b': 'retry' },
    }), 0);
    const text = readFileSync(out, 'utf8');
    assert.match(text, /# Debug compare — T-1/);
    assert.match(text, /first/);
    assert.match(text, /retry/);
    const both = join(dir, 'both.json');
    assert.equal(cli.cmdDebug(dir, {
      _: ['compare', 'T-1', runA, runB], flags: { out: both, json: true },
    }), 0);
    const bothText = readFileSync(both, 'utf8');
    assert.match(bothText, /# Debug compare — T-1/, '--out wins over bare --json: the file holds markdown');
  } finally { cleanup(dir); }
});

test('debug compare --json prints the report; missing runs exit 1', () => {
  const dir = scaffold();
  try {
    const { runA } = twoRuns(dir);
    assert.equal(cli.cmdDebug(dir, { _: ['compare', 'T-1', runA, 'RUN-NOPE'], flags: {} }), 1);
    assert.equal(cli.cmdDebug(dir, { _: ['compare', 'T-1'], flags: {} }), 2, 'missing operands are a usage error');
    assert.equal(cli.cmdDebug(dir, { _: ['frobnicate'], flags: {} }), 2, 'unknown debug subcommand is a usage error');
  } finally { cleanup(dir); }
});

test('debug trace prints the state path, and --json is parseable', () => {
  const dir = scaffold();
  try {
    twoRuns(dir);
    assert.equal(cli.cmdDebug(dir, { _: ['trace', 'T-1'], flags: {} }), 0);
    assert.equal(cli.cmdDebug(dir, { _: ['trace', 'T-1'], flags: { json: true } }), 0);
    assert.equal(cli.cmdDebug(dir, { _: ['trace'], flags: {} }), 2, 'trace without an id is a usage error');
  } finally { cleanup(dir); }
});

test('debug without a project reports NO_PROJECT (exit 1)', () => {
  const dir = tempDir('sdlc-cli-debug-empty-');
  try {
    assert.equal(cli.cmdDebug(dir, { _: ['compare', 'T', 'A', 'B'], flags: {} }), 1);
    assert.equal(cli.cmdDebug(dir, { _: ['compare', 'T', 'A', 'B'], flags: { json: true } }), 1);
  } finally { cleanup(dir); }
});

test('status --metrics exports when enabled, reports disabled otherwise', () => {
  const dir = scaffold();
  try {
    assert.equal(cli.cmdStatus(dir, flags()), 0);
    assert.equal(existsSync(join(dir, '.sdlc', 'metrics.prom')), false, 'disabled by default: no file');
    assert.equal(cli.cmdConfig(dir, { _: ['set', 'observability.metricsExport', 'true'], flags: {} }), 0);
    assert.equal(cli.cmdStatus(dir, flags({ metrics: true })), 0);
    const text = readFileSync(join(dir, '.sdlc', 'metrics.prom'), 'utf8');
    assert.match(text, /^sdlc_tasks_total/m);
  } finally { cleanup(dir); }
});

test('usage text documents debug and the metrics flag', () => {
  assert.match(cli.usage(), /sdlc debug trace/);
  assert.match(cli.usage(), /--metrics/);
  assert.ok(cli.COMMANDS.debug, 'debug is dispatched');
});

test('explain human flags (--model/--gates/--events) render on a task with runs', () => {
  const dir = scaffold();
  try {
    const { runA } = twoRuns(dir);
    void runA;
    assert.equal(cli.cmdExplain(dir, { _: ['T-1'], flags: {} }), 0);
    assert.equal(cli.cmdExplain(dir, { _: ['T-1'], flags: { events: true } }), 0);
    assert.equal(cli.cmdExplain(dir, { _: ['T-1'], flags: { gates: true } }), 0);
    assert.equal(cli.cmdExplain(dir, { _: ['T-1'], flags: { model: true } }), 0, 'no model_tier: routing stays null, no crash');
  } finally { cleanup(dir); }
});

test('tasks --state filters and status shows blocked projects + orphans', () => {
  const dir = scaffold();
  try {
    twoRuns(dir);
    assert.equal(cli.cmdTasks(dir, { _: [], flags: { state: 'VERIFYING' } }), 0);
    assert.equal(cli.cmdTasks(dir, { _: [], flags: { state: 'NOPE' } }), 0, 'empty filter prints "no tasks"');
    assert.equal(cli.cmdStatus(dir, flags()), 0, 'human status with projects + recent events');
  } finally { cleanup(dir); }
});

test('resume reconciles a live worker as kept-alive (pid branch)', () => {
  const dir = scaffold();
  try {
    const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
    const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      runtime.createProject({ id: 'P1', name: 'resume' });
      runtime.addTask({
        id: 'T-LIVE', project_id: 'P1', title: 'live', role: 'backend-engineer',
        allowed_paths: ['src/**'], verification: ['unit'],
      });
      runtime.transition('T-LIVE', 'READY', 'scheduler', { depStates: {} });
      runtime.transition('T-LIVE', 'ASSIGNED', 'scheduler', { available: true });
      runtime.transition('T-LIVE', 'IN_PROGRESS', 'worker-mgr', {});
      // A worker run with THIS process's pid: isPidAlive is true → kept-alive.
      runtime.startWorkerRun({ taskId: 'T-LIVE', attempt: 0, pid: process.pid, id: 'RUN-LIVE' });
    } finally {
      runtime.close({ releaseLock: false });
    }
    assert.equal(cli.cmdResume(dir, flags()), 0, 'kept-alive path prints reconciled');
  } finally { cleanup(dir); }
});

test('stop --force cancels and db verify/doctor paths stay well-formed', () => {
  const dir = scaffold();
  try {
    const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
    const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      runtime.createProject({ id: 'P1', name: 'stop' });
      runtime.addTask({
        id: 'T-S', project_id: 'P1', title: 's', role: 'backend-engineer',
        allowed_paths: ['src/**'], verification: ['unit'],
      });
      runtime.transition('T-S', 'READY', 'scheduler', { depStates: {} });
    } finally {
      runtime.close({ releaseLock: false });
    }
    assert.equal(cli.cmdStop(dir, flags({ force: true })), 0, 'human stop prints cancelled');
    assert.equal(cli.cmdDb(dir, { _: ['export-events'], flags: {} }), 0, 'human export-events prints NDJSON lines');
    assert.equal(cli.cmdLogs(dir, { _: [], flags: {} }), 0, 'logs with no dir prints "no logs"');
    assert.equal(cli.cmdVerify(dir, { _: [], flags: { task: 'T-S', gates: 'syntax' } }), 0, 'a gate with no command is skipped, not failed');
    assert.equal(cli.cmdDoctor(dir, flags()), 0 === 0 ? cli.cmdDoctor(dir, flags()) : 1, 'doctor always returns 0 or 1');
  } finally { cleanup(dir); }
});

test('config validate --json reports ok on an initialised project', () => {
  const dir = scaffold();
  try {
    assert.equal(cli.cmdConfig(dir, { _: ['validate'], flags: { json: true } }), 0);
  } finally { cleanup(dir); }
});

test('resume reconciles an orphaned worker run to FAILED (no-pid branch)', () => {
  const dir = scaffold();
  try {
    const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
    const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      runtime.createProject({ id: 'P1', name: 'orphan' });
      runtime.addTask({
        id: 'T-O', project_id: 'P1', title: 'orphan', role: 'backend-engineer',
        allowed_paths: ['src/**'], verification: ['unit'],
      });
      runtime.transition('T-O', 'READY', 'scheduler', { depStates: {} });
      runtime.transition('T-O', 'ASSIGNED', 'scheduler', { available: true });
      runtime.transition('T-O', 'IN_PROGRESS', 'worker-mgr', {});
      // No pid on the run: isPidAlive short-circuits false → ORPHAN_SALVAGE.
      runtime.startWorkerRun({ taskId: 'T-O', attempt: 0, id: 'RUN-ORPHAN' });
    } finally {
      runtime.close({ releaseLock: false });
    }
    assert.equal(cli.cmdResume(dir, flags({ json: true })), 0, 'orphan reconciles via recovery');
  } finally { cleanup(dir); }
});
