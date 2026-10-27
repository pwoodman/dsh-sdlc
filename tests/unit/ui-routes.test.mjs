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
import { existsSync, readFileSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
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
  assert.equal(routes.SDLC_RUN_PATH, '/api/sdlc.tasks.run');
  assert.equal(routes.SDLC_ACTION_PATH, '/api/sdlc.action');
  assert.equal(routes.SDLC_ACTION_ROUTE, 'api/sdlc.action');
  assert.equal(routes.SDLC_COMPARE_PATH, '/api/sdlc.compare');
  assert.equal(routes.SDLC_CONFIG_PATH, '/api/sdlc.config');
  assert.equal(routes.SDLC_METRICS_PATH, '/api/sdlc.metrics');
  assert.equal(routes.SDLC_FLOW_PATH, '/api/sdlc.flow');
  assert.equal(routes.SDLC_FLOW_ROUTE, 'api/sdlc.flow');
  assert.equal(routes.SDLC_STATUS_ROUTE, 'api/sdlc.status');
  assert.equal(routes.SDLC_RUN_ROUTE, 'api/sdlc.tasks.run');
  assert.ok(routes.sdlcReviewAddress('T-1').startsWith('dsh-resource://sdlc-review/'));
  assert.deepEqual(routes.parseSdlcReviewAddress(routes.sdlcReviewAddress('T-1')), { taskId: 'T-1' });
  assert.equal(routes.parseSdlcReviewAddress('dsh-resource://other/x'), undefined);
});

test('the session cwd overrides the host process cwd, safely', async () => {
  const plugin = await core.uiPlugin();
  const dirA = tempDir('sdlc-ui-root-a-');
  const dirB = tempDir('sdlc-ui-root-b-');
  try {
    const request = (cwd) => new Request(`http://localhost/api/sdlc.status?cwd=${encodeURIComponent(cwd)}`);
    // The browser's session workspace wins over the Desktop app's process cwd.
    assert.equal(plugin.resolveProjectRoot({ projectRoot: dirA }, request(dirB)), dirB);
    // Relative, missing, and NUL-bearing paths fall back to the configured root.
    assert.equal(plugin.resolveProjectRoot({ projectRoot: dirA }, request('relative/dir')), dirA);
    assert.equal(plugin.resolveProjectRoot({ projectRoot: dirA }, request(join(dirA, 'does-not-exist'))), dirA);
    assert.equal(plugin.resolveProjectRoot({ projectRoot: dirA }, request(`${dirA}\0evil`)), dirA);
    assert.equal(plugin.resolveProjectRoot({ projectRoot: dirA }), dirA);
  } finally {
    cleanup(dirA);
    cleanup(dirB);
  }
});

test('status/board/task/compare read live DB rows', () => {
  const dir = scaffold();
  try {
    const { runId } = initProject(dir);
    const status = handlers.handleStatus(dir);
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.tasks.total, 1);
    assert.equal(typeof status.body.pluginVersion, 'string');
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
    const post = handlers.handleConfigPost(dir, { path: 'observability.logLevel', value: 'warn' });
    assert.equal(post.status, 404);
    assert.equal(post.body.error, 'NO_PROJECT');
    assert.equal(existsSync(join(dir, '.sdlc')), false, 'a config write must not create .sdlc');
    assert.equal(routes.isFlowPayload({}), false);
  } finally { cleanup(dir); }
});

