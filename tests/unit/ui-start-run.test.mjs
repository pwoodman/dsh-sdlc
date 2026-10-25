/**
 * tests/unit/ui-start-run.test.mjs — the GUI "start a run" path.
 *
 * Covers the client half of `POST /api/sdlc.tasks.run`, which the backend
 * tests in lead-run-route.test.mjs do not reach: `api.startRun` validation,
 * `store.startRun` reload wiring, and the `NoProjectRowState` goal form
 * contract (the `onStart` result shape the component reads).
 *
 * The envelope convention is the point of this file. `api.*` returns
 * `{available, data|reason}`; components render from that envelope, not
 * from a raw host body. A component that reads `result.ok` off the envelope
 * is reading the wrong level and can never see a success.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSdlcStores } from '../../packages/sdlc-client-ui/src/client/store.js';
import { api, startRun, clientVersion } from '../../packages/sdlc-client-ui/src/client/api.js';

/** Minimal api stub: records calls, replays a queued response per method. */
function stubApi(overrides = {}) {
  const calls = [];
  const respond = {
    fetchTask: () => ({ available: true, data: { task: {}, workerRuns: [], gates: [] } }),
    fetchConfig: () => ({ available: true, data: { validation: { ok: true, warnings: [] } } }),
    fetchCompare: () => ({ available: true, data: { runs: {} } }),
    fetchFlow: () => ({ available: true, data: { ok: true, project: { id: 'default' }, tasks: [], events: [], agents: [] } }),
    startRun: () => ({ available: true, data: { ok: true, projectId: 'P1', taskId: 'T-NEW' } }),
    ...overrides,
  };
  return {
    calls,
    ...Object.fromEntries(Object.keys(respond).map((name) => [
      name,
      (...args) => { calls.push([name, ...args]); return respond[name](...args); },
    ])),
    clientVersion: () => 'test',
  };
}

test('api.startRun posts the goal and unwraps a well-formed payload', async () => {
  const posted = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posted.push({ url, init });
    return new Response(JSON.stringify({ ok: true, projectId: 'P1', taskId: 'T-NEW' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const res = await startRun('add JWT auth', '/work');
    assert.equal(res.available, true);
    assert.equal(res.data.taskId, 'T-NEW');
    assert.equal(posted.length, 1);
    assert.match(posted[0].url, /\/api\/sdlc\.tasks\.run\?cwd=/);
    assert.equal(posted[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(posted[0].init.body), { goal: 'add JWT auth' });
  } finally { globalThis.fetch = prev; }
});

test('api.startRun rejects a malformed success payload instead of trusting it', async () => {
  const prev = globalThis.fetch;
  // 200 with a body that is missing taskId — the never-fabricate rule:
  // a malformed "success" is unavailable with a reason, never a partial truth.
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await startRun('x', '/work');
    assert.equal(res.available, false);
    assert.match(res.reason, /malformed run payload/);
  } finally { globalThis.fetch = prev; }
});

test('api.startRun carries a missing-goal 400 as unavailable, never a throw', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'MISSING_GOAL' }), {
    status: 400, headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await startRun('', '/work');
    assert.equal(res.available, false);
    assert.equal(typeof res.reason, 'string');
    assert.ok(res.reason.length > 0);
  } finally { globalThis.fetch = prev; }
});

test('store.startRun posts the goal then reloads the flow on success', async () => {
  const stub = stubApi();
  const stores = createSdlcStores(stub);
  const res = await stores.startRun('my goal', '/work');
  assert.equal(res.available, true);
  const order = stub.calls.map(([name]) => name);
  assert.deepEqual(order, ['startRun', 'fetchFlow'], 'a successful start must refresh the panel');
  assert.deepEqual(stub.calls[0], ['startRun', 'my goal', '/work']);
});

test('store.startRun does not reload the flow when the post fails', async () => {
  const stub = stubApi({
    startRun: () => ({ available: false, reason: 'host returned a malformed run payload' }),
  });
  const stores = createSdlcStores(stub);
  const res = await stores.startRun('my goal', '/work');
  assert.equal(res.available, false);
  // A failed start must not repaint the panel from stale data.
  assert.deepEqual(stub.calls.map(([name]) => name), ['startRun'], 'a failed start must not reload');
});

