/**
 * packages/sdlc-client-ui/src/client/store.js — browser state for the SDLC tab.
 *
 * Framework-free observable stores (subscribe/getSnapshot/update) matching the
 * `ObservableSnapshot` face the slot components consume. One store per panel;
 * every store starts `loading`, resolves to data or to `{ available: false,
 * reason }` — the browser never renders a fabricated zero.
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
        for (const l of [...listeners]) l();
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
  const status = createStore({ phase: 'loading' });
  const board = createStore({ phase: 'loading' });
  const config = createStore({ phase: 'loading' });
  const review = createStore({ phase: 'idle' });
  const flow = createStore({ phase: 'loading' });

  async function loadStatus() {
    status.update({ phase: 'loading' });
    const res = await api.fetchStatus();
    status.update(res.available ? { phase: 'ready', data: res.data } : { phase: 'missing', reason: res.reason });
  }

  async function loadBoard() {
    board.update({ phase: 'loading' });
    const res = await api.fetchBoard();
    board.update(res.available ? { phase: 'ready', data: res.data } : { phase: 'missing', reason: res.reason });
  }

  async function loadConfig() {
    config.update({ phase: 'loading' });
    const res = await api.fetchConfig();
    config.update(res.available ? { phase: 'ready', data: res.data } : { phase: 'missing', reason: res.reason });
  }

  async function saveConfig(path, value) {
    config.update((s) => ({ ...s, saving: path }));
    const res = await api.writeConfig(path, value);
    if (!res.available) {
      config.update((s) => ({ ...s, saving: null, saveError: res.reason }));
      return res;
    }
    await loadConfig();
    config.update((s) => ({ ...s, saving: null, saveError: null }));
    return res;
  }

  async function loadFlow({ task = null } = {}) {
    const previous = flow.getSnapshot();
    try {
      const res = await api.fetchFlow({ task });
      if (res.available) {
        flow.update({ phase: 'ready', data: res.data });
        return;
      }
      flow.update(previous.data
        ? { phase: 'stale', data: previous.data, reason: res.reason, code: res.code }
        : { phase: 'missing', reason: res.reason, code: res.code });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      flow.update(previous.data
        ? { phase: 'stale', data: previous.data, reason, code: 'NETWORK' }
        : { phase: 'missing', reason, code: 'NETWORK' });
    }
  }

  async function loadCompare(task, a, b) {
    review.update({ phase: 'loading', task, a, b });
    const res = await api.fetchCompare(task, a, b);
    review.update(res.available
      ? { phase: 'ready', task, a, b, data: res.data }
      : { phase: 'missing', task, a, b, reason: res.reason });
  }

  /**
   * Load the panel a tab switch just revealed. Status/board/config start in
   * `loading` and had no caller, so those three tabs rendered "Loading…"
   * forever (the in-panel Reload button is behind that loading branch).
   */
  function loadPanel(panel) {
    if (panel === 'status') return loadStatus();
    if (panel === 'board') return loadBoard();
    if (panel === 'config') return loadConfig();
    if (panel === 'flow') return loadFlow();
    return Promise.resolve();
  }

  function reset() {
    status.update({ phase: 'loading' });
    board.update({ phase: 'loading' });
    config.update({ phase: 'loading' });
    review.update({ phase: 'idle' });
    flow.update({ phase: 'loading' });
  }

  function dispose() {
    status.dispose();
    board.dispose();
    config.dispose();
    review.dispose();
    flow.dispose();
  }

  return {
    status, board, config, review, flow,
    loadStatus, loadBoard, loadConfig, saveConfig, loadCompare, loadFlow, loadPanel, reset, dispose,
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
  const names = ['status', 'board', 'config', 'review', 'flow'];
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
