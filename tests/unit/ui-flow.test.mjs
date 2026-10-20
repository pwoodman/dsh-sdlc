/**
 * tests/unit/ui-flow.test.mjs — the bounded visualizer snapshot.
 *
 * A real temp project/runtime seeds the tasks, DAG edges, a worker run, a
 * gate result, routing and 150 events. The handler must return a valid,
 * bounded payload and never fabricate a missing value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { core, tempDir, cleanup } from '../lib/helpers.mjs';
import { handleFlow, buildFlowModel } from '../../packages/sdlc-client-ui/src/server/flow.js';
import { handleStatus, handleTask, handleCompare } from '../../packages/sdlc-client-ui/src/server/handlers.js';

const routes = await core.uiRoutes();
const runtimeMod = await core.runtime();
const cfgMod = await core.config();

function scaffold() {
  const dir = tempDir('sdlc-flow-');
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  return dir;
}

function seed(dir) {
  const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
  const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
  runtime.open();
  try {
    runtime.createProject({ id: 'P1', name: 'flow' });
    runtime.addTask({
      id: 'T-1', project_id: 'P1', title: 'widget', role: 'backend-engineer',
      allowed_paths: ['src/**'], resources: ['package.json'], verification: ['unit'],
    });
    runtime.addTask({
      id: 'T-2', project_id: 'P1', title: 'child', role: 'qa-engineer',
      allowed_paths: ['tests/**'], depends_on: ['T-1'], resources: ['package.json'],
    });
    runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} });
    runtime.transition('T-1', 'ASSIGNED', 'scheduler', { available: true });
    runtime.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {});
    const runId = runtime.startWorkerRun({
      taskId: 'T-1', attempt: 0, id: 'RUN-A', pid: 4242,
      model: { provider: 'openai', id: 'gpt-4o' },
    });
    runtime.finishWorkerRun(runId, { status: 'completed', durationMs: 1000, tokens: { in: 100, out: 50 }, costUsd: 0.01 });
    runtime.transition('T-1', 'VERIFYING', 'worker-mgr', {});
    runtime.recordTestResults('T-1', runId, { unit: { status: 'pass', logPath: 'u.log' } });
    runtime.state._setState('T-2', 'ASSIGNED');
    for (let i = 0; i < 150; i += 1) {
      runtime.state.record({ taskId: 'T-1', actor: 'test', action: `event-${i}` });
    }
    return { runId };
  } finally {
    runtime.close({ releaseLock: false });
  }
}

test('no database is a 404, never a fabricated payload', () => {
  const dir = tempDir('sdlc-flow-empty-');
  try {
    const res = handleFlow(dir);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'NO_PROJECT');
  } finally { cleanup(dir); }
});

test('the flow payload contains the DAG, runs, routing, gates and locks', () => {
  const dir = scaffold();
  try {
    const { runId } = seed(dir);
    const res = handleFlow(dir, { events: 10 });
    assert.equal(res.status, 200);
    assert.ok(routes.isFlowPayload(res.body), JSON.stringify(res.body).slice(0, 500));
    assert.equal(res.body.tasks.length, 2);
    const t1 = res.body.tasks.find((t) => t.id === 'T-1');
    const t2 = res.body.tasks.find((t) => t.id === 'T-2');
    assert.equal(t2.layer, 1, 'child node is one layer below its dependency');
    assert.ok(res.body.edges.some((e) => e.from === 'T-1' && e.to === 'T-2'));
    const run = res.body.runs.find((r) => r.runId === runId);
    assert.equal(run.tokensTotal, 150);
    assert.equal(run.modelProvider, 'openai');
    assert.equal(run.modelId, 'gpt-4o');
    assert.equal(run.durationSource, 'recorded');
    assert.equal(res.body.gateSummary.pass, 1);
    assert.ok(res.body.gates.some((g) => g.taskId === 'T-1' && g.gate === 'unit' && g.result === 'pass'));
    assert.ok(Array.isArray(res.body.routing) && res.body.routing.every((r) => typeof r.available === 'boolean'));
    assert.equal(res.body.locks.cap, 1);
    assert.ok(res.body.locks.resources.some((l) => l.resource === 'package.json'));
    assert.equal(res.body.totals.tasks, 2);
    assert.equal(res.body.totals.workerRuns, 1);
    const parallel = res.body.totals.parallelism;
    assert.equal(parallel.configured, 'auto');
    assert.ok(Number.isInteger(parallel.effective) && parallel.effective >= 1, 'effective parallelism is a host number');
    assert.equal(parallel.active, res.body.totals.activeTasks);
    assert.equal(typeof parallel.saturated, 'boolean');
  } finally { cleanup(dir); }
});

test('events are bounded, ascending and carry a cursor', () => {
  const dir = scaffold();
  try {
    seed(dir);
    const res = handleFlow(dir, { events: 10, after: 0 });
    assert.equal(res.body.events.length, 10);
    const ids = res.body.events.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(res.body.eventsMeta.returned, 10);
    assert.equal(res.body.eventsMeta.limit, 10);
    assert.equal(res.body.eventsMeta.hasMore, true);
    const next = handleFlow(dir, { events: 10, after: res.body.eventsMeta.nextAfterId });
    assert.equal(next.body.events.length, 0, 'no event newer than the newest cursor');
    assert.equal(next.body.eventsMeta.nextAfterId, res.body.eventsMeta.nextAfterId);
  } finally { cleanup(dir); }
});

test('the model is pure over an explicit limit and rejects malformed payloads', () => {
  const dir = scaffold();
  try {
    seed(dir);
    const model = buildFlowModel(dir, { taskLimit: 1, runsPerTask: 1, eventLimit: 5 });
    assert.equal(model.tasks.length, 1);
    assert.equal(model.totals.tasksTruncated, true);
    assert.equal(routes.isFlowPayload(model), true);
    assert.equal(routes.isFlowPayload({ ...model, gateSummary: undefined }), false);
    assert.equal(routes.isFlowPayload({ ...model, tasks: 'nope' }), false);
  } finally { cleanup(dir); }
});

test('flow and status only expose this workspace project, never a foreign/demo row', () => {
  const dir = scaffold();
  try {
    seed(dir);
    const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
    const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      // A stale demo-style project pointing at a different checkout. Its tasks
      // must never appear in this workspace's flow or status payload.
      runtime.createProject({ id: 'FOREIGN', name: 'demo fullstack (task tracker)', repoPath: '/tmp/some-other-repo' });
      runtime.addTask({ id: 'DEMO-001', project_id: 'FOREIGN', title: 'Task-tracker API + frontend', role: 'fullstack-engineer' });
    } finally { runtime.close({ releaseLock: false }); }

    const flow = handleFlow(dir, { events: 10 });
    assert.equal(flow.status, 200);
    assert.equal(flow.body.project.id, 'P1');
    assert.deepEqual(flow.body.tasks.map((task) => task.id).sort(), ['T-1', 'T-2']);
    assert.equal(flow.body.totals.tasks, 2);
    assert.equal(flow.body.tasks.some((task) => task.id === 'DEMO-001'), false);

    const status = handleStatus(dir);
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.projects.map((project) => project.id), ['P1']);
    assert.deepEqual(status.body.tasks.items.map((task) => task.id).sort(), ['T-1', 'T-2']);
    assert.equal(status.body.tasks.total, 2);
  } finally { cleanup(dir); }
});

test('a DB with only a foreign project answers NO_PROJECT, not foreign rows', () => {
  const dir = scaffold();
  try {
    const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
    const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      runtime.createProject({ id: 'FOREIGN', name: 'demo fullstack (task tracker)', repoPath: '/tmp/some-other-repo' });
      runtime.addTask({ id: 'DEMO-001', project_id: 'FOREIGN', title: 'Task-tracker API + frontend', role: 'fullstack-engineer' });
      runtime.transition('DEMO-001', 'READY', 'scheduler', { depStates: {} });
    } finally { runtime.close({ releaseLock: false }); }

    const flow = handleFlow(dir, { events: 10 });
    assert.equal(flow.status, 404);
    assert.equal(flow.body.error, 'NO_PROJECT');
    assert.match(flow.body.detail, /another workspace/);

    const status = handleStatus(dir);
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.projects, []);
    assert.equal(status.body.tasks.total, 0);
    assert.equal(status.body.workerRuns.total, 0);
    assert.equal(status.body.spend.tokens, 0);
    assert.equal(handleTask(dir, { id: 'DEMO-001' }).status, 404, 'a foreign task is not readable');
    assert.equal(handleCompare(dir, { task: 'DEMO-001', a: 'A', b: 'B' }).status, 404, 'a foreign task is not comparable');
  } finally { cleanup(dir); }
});
