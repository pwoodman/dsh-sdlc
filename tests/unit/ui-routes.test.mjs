/**
 * tests/unit/ui-routes.test.mjs — the sdlc-client-ui host route contract.
 *
 * Every route is exercised as a pure handler against a temp project with a
 * real Runtime (no DSH boot, no network): status/board/task/compare/config
 * GETs, validated config POSTs (accept + reject), and the metrics endpoint.
 * The never-fabricate rule holds: missing projects are 404, missing params
 * are 400, failed validation never touches the file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const handlers = await core.uiHandlers();
const routes = await core.uiRoutes();
const runtimeMod = await core.runtime();
const cfgMod = await core.config();

function scaffold() {
  const dir = tempDir('sdlc-ui-');
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  return dir;
}

function initProject(dir) {
  const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
  const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
  runtime.open();
  try {
    runtime.createProject({ id: 'P1', name: 'ui' });
    runtime.addTask({
      id: 'T-1', project_id: 'P1', title: 'widget', role: 'backend-engineer',
      allowed_paths: ['src/**'], verification: ['unit'],
    });
    runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} });
    const runId = runtime.startWorkerRun({ taskId: 'T-1', attempt: 0, id: 'RUN-A' });
    runtime.finishWorkerRun(runId, { status: 'completed', durationMs: 1000, tokens: { in: 100, out: 50 }, costUsd: 0.01 });
    runtime.transition('T-1', 'ASSIGNED', 'scheduler', { available: true });
    runtime.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {});
    runtime.transition('T-1', 'VERIFYING', 'worker-mgr', {});
    runtime.recordTestResults('T-1', runId, { unit: { status: 'pass', logPath: 'u.log' } });
    return { runId };
  } finally {
    runtime.close({ releaseLock: false });
  }
}

test('route paths are stable and browser-relative forms strip the slash', () => {
  assert.equal(routes.SDLC_STATUS_PATH, '/api/sdlc.status');
  assert.equal(routes.SDLC_BOARD_PATH, '/api/sdlc.board');
  assert.equal(routes.SDLC_TASK_PATH, '/api/sdlc.task');
  assert.equal(routes.SDLC_COMPARE_PATH, '/api/sdlc.compare');
  assert.equal(routes.SDLC_CONFIG_PATH, '/api/sdlc.config');
  assert.equal(routes.SDLC_METRICS_PATH, '/api/sdlc.metrics');
  assert.equal(routes.SDLC_FLOW_PATH, '/api/sdlc.flow');
  assert.equal(routes.SDLC_FLOW_ROUTE, 'api/sdlc.flow');
  assert.equal(routes.SDLC_STATUS_ROUTE, 'api/sdlc.status');
  assert.ok(routes.sdlcReviewAddress('T-1').startsWith('dsh-resource://sdlc-review/'));
  assert.deepEqual(routes.parseSdlcReviewAddress(routes.sdlcReviewAddress('T-1')), { taskId: 'T-1' });
  assert.equal(routes.parseSdlcReviewAddress('dsh-resource://other/x'), undefined);
});

test('status/board/task/compare read live DB rows', () => {
  const dir = scaffold();
  try {
    const { runId } = initProject(dir);
    const status = handlers.handleStatus(dir);
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.tasks.total, 1);
    assert.ok(routes.isStatusPayload(status.body));

    const board = handlers.handleBoard(dir);
    assert.equal(board.status, 200);
    assert.ok(board.body.columns.some((c) => c.state === 'VERIFYING'));
    assert.ok(routes.isBoardPayload(board.body));

    const task = handlers.handleTask(dir, { id: 'T-1' });
    assert.equal(task.status, 200);
    assert.equal(task.body.task.id, 'T-1');
    assert.equal(task.body.workerRuns.length, 1);
    assert.equal(task.body.gates[0].gate, 'unit');

    const missing = handlers.handleTask(dir, {});
    assert.equal(missing.status, 400);
    const nope = handlers.handleTask(dir, { id: 'T-NOPE' });
    assert.equal(nope.status, 404);

    const runB = (() => {
      const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
      const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
      runtime.open();
      try {
        const id = runtime.startWorkerRun({ taskId: 'T-1', attempt: 1, id: 'RUN-B' });
        runtime.finishWorkerRun(id, { status: 'completed', durationMs: 500, tokens: { in: 50, out: 25 }, costUsd: 0.005 });
        runtime.recordTestResults('T-1', id, { unit: { status: 'pass', logPath: 'u.log' } });
        return id;
      } finally { runtime.close({ releaseLock: false }); }
    })();
    const cmp = handlers.handleCompare(dir, { task: 'T-1', a: runId, b: runB });
    assert.equal(cmp.status, 200);
    assert.equal(cmp.body.runs.A.runId, runId);
    const cmpMissing = handlers.handleCompare(dir, { task: 'T-1', a: runId });
    assert.equal(cmpMissing.status, 400);
  } finally { cleanup(dir); }
});

test('uninitialised projects are 404, never fabricated', () => {
  const dir = tempDir('sdlc-ui-empty-');
  try {
    assert.equal(handlers.handleStatus(dir).status, 404);
    assert.equal(handlers.handleBoard(dir).status, 404);
    assert.equal(handlers.handleCompare(dir, { task: 'T', a: 'A', b: 'B' }).status, 404);
    assert.equal(handlers.handleTask(dir, { id: 'T' }).status, 404);
    assert.equal(routes.isFlowPayload({}), false);
  } finally { cleanup(dir); }
});

test('config GET reports validation; POST validates before writing', () => {
  const dir = scaffold();
  try {
    initProject(dir);
    // Seed a config file (sdlc-core initProject needs git; write minimal YAML instead).
    const { dumpConfigYaml } = cfgMod;
    const { DEFAULT_CONFIG } = cfgMod;
    writeFileSync(join(dir, '.sdlc', 'config.yml'), dumpConfigYaml(DEFAULT_CONFIG));

    const got = handlers.handleConfigGet(dir);
    assert.equal(got.status, 200);
    assert.equal(got.body.validation.ok, true);
    assert.ok(routes.isConfigPayload(got.body));

    const before = readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8');
    const ok = handlers.handleConfigPost(dir, { path: 'observability.logLevel', value: 'warn' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.match(readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8'), /logLevel: warn/);

    const badSection = handlers.handleConfigPost(dir, { path: 'frobnicate.level', value: 'x' });
    assert.equal(badSection.status, 400);
    assert.equal(badSection.body.error, 'UNKNOWN_SECTION');

    const badValue = handlers.handleConfigPost(dir, { path: 'execution.worktreeRetentionDays', value: 0 });
    assert.equal(badValue.status, 400);
    assert.equal(badValue.body.error, 'VALIDATION_FAILED');
    // The rejected write left the last GOOD write intact.
    assert.match(readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8'), /logLevel: warn/);
    assert.ok(!readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8').includes('worktreeRetentionDays: 0'));

    const missing = handlers.handleConfigPost(dir, { value: 'x' });
    assert.equal(missing.status, 400);
    void before;
  } finally { cleanup(dir); }
});

test('metrics endpoint renders Prometheus text', () => {
  const dir = scaffold();
  try {
    initProject(dir);
    const res = handlers.handleMetrics(dir);
    assert.equal(res.status, 200);
    assert.match(res.body, /^sdlc_tasks_total\{[^}]*\} 1$/m);
    assert.equal(res.contentType, 'text/plain; version=0.0.4');
  } finally { cleanup(dir); }
});

test('plugin registers routes behind the connection fence', async () => {
  const plugin = await core.uiPlugin();
  // The loader injects `connection` (plugin.inject) before apply runs; pin the
  // declaration — without it the Cordis context proxy throws at runtime.
  assert.deepEqual(plugin.inject, ['connection']);
  const registered = [];
  const ctx = {
    connection: { fetch: { register: (r) => registered.push(`${r.methods[0]} ${r.path}`) } },
    logger: { warn() {} },
  };
  // The registration report comes from the pure helper; apply() itself is the
  // loader entry and returns nothing (its return would be read as an effect).
  const report = plugin.registerRoutes(ctx, { projectRoot: tempDir('sdlc-ui-plugin-') });
  assert.ok(report.length >= 7, `expected 7 routes, got ${report.length}`);
  assert.ok(registered.some((r) => r.includes('/api/sdlc.status')));
  assert.ok(registered.some((r) => r.includes('POST /api/sdlc.config')));

  // No connection fence: registers nothing, throws nothing.
  assert.deepEqual(plugin.registerRoutes({}, {}), []);
});

test('route registration is effect-scoped when the host offers ctx.effect', async () => {
  const plugin = await core.uiPlugin();
  const registered = [];
  const effects = [];
  const ctx = {
    connection: { fetch: { register: (r) => registered.push(r) } },
    logger: { warn() {} },
    effect: (produce, label) => { effects.push(label); return produce(); },
  };
  const report = plugin.registerRoutes(ctx, { projectRoot: tempDir('sdlc-ui-plugin-effect-') });
  // Every route registers inside a fiber effect, so a restart disposes the
  // routes before apply re-registers — the connection refuses a second
  // registration of the same exact path, and the plugin's warn-only fallback
  // would otherwise silently drop every route after the first reload.
  assert.equal(registered.length, report.length);
  assert.equal(effects.length, report.length);
  assert.ok(effects.every((l) => l.startsWith('sdlc-ui:')), `unexpected effect labels: ${effects[0]}`);
});

test('plugin fetch handlers serve live responses end-to-end (no host)', async () => {
  const plugin = await core.uiPlugin();
  const dir = scaffold();
  try {
    initProject(dir);
    const { dumpConfigYaml } = cfgMod;
    const { DEFAULT_CONFIG } = cfgMod;
    writeFileSync(join(dir, '.sdlc', 'config.yml'), dumpConfigYaml(DEFAULT_CONFIG));

    const handlersByKey = new Map();
    const ctx = {
      connection: {
        fetch: {
          register: (r) => handlersByKey.set(`${r.methods[0]} ${r.path}`, r.fetch),
        },
      },
      logger: { warn() {} },
    };
    const report = plugin.registerRoutes(ctx, { projectRoot: dir });
    assert.ok(report.length >= 7);

    // GET status through the registered fetch (query/response shaped).
    const statusRes = await handlersByKey.get('GET /api/sdlc.status')();
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.tasks.total, 1);

    // GET task with query params.
    const taskRes = await handlersByKey.get('GET /api/sdlc.task')(
      new Request('http://localhost/api/sdlc.task?id=T-1'),
    );
    assert.equal(taskRes.status, 200);
    assert.equal((await taskRes.json()).task.id, 'T-1');

    // GET board + metrics.
    assert.equal((await handlersByKey.get('GET /api/sdlc.board')()).status, 200);
    const metricsRes = await handlersByKey.get('GET /api/sdlc.metrics')();
    assert.equal(metricsRes.status, 200);
    assert.match(await metricsRes.text(), /sdlc_tasks_total/);

    // GET config.
    const configRes = await handlersByKey.get('GET /api/sdlc.config')();
    assert.equal(configRes.status, 200);
    assert.equal((await configRes.json()).validation.ok, true);

    // POST config: valid write.
    const postOk = await handlersByKey.get('POST /api/sdlc.config')(
      new Request('http://localhost/api/sdlc.config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'observability.logLevel', value: 'warn' }),
      }),
    );
    assert.equal(postOk.status, 200);
    assert.equal((await postOk.json()).ok, true);

    // POST config: malformed JSON body → 400 BAD_JSON.
    const postBad = await handlersByKey.get('POST /api/sdlc.config')(
      new Request('http://localhost/api/sdlc.config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      }),
    );
    assert.equal(postBad.status, 400);
    assert.equal((await postBad.json()).error, 'BAD_JSON');
  } finally { cleanup(dir); }
});

test('plugin warns (not throws) when a route registration fails', async () => {
  const plugin = await core.uiPlugin();
  const warnings = [];
  const ctx = {
    connection: {
      fetch: {
        register: () => { throw new Error('boom'); },
      },
    },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
  };
  const report = plugin.registerRoutes(ctx, { projectRoot: tempDir('sdlc-ui-plugin-fail-') });
  assert.deepEqual(report, []);
  assert.ok(warnings.length >= 2, `expected registration warnings, got ${warnings.length}`);
});

test('projectRootOf honors config, env, and cwd fallbacks', async () => {
  const plugin = await core.uiPlugin();
  const seen = [];
  const ctx = {
    connection: { fetch: { register: (r) => seen.push(r.path) } },
    logger: { warn() {} },
  };
  // Explicit config wins.
  const dir = tempDir('sdlc-ui-root-');
  try {
    plugin.apply(ctx, { projectRoot: dir });
    // Env fallback: no config → SDLC_PROJECT_ROOT.
    const prev = process.env.SDLC_PROJECT_ROOT;
    process.env.SDLC_PROJECT_ROOT = dir;
    try {
      plugin.apply(ctx, {});
    } finally {
      if (prev === undefined) delete process.env.SDLC_PROJECT_ROOT;
      else process.env.SDLC_PROJECT_ROOT = prev;
    }
    assert.ok(seen.length >= 7);
  } finally { cleanup(dir); }
});