test('host model adoption rewrites tiers and records an explicit unknown price', () => {
  const dir = scaffold();
  try {
    initProject(dir);
    const { dumpConfigYaml } = cfgMod;
    const { DEFAULT_CONFIG } = cfgMod;
    writeFileSync(join(dir, '.sdlc', 'config.yml'), dumpConfigYaml(DEFAULT_CONFIG));
    const host = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' };

    const adopted = handlers.handleHostAdopt(dir, host);
    assert.equal(adopted.status, 200);
    assert.equal(adopted.body.ok, true);
    const { config } = cfgMod.loadConfig(dir);
    assert.equal(config.tiers.cheap[0].provider, 'deepseek-account');
    assert.equal(config.tiers.base[0].provider, 'deepseek-account');
    assert.equal(config.tiers.elevated[0].model, 'deepseek-flash');
    assert.deepEqual(config.pricing['deepseek-account/deepseek-flash'], { input: null, output: null, unknown: true });
    assert.equal(handlers.handleConfigGet(dir, host).body.hostModel.provider, 'deepseek-account');
    assert.equal(handlers.handleConfigGet(dir, host).body.validation.ok, true);

    // No harness model (e.g. an older host or a non-Agent context) is a 409,
    // not a silent fallback to a different provider that would need a key.
    assert.equal(handlers.handleHostAdopt(dir, null).status, 409);
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
  assert.ok(report.length >= 8, `expected 8 routes, got ${report.length}`);
  assert.ok(registered.some((r) => r.includes('/api/sdlc.status')));
  assert.ok(registered.some((r) => r.includes('POST /api/sdlc.config')));
  assert.ok(registered.some((r) => r.includes('POST /api/sdlc.tasks.run')), 'run route is registered');

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

    // The browser's session workspace overrides the fallback root. dirOther is
    // a fresh workspace: honoring ?cwd BOOTSTRAPS IT THERE — proving the host
    // read the session workspace, not the fallback project (which already
    // existed before this request and gains nothing).
    const dirOther = scaffold();
    try {
      const otherStatus = await handlersByKey.get('GET /api/sdlc.status')(
        new Request(`http://localhost/api/sdlc.status?cwd=${encodeURIComponent(dirOther)}`),
      );
      assert.equal(otherStatus.status, 200, 'the session workspace is set up on demand');
      assert.ok(existsSync(join(dirOther, '.sdlc', 'sdlc.db')), 'the bootstrap landed in dirOther');
      // A bootstrapped fresh workspace is READY on first touch: the flow
      // snapshot auto-creates the default project (Track 0 AUTO-ON), so the
      // panel shows the active state instead of the auto-setup-failed card.
      const otherFlow = await handlersByKey.get('GET /api/sdlc.flow')(
        new Request(`http://localhost/api/sdlc.flow?cwd=${encodeURIComponent(dirOther)}`),
      );
      assert.equal(otherFlow.status, 200);
      const otherFlowBody = await otherFlow.json();
      assert.equal(otherFlowBody.ok, true);
      assert.equal(otherFlowBody.project.id, 'default', 'first Lead touch auto-created the default project');
    } finally { cleanup(dirOther); }

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

// ── the no-init contract at the panel surface (F.4) ──────────────────────────

/** Register the plugin against a fake host, capturing route fetchers. */
async function registerCaptured(plugin, config = {}) {
  const handlersByKey = new Map();
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }) }
      : undefined,
    connection: { fetch: { register: (r) => handlersByKey.set(`${r.methods[0]} ${r.path}`, r.fetch) } },
    logger: { warn() {} },
  };
  const report = plugin.registerRoutes(ctx, config);
  return { handlersByKey, report };
}

test('the first panel request bootstraps the workspace with the Harness route', async () => {
  const plugin = await core.uiPlugin();
  const dir = scaffold(); // markers, but no .sdlc — a workspace never initialised
  try {
    const { handlersByKey } = await registerCaptured(plugin, {});
    assert.equal(existsSync(join(dir, '.sdlc')), false, 'precondition: nothing initialised');

    const res = await handlersByKey.get('GET /api/sdlc.status')(
      new Request(`http://localhost/api/sdlc.status?cwd=${encodeURIComponent(dir)}`),
    );
    assert.equal(res.status, 200, 'opening the panel on a fresh workspace bootstraps it');
    const body = await res.json();
    assert.equal(body.ok, true);

    // The materialised config routes every tier at the Harness's signed-in
    // model (the live service selection), so no provider key is ever needed.
    assert.ok(existsSync(join(dir, '.sdlc', 'sdlc.db')));
    const config = readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8');
    assert.match(config, /provider: deepseek-account/);
    assert.match(config, /model: deepseek-flash/);
    assert.match(config, /reasoningEffort: high/);
    assert.doesNotMatch(config, /openai|anthropic/);
    assert.match(config, /unknown: true/);

    // Settings shows the same live route on the bootstrapped project.
    const cfgRes = await handlersByKey.get('GET /api/sdlc.config')(
      new Request(`http://localhost/api/sdlc.config?cwd=${encodeURIComponent(dir)}`),
    );
    const cfgBody = await cfgRes.json();
    assert.equal(cfgBody.exists, true);
    assert.equal(cfgBody.hostModel.provider, 'deepseek-account');
    assert.equal(cfgBody.validation.ok, true);

    // One click adopts the same route into the (already adopted) config —
    // idempotent, and the write fence is untouched: POST config never
    // bootstraps a DIFFERENT workspace by itself.
    const adoptRes = await handlersByKey.get('POST /api/sdlc.host')(
      new Request(`http://localhost/api/sdlc.host?cwd=${encodeURIComponent(dir)}`, { method: 'POST', body: '{}' }),
    );
    assert.equal(adoptRes.status, 200);
    assert.equal((await adoptRes.json()).ok, true);
  } finally { cleanup(dir); }
});

