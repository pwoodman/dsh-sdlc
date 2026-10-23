/**
 * tests/unit/ui-api.test.mjs — the browser fetch face.
 *
 * The 404 split and the never-fabricate error shapes live here; the flow panel
 * depends on both. All network is stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchStatus, fetchBoard, fetchTask, fetchCompare,
  fetchConfig, writeConfig, fetchMetrics, fetchFlow,
} from '../../packages/sdlc-client-ui/src/client/api.js';

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const flowPayload = {
  ok: true,
  project: { available: true, id: 'P1', name: 'p', state: 'IMPLEMENTATION' },
  totals: { tasks: 1, activeTasks: 0, spend: { costUsd: 0, tokens: 0 } },
  tasks: [{ id: 'T1', state: 'READY', layer: 0 }],
  edges: [], runs: [], routing: [], gates: [],
  gateSummary: { pass: 0, fail: 0, skipped: 0, unknown: 0, total: 0 },
  events: [], escalations: [], unavailable: [],
  locks: { cap: 1, resources: [], pathOwners: [], violations: [] },
};

test('status/board/config validate their payloads', async () => {
  await withFetch(async () => json({ ok: true, tasks: { total: 1 }, spend: {} }), async () => {
    const res = await fetchStatus();
    assert.equal(res.available, true);
  });
  await withFetch(async () => json({ ok: true, columns: [] }), async () => {
    assert.equal((await fetchBoard()).available, true);
  });
  await withFetch(async () => json({ ok: true, config: {}, validation: { ok: true, errors: [] } }), async () => {
    assert.equal((await fetchConfig()).available, true);
  });
});

test('a malformed 200 is rejected for status/board/config', async () => {
  await withFetch(async () => json({ ok: true, tasks: 'nope' }), async () => {
    assert.match((await fetchStatus()).reason, /malformed status/);
  });
  await withFetch(async () => json({ ok: true, columns: 'nope' }), async () => {
    assert.match((await fetchBoard()).reason, /malformed board/);
  });
  await withFetch(async () => json({ ok: true, config: {}, validation: 'nope' }), async () => {
    assert.match((await fetchConfig()).reason, /malformed config/);
  });
});

test('getJson reports network, HTTP-detail and invalid-JSON failures', async () => {
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.match((await fetchTask('T1')).reason, /network: offline/);
  });
  await withFetch(async () => json({ error: 'NOPE', detail: 'missing' }, 404), async () => {
    const res = await fetchTask('T1');
    assert.equal(res.status, 404);
    assert.equal(res.code, 'NOPE');
    assert.match(res.reason, /missing/);
  });
  await withFetch(async () => new Response('not json', { status: 200 }), async () => {
    assert.match((await fetchTask('T1')).reason, /invalid JSON/);
  });
  await withFetch(async () => new Response('bad', { status: 500 }), async () => {
    assert.match((await fetchTask('T1')).reason, /http 500/);
  });
});

test('compare, config write and metrics cover success and failure', async () => {
  await withFetch(async () => json({ ok: true, task: { id: 'T1' } }), async () => {
    assert.equal((await fetchCompare('T1', 'a', 'b')).available, true);
  });
  await withFetch(async () => json({ ok: true }), async () => {
    assert.equal((await writeConfig('a.b', 1)).available, true);
  });
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.match((await writeConfig('a.b', 1)).reason, /network/);
  });
  await withFetch(async () => new Response('denied', { status: 403 }), async () => {
    assert.match((await writeConfig('a.b', 1)).reason, /http 403/);
  });
  await withFetch(async () => new Response('metric 1', { status: 200 }), async () => {
    assert.equal((await fetchMetrics()).data, 'metric 1');
  });
  await withFetch(async () => new Response('no', { status: 503 }), async () => {
    assert.match((await fetchMetrics()).reason, /503/);
  });
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.match((await fetchMetrics()).reason, /network/);
  });
});

test('flow: success, NO_PROJECT 404, missing host, malformed', async () => {
  await withFetch(async () => json(flowPayload), async () => {
    const res = await fetchFlow();
    assert.equal(res.available, true);
    assert.equal(res.data.tasks.length, 1);
  });
  await withFetch(async () => json({ ok: false, error: 'NO_PROJECT' }, 404), async () => {
    const res = await fetchFlow();
    assert.equal(res.code, 'NO_PROJECT');
    assert.match(res.reason, /auto-setup|workspace/);
  });
  await withFetch(async () => new Response('Not Found', { status: 404 }), async () => {
    const res = await fetchFlow();
    assert.equal(res.code, 'HOST_MISSING');
  });
  await withFetch(async () => json({ ok: true, tasks: 'nope' }), async () => {
    assert.match((await fetchFlow()).reason, /malformed flow/);
  });
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.match((await fetchFlow()).reason, /network/);
  });
});

test('every read call carries the session cwd', async () => {
  const urls = [];
  await withFetch(async (url) => {
    urls.push(String(url));
    return json({ ok: true, tasks: { total: 0 }, spend: {}, columns: [], config: {}, validation: { ok: true, errors: [] } });
  }, async () => {
    await fetchStatus('/w');
    await fetchBoard('/w');
    await fetchConfig('/w');
    await fetchMetrics('/w');
    await fetchFlow({ cwd: '/w' });
  });
  assert.equal(urls.length, 5);
  assert.ok(urls.every((u) => u.includes('cwd=%2Fw')), JSON.stringify(urls));
});
