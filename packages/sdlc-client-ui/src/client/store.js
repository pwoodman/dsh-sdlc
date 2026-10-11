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

  async function loadCompare(task, a, b) {
    review.update({ phase: 'loading', task, a, b });
    const res = await api.fetchCompare(task, a, b);
    review.update(res.available
      ? { phase: 'ready', task, a, b, data: res.data }
      : { phase: 'missing', task, a, b, reason: res.reason });
  }

  function reset() {
    status.update({ phase: 'loading' });
    board.update({ phase: 'loading' });
    config.update({ phase: 'loading' });
    review.update({ phase: 'idle' });
  }

  function dispose() {
    status.dispose();
    board.dispose();
    config.dispose();
    review.dispose();
  }

  return { status, board, config, review, loadStatus, loadBoard, loadConfig, saveConfig, loadCompare, reset, dispose };
}

export default { createStore, createSdlcStores };