test('the panel opens on a markerless workspace — manual gates, no dead end', async () => {
  const plugin = await core.uiPlugin();
  const dir = tempDir('sdlc-ui-markerless-'); // no stack marker at all
  try {
    // Hermetic route via the row-config override (no live service, no DSH_HOME).
    const { handlersByKey } = await registerCaptured(plugin, {
      hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    });

    // The user-facing contract: opening the panel on ANY workspace sets it
    // up. A folder with no lockfile marker gets verification.detection:
    // manual and empty gates — the honest artifact, not a failure card.
    const first = await handlersByKey.get('GET /api/sdlc.status')(
      new Request(`http://localhost/api/sdlc.status?cwd=${encodeURIComponent(dir)}`),
    );
    assert.equal(first.status, 200, 'a markerless workspace is not a dead end');
    assert.equal((await first.json()).ok, true);
    assert.ok(existsSync(join(dir, '.sdlc', 'sdlc.db')));
    const config = readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8');
    assert.match(config, /provider: deepseek-account/);
    assert.match(config, /detection: manual/);
    assert.match(config, /gates: \{\}/);
    assert.doesNotMatch(config, /openai|anthropic/);

    // Settings reports the same project, with the visible vacuous-verification
    // warning so the state is never silent.
    const cfg = await handlersByKey.get('GET /api/sdlc.config')(
      new Request(`http://localhost/api/sdlc.config?cwd=${encodeURIComponent(dir)}`),
    );
    const cfgBody = await cfg.json();
    assert.equal(cfgBody.exists, true);
    assert.ok(cfgBody.validation.warnings.some((w) => /manual and no gates are authored/.test(w)));

    // Adding a stack marker later does not silently re-detect: the authored
    // (manual) config is preserved; re-detection is `sdlc init --reconfigure`.
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const second = await handlersByKey.get('GET /api/sdlc.status')(
      new Request(`http://localhost/api/sdlc.status?cwd=${encodeURIComponent(dir)}`),
    );
    assert.equal(second.status, 200);
    assert.match(readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8'), /detection: manual/);
  } finally { cleanup(dir); }
});

test('bootstrap never rewrites a config the user already authored', async () => {
  const plugin = await core.uiPlugin();
  const dir = scaffold();
  try {
    const { handlersByKey } = await registerCaptured(plugin, {
      hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    });
    // First touch bootstraps with the route…
    await handlersByKey.get('GET /api/sdlc.status')(
      new Request(`http://localhost/api/sdlc.status?cwd=${encodeURIComponent(dir)}`),
    );
    const configPath = join(dir, '.sdlc', 'config.yml');
    // …then the user edits their config (here: their own tier choice).
    writeFileSync(configPath, 'observability:\n  logLevel: debug\n');
    // A different live route and a panel reload must not clobber the file.
    const { handlersByKey: reloaded } = await registerCaptured(plugin, {
      hostModel: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
    });
    await reloaded.get('GET /api/sdlc.status')(
      new Request(`http://localhost/api/sdlc.status?cwd=${encodeURIComponent(dir)}`),
    );
    assert.equal(readFileSync(configPath, 'utf8'), 'observability:\n  logLevel: debug\n');
    // Changing the route is the explicit Settings action, and it works.
    const adopt = await reloaded.get('POST /api/sdlc.host')(
      new Request(`http://localhost/api/sdlc.host?cwd=${encodeURIComponent(dir)}`, { method: 'POST', body: '{}' }),
    );
    assert.equal(adopt.status, 200);
    assert.match(readFileSync(configPath, 'utf8'), /deepseek-reasoner/);
  } finally { cleanup(dir); }
});

test('a config write cannot poison an incomplete workspace', async () => {
  const plugin = await core.uiPlugin();
  const dir = tempDir('sdlc-ui-leftover-');
  try {
    const { handlersByKey } = await registerCaptured(plugin, {
      hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    });
    // Synthesize the incomplete state (e.g. a bootstrap interrupted mid-run):
    // the .sdlc tree exists but no config was written.
    mkdirSync(join(dir, '.sdlc'), { recursive: true });
    assert.equal(existsSync(join(dir, '.sdlc', 'config.yml')), false);

    // The write fence is the COMPLETED project, not the directory: a POST
    // here must not wedge the done marker on an OpenAI-default config with
    // no detected gates.
    const post = await handlersByKey.get('POST /api/sdlc.config')(
      new Request(`http://localhost/api/sdlc.config?cwd=${encodeURIComponent(dir)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'observability.logLevel', value: 'debug' }),
      }),
    );
    assert.equal(post.status, 404);
    assert.equal((await post.json()).error, 'NO_PROJECT');
    assert.equal(existsSync(join(dir, '.sdlc', 'config.yml')), false, 'no config was written');

    // A guarded write is different: adoption MAY bootstrap, and what it
    // writes is the honest artifact — the harness route, never the
    // OpenAI-default poison the old fence could have wedged.
    const adopt = await handlersByKey.get('POST /api/sdlc.host')(
      new Request(`http://localhost/api/sdlc.host?cwd=${encodeURIComponent(dir)}`, { method: 'POST', body: '{}' }),
    );
    assert.equal(adopt.status, 200);
    const adopted = readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8');
    assert.match(adopted, /provider: deepseek-account/);
    assert.doesNotMatch(adopted, /provider: openai/);
  } finally { cleanup(dir); }
});

test('an unwritable workspace resolves into a response, never a rejected fetch', async () => {
  const plugin = await core.uiPlugin();
  const dir = scaffold();
  try {
    const { handlersByKey } = await registerCaptured(plugin, {
      hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    });
    chmodSync(dir, 0o555); // a describable workspace the process cannot write
    const res = await handlersByKey.get('GET /api/sdlc.status')(
      new Request(`http://localhost/api/sdlc.status?cwd=${encodeURIComponent(dir)}`),
    );
    assert.equal(res.status, 404, 'bootstrap failure resolves into the guided state');
    const body = await res.json();
    assert.equal(body.error, 'NO_PROJECT');
    assert.match(body.detail, /auto-setup failed: this workspace is not writable/);
  } finally {
    chmodSync(dir, 0o755);
    cleanup(dir);
  }
});

test('no memo: a deleted .sdlc is re-bootstrapped by the very next request', async () => {
  const plugin = await core.uiPlugin();
  const dir = scaffold();
  try {
    const { handlersByKey } = await registerCaptured(plugin, {
      hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    });
    const url = `http://localhost/api/sdlc.status?cwd=${encodeURIComponent(dir)}`;
    assert.equal((await handlersByKey.get('GET /api/sdlc.status')(new Request(url))).status, 200);

    // `rm -rf .sdlc` between polls: the guard must not answer from a stale
    // memo — the next GET re-bootstraps the real filesystem state.
    rmSync(join(dir, '.sdlc'), { recursive: true, force: true });
    const second = await handlersByKey.get('GET /api/sdlc.status')(new Request(url));
    assert.equal(second.status, 200);
    assert.ok(existsSync(join(dir, '.sdlc', 'sdlc.db')), 'the deleted project was re-created');

    // The mirror half: only the gitignored DB is removed (a `git clean`) —
    // the panel heals it instead of 404ing forever behind a stale marker.
    rmSync(join(dir, '.sdlc', 'sdlc.db'));
    const third = await handlersByKey.get('GET /api/sdlc.status')(new Request(url));
    assert.equal(third.status, 200);
    assert.ok(existsSync(join(dir, '.sdlc', 'sdlc.db')), 'the missing DB was repaired');
  } finally { cleanup(dir); }
});

test('the action route changes real rows and refuses what it must not do', async () => {
  const dir = scaffold();
  const advances = [];
  const deps = { advance: async (opts) => { advances.push(opts); return { report: { dispatched: [{ taskId: 'T-DO' }], skipped: [] } }; } };
  try {
    const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
    const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      runtime.createProject({ id: 'P1', name: 'ui', repoPath: dir });
      runtime.addTask({ id: 'T-WAIT', project_id: 'P1', title: 'blocked by a dependency', depends_on: ['T-MISSING'] });
      runtime.addTask({ id: 'T-DO', project_id: 'P1', title: 'do the work' });
      runtime.addTask({ id: 'T-BAD', project_id: 'P1', title: 'already failed', budgets: { max_attempts: 1 } });
      runtime.transition('T-BAD', 'READY', 'scheduler', { depStates: {} });
      runtime.transition('T-BAD', 'ASSIGNED', 'scheduler', { available: true });
      runtime.transition('T-BAD', 'IN_PROGRESS', 'worker-mgr', {});
      runtime.transition('T-BAD', 'FAILED', 'worker-mgr', { hardFailure: true });
    } finally {
      runtime.close({ releaseLock: false });
    }

    // A backlog task with an unfinished dependency cannot be queued.
    const blocked = await handlers.handleAction(dir, { action: 'queue', taskId: 'T-WAIT' });
    assert.equal(blocked.status, 409, blocked.body.detail);

    // A free backlog task moves to READY, and the flow snapshot says so.
    const queued = await handlers.handleAction(dir, { action: 'queue', taskId: 'T-DO' });
    assert.equal(queued.status, 200);
    assert.equal(queued.body.to, 'READY');

    // Dispatch records the proposal AND drives the injected scheduler tick.
    const dispatched = await handlers.handleAction(dir, { action: 'dispatch', taskId: 'T-DO' }, deps);
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
    assert.equal(dispatched.body.action, 'dispatch');
    assert.equal(dispatched.body.advanced.dispatched, 1);
    assert.equal(advances.length, 1);
    assert.equal(advances[0].projectId, 'P1');
    // Without the tick (an older host), dispatch still records the proposal.
    const bare = await handlers.handleAction(dir, { action: 'dispatch', taskId: 'T-DO' });
    assert.equal(bare.status, 200);
    assert.equal(bare.body.advanced, null);

    // Breaking a task down cancels it and creates the steps the user wrote.
    const split = await handlers.handleAction(dir, {
      action: 'breakdown', taskId: 'T-WAIT',
      steps: [{ title: 'first step' }, { title: 'second step' }],
    });
    assert.equal(split.status, 200, JSON.stringify(split.body));
    assert.equal(split.body.count, 2);

    // A decision lands as a real ADR, and approval is not an action at all.
    const decided = await handlers.handleAction(dir, { action: 'decide', question: 'Which store?', decision: 'SQLite' });
    assert.equal(decided.status, 200);
    const refused = await handlers.handleAction(dir, { action: 'approve', taskId: 'T-DO' });
    assert.equal(refused.status, 400);

    // A failed task goes back to READY only because the state machine agrees —
    // and a retry runs it again through the same scheduler tick.
    const retried = await handlers.handleAction(dir, { action: 'retry', taskId: 'T-BAD' }, deps);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.to, 'READY');
    assert.equal(retried.body.advanced.dispatched, 1);
    // Spend the budget, fail again, and the same action is now refused.
    const again = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    again.open();
    try {
      again.db.prepare('UPDATE tasks SET attempt = retry_budget WHERE id = ?').run('T-BAD');
      again.transition('T-BAD', 'ASSIGNED', 'scheduler', { available: true });
      again.transition('T-BAD', 'IN_PROGRESS', 'worker-mgr', {});
      again.transition('T-BAD', 'FAILED', 'worker-mgr', { hardFailure: true });
    } finally { again.close({ releaseLock: false }); }
    const exhausted = await handlers.handleAction(dir, { action: 'retry', taskId: 'T-BAD' }, deps);
    assert.equal(exhausted.status, 409);

    const check = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    check.open();
    try {
      assert.equal(check.getTask('T-DO').state, 'READY');
      assert.equal(check.getTask('T-WAIT').state, 'CANCELLED');
      assert.equal(check.getTask('T-BAD').state, 'FAILED', 'an exhausted retry budget keeps the task failed');
      const children = check.listTasks().filter((task) => task.title === 'first step' || task.title === 'second step');
      assert.equal(children.length, 2);
      assert.equal(children.find((task) => task.title === 'second step').depends_on.length, 1);
      const decisions = check.listDecisions('P1');
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].decision, 'SQLite');
    } finally {
      check.close({ releaseLock: false });
    }
  } finally { cleanup(dir); }
});