test('the run envelope is what the panel reads — success is visible at the top level', async () => {
  // The contract the NoProjectRowState form depends on. `onStart` resolves the
  // API envelope, so a successful run must be observable as
  // `result.available === true` with the task under `result.data`.
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: true, projectId: 'P1', taskId: 'T-NEW' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  try {
    const result = await api.startRun('goal', '/work');
    // This is the assertion the component contract rests on: if a form checks
    // `result.ok !== true` to detect failure, it misreads every successful
    // start as a failure — `ok` lives one level down, inside `data`.
    assert.equal(result.available, true, 'success must be readable at the envelope level');
    assert.equal(result.data.ok, true);
    assert.equal(result.data.taskId, 'T-NEW');
  } finally { globalThis.fetch = prev; }
});

test('regression: the goal form must read the envelope, not the host body', async () => {
  // NoProjectRowState's `start()` treated `result.ok !== true` as failure, but
  // `api.startRun` resolves the ENVELOPE `{available, data}`, whose `data` is
  // where `ok` lives. A successful run therefore rendered as "start failed" and
  // the task was created but never shown. Pin the correct consumption:
  // success = envelope.available, task id = envelope.data.taskId.
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: true, projectId: 'P1', taskId: 'T-NEW' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  try {
    const result = await api.startRun('goal', '/work');

    // What the buggy form computed (and must never again):
    const buggyVerdict = !result || result.ok !== true; // → true = "failed"
    assert.equal(buggyVerdict, true, 'documents the defect: envelope has no top-level ok');

    // What the form must compute instead:
    const fixedVerdict = !result || result.available !== true; // → false = success
    assert.equal(fixedVerdict, false, 'the envelope level reports success');
    assert.equal(result.data.taskId, 'T-NEW');
  } finally { globalThis.fetch = prev; }
});

test('a started run becomes visible: the reload is unconditional on success', async () => {
  // The user-visible contract behind "the UI does nothing": after a successful
  // start the panel MUST refetch, or the task exists in the DB while the panel
  // keeps rendering the empty state. Pin that coupling here so a future
  // refactor cannot silently drop the refresh.
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = typeof url === 'string' ? url : String(url);
    calls.push(path);
    const body = path.includes('sdlc.tasks.run')
      ? { ok: true, projectId: 'P1', taskId: 'T-NEW' }
      : { ok: true, project: { id: 'P1' }, tasks: [], events: [], agents: [] };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const stores = createSdlcStores(api);
    const res = await stores.startRun('goal', '/work');
    assert.equal(res.available, true);
    const kinds = calls.map((u) => (u.includes('sdlc.tasks.run') ? 'run' : u.includes('sdlc.flow') ? 'flow' : 'other'));
    assert.deepEqual(kinds, ['run', 'flow'], 'a successful start must be followed by a flow refetch');
  } finally { globalThis.fetch = prev; }
});

test('api.startRun is exported on the api surface and the defaults object', () => {
  assert.equal(typeof api.startRun, 'function');
  assert.equal(typeof startRun, 'function');
  assert.equal(api.startRun, startRun);
  assert.equal(typeof clientVersion, 'function');
});

// ── end-to-end through the registered host route (UI ↔ backend contract) ─────

test('POST /api/sdlc.tasks.run through the registered fetcher returns the task id', async () => {
  const plugin = await (await import('../../packages/sdlc-client-ui/src/server/plugin.js'));
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-run-e2e-'));
  try {
    const handlersByKey = new Map();
    const ctx = {
      get: (name) => name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }) }
        : undefined,
      connection: { fetch: { register: (r) => handlersByKey.set(`${r.methods[0]} ${r.path}`, r.fetch) } },
      logger: { warn() {} },
    };
    plugin.registerRoutes(ctx, { projectRoot: dir });
    const runFetch = handlersByKey.get('POST /api/sdlc.tasks.run');
    assert.ok(runFetch, 'the run route must be registered');

    // Bootstraps the workspace, then honours the goal (the panel's first touch).
    const res = await runFetch(new Request('http://localhost/api/sdlc.tasks.run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'add JWT auth with refresh tokens' }),
    }));
    assert.equal(res.status, 200, 'the first workspace touch bootstraps and runs');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.taskId, 'string');
    assert.ok(body.taskId.length > 0);
    assert.equal(typeof body.projectId, 'string');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
