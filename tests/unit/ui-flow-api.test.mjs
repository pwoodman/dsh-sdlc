/**
 * tests/unit/ui-flow-api.test.mjs — the 404 diagnostics that matter in a
 * running app after an in-place update: the client can be newer than the host
 * routes. A generic "http 404" is useless; the panel must say "restart".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchFlow } from '../../packages/sdlc-client-ui/src/client/api.js';

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}

test('a 404 NO_PROJECT is the expected pre-init state', async () => {
  const result = await withFetch(
    async () => new Response(JSON.stringify({ ok: false, error: 'NO_PROJECT', detail: 'run sdlc init' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }),
    () => fetchFlow(),
  );
  assert.equal(result.available, false);
  assert.equal(result.code, 'NO_PROJECT');
  assert.match(result.reason, /sdlc init/);
});

test('a bare 404 means the running host has no flow route (restart required)', async () => {
  const result = await withFetch(
    async () => new Response('Not Found', { status: 404 }),
    () => fetchFlow(),
  );
  assert.equal(result.available, false);
  assert.equal(result.code, 'HOST_OUTDATED');
  assert.match(result.reason, /not registered by the running host/);
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
