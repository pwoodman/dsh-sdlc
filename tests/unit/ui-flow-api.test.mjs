/**
 * tests/unit/ui-flow-api.test.mjs — the 404 diagnostics that matter in a
 * running app after an in-place update: the client can be newer than the host
 * routes. A generic "http 404" is useless; the panel must say which half is old
 * and whether the host plugin is loaded at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchFlow } from '../../packages/sdlc-client-ui/src/client/api.js';

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}

const statusPayload = {
  ok: true,
  pluginVersion: '0.4.0-beta.28',
  projects: [{ id: 'P', name: 'p', state: 'DISCOVERY' }],
  tasks: { total: 1, byState: { READY: 1 }, items: [] },
  spend: { costUsd: 0, durationMs: 0, tokens: 0 },
};

test('a 404 NO_PROJECT carries the host\'s own reason through to the card', async () => {
  const result = await withFetch(
    async () => new Response(JSON.stringify({
      ok: false,
      error: 'NO_PROJECT',
      detail: 'auto-setup failed: this workspace is not writable',
    }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }),
    () => fetchFlow(),
  );
  assert.equal(result.available, false);
  assert.equal(result.code, 'NO_PROJECT');
  assert.match(result.reason, /not writable/, 'the real host reason reaches the user, not a canned guess');
});

test('a 404 NO_PROJECT_ROW is the healthy empty state, not a failure', async () => {
  const result = await withFetch(
    async () => new Response(JSON.stringify({
      ok: false,
      error: 'NO_PROJECT_ROW',
      detail: 'no project yet — create one with `/sdlc run` in the lead session',
    }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }),
    () => fetchFlow(),
  );
  assert.equal(result.available, false);
  assert.equal(result.code, 'NO_PROJECT_ROW');
  assert.match(result.reason, /\/sdlc run/);
  assert.notEqual(result.code, 'NO_PROJECT', 'must not render the auto-setup-failed card');
});

test('flow 404 while status answers means the loaded host is an older build', async () => {
  const urls = [];
  const result = await withFetch(
    async (url) => {
      urls.push(String(url));
      if (String(url).includes('sdlc.flow')) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(statusPayload), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    () => fetchFlow({ cwd: '/work/repo' }),
  );
  assert.equal(result.available, false);
  assert.equal(result.code, 'HOST_OUTDATED');
  assert.equal(result.probe.statusRoutePresent, true);
  assert.equal(result.probe.pluginVersion, '0.4.0-beta.28');
  assert.equal(result.panelVersion, 'dev');
  assert.match(result.reason, /status does answer/);
  // The session workspace is sent on the flow request and the probe.
  assert.ok(urls.every((u) => u.includes('cwd=%2Fwork%2Frepo')), JSON.stringify(urls));
});

test('flow and status both 404 means the host plugin is not loaded', async () => {
  const result = await withFetch(
    async () => new Response('Not Found', { status: 404 }),
    () => fetchFlow(),
  );
  assert.equal(result.available, false);
  assert.equal(result.code, 'HOST_MISSING');
  assert.equal(result.probe.statusRoutePresent, false);
  assert.equal(result.probe.answered, true);
  assert.match(result.reason, /not registered or enabled/);
});

test('a network failure on the probe is reported as unreachable, not outdated', async () => {
  const result = await withFetch(
    async (url) => {
      if (String(url).includes('sdlc.flow')) return new Response('Not Found', { status: 404 });
      throw new Error('socket hang up');
    },
    () => fetchFlow(),
  );
  assert.equal(result.code, 'HOST_UNREACHABLE');
  assert.equal(result.probe.answered, false);
});

test('a 200 with a malformed payload is rejected, never rendered', async () => {
  const result = await withFetch(
    async () => new Response(JSON.stringify({ ok: true, tasks: 'nope' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
    () => fetchFlow(),
  );
  assert.equal(result.available, false);
  assert.match(result.reason, /malformed flow payload/);
});