test('a decision resolves the escalation it answers — the decide card cannot loop', async () => {
  const dir = scaffold();
  try {
    const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
    const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      runtime.createProject({ id: 'P1', name: 'ui', repoPath: dir });
      runtime.addTask({ id: 'T-ES', project_id: 'P1', title: 'escalated work' });
      runtime.transition('T-ES', 'ESCALATED', 'recovery', {});
      runtime.recordEscalation({
        id: 'ESC-1', taskId: 'T-ES', level: 'task',
        packet: { question: 'Which database?', options: [] },
      });
    } finally {
      runtime.close({ releaseLock: false });
    }

    const decided = await handlers.handleAction(dir, {
      action: 'decide', question: 'Which database?', decision: 'PostgreSQL',
      reason: 'managed service', escalationId: 'ESC-1', taskId: 'T-ES',
      disposition: 'approve',
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.escalationId, 'ESC-1', 'the escalation is resolved, not just recorded');
    assert.equal(decided.body.resolutionError, null, 'a failed resolution is visible, never swallowed');

    // Free text with NO disposition records the ADR but resolves nothing: the
    // panel must not invent approval authority from a sentence.
    runtime.open();
    try {
      runtime.recordEscalation({ id: 'ESC-2', taskId: 'T-ES', level: 'task', packet: { question: 'Second question?' } });
    } finally { runtime.close({ releaseLock: false }); }
    const undecisive = await handlers.handleAction(dir, {
      action: 'decide', question: 'Second question?', decision: 'do both',
    });
    assert.equal(undecisive.status, 200);
    assert.equal(undecisive.body.escalationId, null, 'no disposition means no guessed resolution');

    const check = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    check.open();
    try {
      const escalation = check.getEscalations().find((row) => row.id === 'ESC-1');
      assert.ok(escalation.resolution, 'the escalation row carries the human decision');
      assert.equal(escalation.resolved_by, 'human');
      assert.equal(check.listDecisions('P1').length, 2, 'both decisions are recorded as ADRs');
    } finally { check.close({ releaseLock: false }); }
  } finally { cleanup(dir); }
});

