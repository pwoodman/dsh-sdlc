/**
 * tests/unit/ui-store.test.mjs — the browser stores (no DOM, no React).
 *
 * The framework-free stores are exercised directly: loading → ready/missing
 * transitions, config save success + rejection, compare loading, and reset.
 * A stub api records calls; failures resolve to { available: false, reason }.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const uiStore = await core.uiStore();

function stubApi(overrides = {}) {
  const calls = [];
  return {
    calls,
    fetchStatus: async () => (calls.push('status'), overrides.status ?? { available: true, data: { ok: true, tasks: { total: 1 }, spend: {} } }),
    fetchBoard: async () => (calls.push('board'), overrides.board ?? { available: true, data: { ok: true, columns: [] } }),
    fetchConfig: async () => (calls.push('config'), overrides.config ?? { available: true, data: { ok: true, config: {}, validation: { ok: true, errors: [] } } }),
    writeConfig: async (path, value) => (calls.push(`write:${path}=${value}`), overrides.write ?? { available: true, data: { ok: true } }),
    fetchCompare: async (task, a, b) => (calls.push(`compare:${task}`), overrides.compare ?? { available: true, data: { task: { id: task }, runs: {}, deltas: null, gatesCompared: [], tracePath: [], traceSummary: {} } }),
  };
}

test('createStore publishes updates to subscribers', () => {
  const s = uiStore.createStore(0);
  let seen = [];
  const unsub = s.subscribe(() => seen.push(s.getSnapshot()));
  s.update(1);
  s.update((v) => v + 1);
  unsub();
  s.update(99);
  assert.deepEqual(seen, [1, 2]);
});

test('loadStatus/loadBoard/loadConfig resolve ready or missing', async () => {
  const stores = uiStore.createSdlcStores(stubApi());
  assert.equal(stores.status.getSnapshot().phase, 'loading');
  await stores.loadStatus();
  assert.equal(stores.status.getSnapshot().phase, 'ready');
  await stores.loadBoard();
  assert.equal(stores.board.getSnapshot().phase, 'ready');

  const failing = uiStore.createSdlcStores(stubApi({ config: { available: false, reason: 'http 404' } }));
  await failing.loadConfig();
  assert.equal(failing.config.getSnapshot().phase, 'missing');
  assert.match(failing.config.getSnapshot().reason, /404/);
});

test('saveConfig reloads on success and surfaces rejection', async () => {
  const stores = uiStore.createSdlcStores(stubApi());
  await stores.loadConfig();
  const ok = await stores.saveConfig('observability.logLevel', 'warn');
  assert.equal(ok.available, true);
  assert.equal(stores.config.getSnapshot().saveError ?? null, null);

  const bad = uiStore.createSdlcStores(stubApi({ write: { available: false, reason: 'VALIDATION_FAILED' } }));
  await bad.loadConfig();
  await bad.saveConfig('execution.worktreeRetentionDays', 0);
  assert.match(bad.config.getSnapshot().saveError, /VALIDATION_FAILED/);
});

test('loadCompare tracks the requested runs and resets to idle', async () => {
  const stores = uiStore.createSdlcStores(stubApi());
  assert.equal(stores.review.getSnapshot().phase, 'idle');
  await stores.loadCompare('T-1', 'A', 'B');
  const snap = stores.review.getSnapshot();
  assert.equal(snap.phase, 'ready');
  assert.equal(snap.task, 'T-1');

  const failing = uiStore.createSdlcStores(stubApi({ compare: { available: false, reason: 'no such run' } }));
  await failing.loadCompare('T-1', 'A', 'NOPE');
  assert.equal(failing.review.getSnapshot().phase, 'missing');

  stores.reset();
  assert.equal(stores.review.getSnapshot().phase, 'idle');
  stores.dispose();
});
