/**
 * demo/tests/api.test.mjs — API contract tests (offline, ephemeral port).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

async function withServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'demo-api-'));
  const server = await startServer({ root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('health returns ok', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('create → list → toggle round-trip', async () => {
  await withServer(async (base) => {
    const post = (p, b) => fetch(`${base}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
    });
    const created = await (await post('/api/tasks', { title: 'buy milk' })).json();
    assert.ok(created.id);
    assert.equal(created.done, false);
    const listed = await (await fetch(`${base}/api/tasks`)).json();
    assert.equal(listed.length, 1);
    const toggled = await (await post(`/api/tasks/${created.id}/done`, { done: true })).json();
    assert.equal(toggled.done, true);
  });
});

test('validation: empty title is 400, unknown id is 404', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '  ' }),
    });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${base}/api/tasks/no-such-id/done`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }),
    });
    assert.equal(missing.status, 404);
  });
});
