/**
 * packages/sdlc-client-ui/src/client/store.js — browser state for the SDLC tab.
 *
 * Framework-free observable stores (subscribe/getSnapshot/update) matching the
 * `ObservableSnapshot` face the slot components consume. One store per surface;
 * every store starts `loading` and resolves to data or to `{ available: false,
 * reason }` — the browser never renders a fabricated zero.
 *
 * There is one data store (`flow`) feeding both Flow and Tasks. The old Status
 * and Board stores were removed with their duplicate tabs: the flow snapshot
 * already carries project state, task totals, spend and every task.
 */

export function createStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot() { return snapshot; },
    update(fn) {
      const next = typeof fn === 'function' ? fn(snapshot) : fn;
      if (next !== snapshot) {
        snapshot = next;
        for (const listener of [...listeners]) listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() { listeners.clear(); },
  };
}

export function createSdlcStores(api) {
  const flow = createStore({ phase: 'loading' });
  const config = createStore({ phase: 'loading' });
  const review = createStore({ phase: 'idle' });

  /** Keep the incremental event window bounded (oldest dropped first). */
  const MAX_EVENTS = 200;

  function mergeEvents(previous, incoming) {
    const seen = new Set();
    const merged = [];
    for (const event of [...previous, ...incoming]) {
      if (!event || seen.has(event.id)) continue;
      seen.add(event.id);
      merged.push(event);
    }
    merged.sort((a, b) => a.id - b.id);
    return merged.slice(-MAX_EVENTS);
  }

  /**
   * Load the flow snapshot.
   *
   * Polling sends the last event id as a cursor (`after=`), so the host returns
   * only new events and the client merges them into a bounded window. That
   * keeps each poll small (less JSON, less render) while the task/run/gate state
   * still updates in full. A workspace change starts a fresh cursor.
   */
  async function loadFlow({ task = null, cwd = undefined } = {}) {
    const previous = flow.getSnapshot();
    const sameWorkspace = Boolean(previous.data) && (previous.cwd ?? null) === (cwd ?? null);
    const after = sameWorkspace ? (previous.data.eventsMeta?.nextAfterId ?? 0) : 0;
    const options = { task, cwd };
    if (after > 0) options.after = after;
    try {
      const res = await api.fetchFlow(options);
      if (res.available) {
        let data = res.data;
        if (sameWorkspace && after > 0 && Array.isArray(data.events)) {
          const events = mergeEvents(previous.data.events ?? [], data.events);
          data = {
            ...data,
            events,
            eventsMeta: {
              ...(data.eventsMeta ?? {}),
              returned: events.length,
              nextAfterId: data.eventsMeta?.nextAfterId ?? events.at(-1)?.id ?? after,
            },
          };
        }
        flow.update({ phase: 'ready', data, cwd: cwd ?? null });
        return;
      }
      const diagnostic = { code: res.code, probe: res.probe ?? null, panelVersion: res.panelVersion ?? null };
      flow.update(previous.data
        ? { phase: 'stale', data: previous.data, cwd: previous.cwd ?? null, reason: res.reason, ...diagnostic }
        : { phase: 'missing', reason: res.reason, ...diagnostic });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      flow.update(previous.data
        ? { phase: 'stale', data: previous.data, cwd: previous.cwd ?? null, reason, code: 'NETWORK' }
        : { phase: 'missing', reason, code: 'NETWORK' });
    }
  }

  async function loadConfig(cwd) {
    config.update({ phase: 'loading' });
    const res = await api.fetchConfig(cwd);
    config.update(res.available ? { phase: 'ready', data: res.data } : { phase: 'missing', reason: res.reason, code: res.code ?? null });
  }

  async function saveConfig(path, value, cwd) {
    config.update((snapshot) => ({ ...snapshot, saving: path, saveError: null }));
    const res = await api.writeConfig(path, value, cwd);
    if (!res.available) {
      config.update((snapshot) => ({ ...snapshot, saving: null, saveError: res.reason }));
      return res;
    }
    await loadConfig(cwd);
    config.update((snapshot) => ({ ...snapshot, saving: null, saveError: null }));
    return res;
  }

  /** Adopt the Harness model, then refresh the Settings snapshot. */
  async function adoptHostModel(cwd) {
    const res = await api.adoptHostModel(cwd);
    if (res.available) await loadConfig(cwd);
    return res;
  }

  async function loadCompare(task, a, b, cwd) {
    review.update({ phase: 'loading', task, a, b });
    const res = await api.fetchCompare(task, a, b, cwd);
    review.update(res.available
      ? { phase: 'ready', task, a, b, data: res.data }
      : { phase: 'missing', task, a, b, reason: res.reason });
  }

  /**
   * Load the surface a tab switch reveals. Flow and Tasks share the flow
   * snapshot; Review is user-driven (pick two runs); Settings reads config.
   */
  function loadPanel(panel, cwd) {
    if (panel === 'flow' || panel === 'tasks') return loadFlow({ cwd });
    if (panel === 'settings') return loadConfig(cwd);
    return Promise.resolve();
  }

  function reset() {
    flow.update({ phase: 'loading' });
    config.update({ phase: 'loading' });
    review.update({ phase: 'idle' });
  }

  function dispose() {
    flow.dispose();
    config.dispose();
    review.dispose();
  }

  return {
    flow, config, review,
    loadFlow, loadConfig, saveConfig, adoptHostModel, loadCompare, loadPanel, reset, dispose,
  };
}

export default { createStore, createSdlcStores, createSdlcStoreHandle };

/**
 * Adapt the framework-free stores to DSH's slot store handle contract.
 *
 * The renderer calls `handle.create(scopeKey)` and expects
 * { actions, getSnapshot, subscribe, clearPersisted }. The tab body still reads
 * the raw stores through `inject`, but this handle is what the registry needs;
 * passing the raw store object produced `handle.create is not a function` and
 * the tab never mounted.
 */
export function createSdlcStoreHandle(stores) {
  const names = ['flow', 'config', 'review'];
  const snapshot = () => Object.fromEntries(names.map((name) => [name, stores[name].getSnapshot()]));
  const subscribe = (listener) => {
    const unsubscribe = names.map((name) => stores[name].subscribe(listener));
    return () => { for (const off of unsubscribe) off(); };
  };
  return {
    spec: { init: snapshot, actions: {} },
    create: () => ({ actions: {}, getSnapshot: snapshot, subscribe, clearPersisted() {} }),
  };
}
