/**
 * tests/unit/plugin-entry-contract.test.mjs — the loader-facing plugin contract.
 *
 * Two failure classes have already produced dead rows in this suite, and both
 * are invisible until a live DSH boot:
 *
 * 1. Service injection (beta.7): `ctx.connection` read from apply() without the
 *    entry exporting `inject` threw `cannot get property "connection" without
 *    inject` at activation. The loader reads `plugin.inject` from the ENTRY
 *    module's exports, so the declaration must live (or be re-exported) there.
 *
 * 2. The apply() return value (pinned here): the Cordis runner interprets a
 *    plugin's return value as an effect. Verified against @deepseek-ai/cordis
 *    4.0.1: a plain-object return is FATAL for a non-constructible apply
 *    (`TypeError: Invalid effect`, fiber state 3) and — for the regular-function
 *    applies this suite ships — both object returns AND disposer returns are
 *    silently swallowed (constructed as a class, `new apply(ctx, config)`, so
 *    the returned object/function never reaches the effect interpreter). The
 *    framework's own plugins all return nothing and release resources through
 *    `ctx.effect`. These tests keep it that way: a refactor that "helpfully"
 *    returns a report, or converts apply() to an arrow, fails here instead of
 *    bricking a row that only a live boot would expose.
 *
 * The entry table is the composed row surface (one entry per `name:` in the
 * bundle patches), so a new row must be added here when it is declared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, tempDir, cleanup, clientBundleExports } from '../lib/helpers.mjs';

const stubLogger = () => ({ debug() {}, warn() {}, error() {} });

/**
 * Every loader-facing entry in the suite. `config`/`dispose` are for entries
 * whose apply touches the filesystem (core opens a runtime; guard wants a
 * worktree root).
 */
const ENTRIES = [
  {
    name: '@patwoodman/orchestrator (meta-bundle)',
    load: 'packages/sdlc-orchestrator/src/index.js',
  },
  {
    name: '@patwoodman/orchestrator-core/services',
    load: 'packages/sdlc-core/src/services.js',
    config: (dir) => ({
      projectRoot: dir, storage: { dbPath: '.sdlc/sdlc.db' }, safety: { instanceLock: false }, service: 'tasks',
    }),
    // apply created the per-project-root runtime; close it the way the host
    // would so the temp db handle never outlives the test.
    dispose: async (mod, dir) => mod.closeRuntime(dir),
  },
  {
    name: '@patwoodman/orchestrator-guard/plugin',
    load: 'packages/sdlc-guard/src/plugin.js',
    config: (dir) => ({ worktreeRoot: dir }),
  },
  {
    name: '@patwoodman/orchestrator-mock-llm',
    load: 'packages/sdlc-mock-llm/src/index.js',
  },
  {
    name: '@patwoodman/orchestrator-presets/plugin',
    load: 'packages/sdlc-presets/src/plugin.js',
  },
  {
    name: '@patwoodman/orchestrator-tools/plugin',
    load: 'packages/sdlc-tools/src/plugin.js',
  },
  {
    name: '@patwoodman/orchestrator-ui (host)',
    load: 'packages/sdlc-client-ui/src/index.js',
    // Host services this entry reads from ctx: the loader must see them in
    // `inject`, or activation throws (`cannot get property … without inject`).
    inject: ['connection'],
  },
];

for (const entry of ENTRIES) {
  test(`apply() returns nothing — ${entry.name}`, async () => {
    const mod = await load(entry.load);
    assert.equal(typeof mod.apply, 'function', `${entry.name} exports apply`);
    if (entry.inject) {
      assert.deepEqual(mod.inject, entry.inject, `${entry.name} declares its host services in inject`);
    }
    const dir = tempDir('sdlc-entry-contract-');
    try {
      const ctx = { provide() {}, logger: stubLogger() };
      const result = await mod.apply(ctx, entry.config ? entry.config(dir) : {});
      assert.equal(
        result,
        undefined,
        `${entry.name}::apply must return nothing — the Cordis runner reads a plugin return value as an effect `
        + `(a plain object is fatal for a non-constructible apply, and object/disposer returns are silently `
        + `dropped for a regular-function apply). Return reports from the named helpers instead.`,
      );
    } finally {
      await entry.dispose?.(mod, dir);
      cleanup(dir);
    }
  });
}

test('apply() is a regular function on every entry (the documented plugin shape)', async () => {
  // Not load-bearing on its own — void returns are safe for arrows too — but a
  // regular function keeps the construct-as-class path identical to what the
  // framework's own plugins ship, and `prototype` is how the suite can tell
  // without importing cordis.
  for (const entry of ENTRIES) {
    const mod = await load(entry.load);
    assert.ok(mod.apply.prototype, `${entry.name}::apply should stay a regular function`);
  }
});

test('the client entry returns nothing and declares its browser services in inject', async () => {
  // The client runtime is Cordis too (browser side), so the same return-value
  // contract applies — and a wrong service name in `inject` leaves the web row
  // waiting forever instead of failing loudly. The list below was cross-checked
  // against the framework's own client plugins (dsh-client-ui-deliverables'
  // client inject is a superset of these names).
  //
  // Driven through the SHIPPED bundle (lib/client.js) — the src/ tree is raw
  // JSX that node cannot import, and the bundle is what the web loader runs.
  const { id, exports } = clientBundleExports();
  assert.equal(id, '@patwoodman/orchestrator-ui', 'factory id equals the package name');
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote']);

  const effects = [];
  const ctx = {
    effect: (produce, label) => { effects.push(label); const d = produce?.(); return typeof d === 'function' ? d : () => {}; },
    on() {},
    locale: { bind: () => (key) => key, register() {} },
    sidebarRightTabs: { register() { return () => {}; } },
    slots: { inject() {}, register() {} },
  };
  const result = await exports.apply(ctx);
  assert.equal(result, undefined, 'client apply must return nothing (same effect interpretation as the host)');
  assert.ok(effects.length >= 4, `expected the dictionary/tab/seat effects, got ${effects.length}`);
});
