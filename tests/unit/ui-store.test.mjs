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
    fetchConfig: async () => (calls.push('config'), overrides.config ?? { available: true, data: { ok: true, config: {}, validation: { ok: true, errors: [] } } }),
    writeConfig: async (path, value) => (calls.push(`write:${path}=${value}`), overrides.write ?? { available: true, data: { ok: true } }),
    fetchCompare: async (task, a, b) => (calls.push(`compare:${task}`), overrides.compare ?? { available: true, data: { task: { id: task }, runs: {}, deltas: null, gatesCompared: [], tracePath: [], traceSummary: {} } }),
    fetchFlow: async () => (calls.push('flow'), overrides.flow ?? { available: true, data: { ok: true, tasks: [], events: [] } }),
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

test('loadConfig resolves ready or missing', async () => {
  const failing = uiStore.createSdlcStores(stubApi({ config: { available: false, reason: 'http 404' } }));
  assert.equal(failing.config.getSnapshot().phase, 'loading');
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


test('loadPanel maps Flow and Tasks to one snapshot and Settings to config', async () => {
  const api = stubApi();
  const stores = uiStore.createSdlcStores(api);
  assert.equal(stores.flow.getSnapshot().phase, 'loading');
  await stores.loadPanel('flow');
  assert.equal(stores.flow.getSnapshot().phase, 'ready');
  await stores.loadPanel('tasks');
  assert.equal(stores.flow.getSnapshot().phase, 'ready');
  await stores.loadPanel('settings');
  assert.equal(stores.config.getSnapshot().phase, 'ready');
  assert.deepEqual(api.calls, ['flow', 'flow', 'config']);
  // Review is user-driven (pick two runs); switching to it must not fetch.
  await stores.loadPanel('review');
  assert.equal(stores.review.getSnapshot().phase, 'idle');
  assert.deepEqual(api.calls, ['flow', 'flow', 'config']);
  stores.dispose();
});


test('panel loads forward the session workspace to the host', async () => {
  const seen = [];
  const api = {
    fetchConfig: async (cwd) => { seen.push(['config', cwd]); return { available: true, data: { ok: true, config: {}, validation: { ok: true, errors: [] } } }; },
    fetchFlow: async (opts) => { seen.push(['flow', opts]); return { available: true, data: { ok: true, tasks: [] } }; },
  };
  const stores = uiStore.createSdlcStores(api);
  await stores.loadPanel('flow', '/w');
  await stores.loadPanel('tasks', '/w');
  await stores.loadPanel('settings', '/w');
  assert.deepEqual(seen, [
    ['flow', { task: null, cwd: '/w' }], ['flow', { task: null, cwd: '/w' }], ['config', '/w'],
  ]);
  stores.dispose();
});

test('a missing flow route keeps the probe for the diagnostics panel', async () => {
  const probe = { answered: true, statusRoutePresent: true, pluginVersion: '0.4.0-beta.27' };
  const stores = uiStore.createSdlcStores(stubApi({
    flow: { available: false, code: 'HOST_OUTDATED', reason: 'old host', probe, panelVersion: '0.4.0-beta.29' },
  }));
  await stores.loadFlow();
  const snap = stores.flow.getSnapshot();
  assert.equal(snap.phase, 'missing');
  assert.equal(snap.code, 'HOST_OUTDATED');
  assert.equal(snap.probe.pluginVersion, '0.4.0-beta.27');
  assert.equal(snap.panelVersion, '0.4.0-beta.29');
  stores.dispose();
});


test('loadFlow resolves ready, keeps stale data on failure, and resets', async () => {
  const stores = uiStore.createSdlcStores(stubApi());
  await stores.loadFlow();
  assert.equal(stores.flow.getSnapshot().phase, 'ready');
  const failing = uiStore.createSdlcStores(stubApi({ flow: { available: false, reason: 'http 503' } }));
  await failing.loadFlow();
  assert.equal(failing.flow.getSnapshot().phase, 'missing');
  assert.match(failing.flow.getSnapshot().reason, /503/);

  // A failure after a successful load retains the snapshot as stale.
  const flaky = uiStore.createSdlcStores(stubApi());
  await flaky.loadFlow();
  const original = flaky.flow.getSnapshot().data;
  flaky.dispose();
  // The store instance is reused; drive the same api to failure by swapping.
  const failingApi = stubApi({ flow: { available: false, reason: 'offline' } });
  const stores2 = uiStore.createSdlcStores(failingApi);
  await stores2.loadFlow();
  assert.equal(stores2.flow.getSnapshot().phase, 'missing');
  stores2.reset();
  assert.equal(stores2.flow.getSnapshot().phase, 'loading');
  assert.ok(original);
  stores2.dispose();
});

test('flow polling advances the event cursor and merges only new events', async () => {
  const calls = [];
  let page = 0;
  const api = {
    fetchFlow: async (opts) => {
      calls.push(opts);
      page += 1;
      if (page === 1) {
        return {
          available: true,
          data: {
            ok: true, tasks: [], events: [{ id: 1 }, { id: 2 }],
            eventsMeta: { nextAfterId: 2, returned: 2, limit: 100, hasMore: false },
          },
        };
      }
      return {
        available: true,
        data: {
          ok: true, tasks: [], events: [{ id: 3 }, { id: 4 }],
          eventsMeta: { nextAfterId: 4, returned: 2, limit: 100, hasMore: false },
        },
      };
    },
  };
  const stores = uiStore.createSdlcStores(api);
  await stores.loadFlow();
  assert.equal(calls[0].after, undefined, 'the first poll takes the full snapshot');
  assert.deepEqual(stores.flow.getSnapshot().data.events.map((event) => event.id), [1, 2]);
  await stores.loadFlow();
  assert.equal(calls[1].after, 2, 'the next poll resumes after the newest event');
  assert.deepEqual(stores.flow.getSnapshot().data.events.map((event) => event.id), [1, 2, 3, 4]);
  assert.equal(stores.flow.getSnapshot().data.eventsMeta.nextAfterId, 4);
  stores.dispose();
});

test('flow cursor resets when the workspace changes', async () => {
  const calls = [];
  const api = {
    fetchFlow: async (opts) => {
      calls.push(opts);
      return {
        available: true,
        data: {
          ok: true, tasks: [], events: [{ id: 9 }],
          eventsMeta: { nextAfterId: 9, returned: 1 },
        },
      };
    },
  };
  const stores = uiStore.createSdlcStores(api);
  await stores.loadFlow({ cwd: '/work/a' });
  await stores.loadFlow({ cwd: '/work/a' });
  await stores.loadFlow({ cwd: '/work/b' });
  assert.equal(calls[0].after, undefined);
  assert.equal(calls[1].after, 9);
  assert.equal(calls[2].after, undefined, 'a new workspace starts from a full snapshot');
  stores.dispose();
});