test('the run route creates THIS workspace’s task and advances it — never a foreign project’s', async () => {
  const dir = scaffold();
  const advances = [];
  const deps = { advance: async (opts) => { advances.push(opts); return { report: { dispatched: [], skipped: [] } }; } };
  try {
    const config = cfgMod.deepMerge(cfgMod.DEFAULT_CONFIG, {});
    // A stale row from ANOTHER checkout — the old black hole.
    const runtime = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      runtime.createProject({ id: 'P-FOREIGN', name: 'old checkout', repoPath: '/tmp/somewhere-else' });
    } finally { runtime.close({ releaseLock: false }); }

    const started = await handlers.handleTasksRun(dir, { goal: 'ship the thing' }, deps);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.projectId !== 'P-FOREIGN', true, 'the task attaches to THIS workspace, not the stale row');
    assert.equal(started.body.state, 'READY', 'the goal task is queued for the scheduler');
    assert.ok(started.body.advanced, 'the run advances through the injected tick');
    assert.equal(advances.length, 1);

    const check = new runtimeMod.Runtime({ projectRoot: dir, config, useLock: false });
    check.open();
    try {
      const task = check.getTask(started.body.taskId);
      assert.ok(task, 'the task exists');
      assert.equal(task.state, 'READY');
      assert.equal(task.project_id, started.body.projectId);
      assert.deepEqual(task.allowed_paths, ['**'], 'a goal task scopes to the whole repo until it is broken down');
      const visible = check.projectTasks(started.body.projectId);
      assert.equal(visible.length, 1, 'the new task is visible in this workspace');
    } finally { check.close({ releaseLock: false }); }
  } finally { cleanup(dir); }
});
