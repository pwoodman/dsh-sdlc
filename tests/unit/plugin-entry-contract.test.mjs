/**
 * tests/unit/plugin-entry-contract.test.mjs — the loader-facing plugin contract.
 *
 * Two failure classes have already produced dead rows in this suite, and both
 * are invisible until a live DSH boot:
 *
 * 1. Service injection (beta.7, still the live failure mode): `ctx.connection`
 *    read from apply() without the entry exporting `inject` threw
 *    `cannot get property "connection" without inject` at activation. The
 *    loader reads `plugin.inject` from the ENTRY module's exports, so the
 *    declaration must live (or be re-exported) there.
 *
 *    A named `inject` export is not enough on its own. Cordis
 *    `Loader.unwrapExports` prefers `.default` (`exports.default ?? exports`).
 *    `export default apply` makes the plugin the bare function, which has no
 *    `.inject`, so `Inject.resolve(undefined)` starts the fiber with an empty
 *    dependency map and the context proxy throws the same error inside
 *    `registerRoutes` — exactly the `sdlc-ui` activation failure. Entries
 *    therefore export `apply` and `inject` as named bindings only.
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
import { createRequire } from 'node:module';
import { load, tempDir, cleanup, clientBundleExports, ROOT } from '../lib/helpers.mjs';
import { join } from 'node:path';

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

/**
 * Cordis `Loader.unwrapExports`: a default export wins, and a function default
 * carries no `inject`. Reproduced here so the suite does not depend on cordis
 * being importable just to state the rule the activation test then executes.
 */
function unwrapExports(exports) {
  if (exports == null) return exports;
  const unwrapped = exports.default ?? exports;
  if (!unwrapped.__esModule) return unwrapped;
  return unwrapped.default ?? unwrapped;
}

for (const entry of ENTRIES) {
  test(`apply() returns nothing — ${entry.name}`, async () => {
    const mod = await load(entry.load);
    assert.equal(typeof mod.apply, 'function', `${entry.name} exports apply`);
    // unwrapExports prefers `.default`. A function default is the bare apply
    // and has no `.inject` — that is the sdlc-ui activation failure. An object
    // default (the meta-bundle's `{ apply, … }`) is a plugin object and is
    // fine as long as inject, when required, survives the unwrap.
    assert.notEqual(
      mod.default,
      mod.apply,
      `${entry.name} must not default-export the apply function — unwrapExports would drop inject`,
    );
    const plugin = unwrapExports(mod);
    assert.equal(typeof plugin.apply, 'function', `${entry.name}: unwrapExports still yields an apply`);
    if (entry.inject) {
      assert.equal(mod.default, undefined, `${entry.name} inject lives on the namespace; a default export would hide it`);
      assert.deepEqual(mod.inject, entry.inject, `${entry.name} declares its host services in inject`);
      assert.deepEqual(plugin.inject, entry.inject, `${entry.name}: unwrapExports keeps inject on the plugin object`);
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

test('sdlc-ui activates under Cordis when connection is provided, and fails closed without inject', async () => {
  // This is the gate the published row has to pass before it can ship.
  // `registry.plugin` is what the loader calls after `unwrapExports`; a
  // missing or stripped `inject` puts the fiber in state 3 (failed) with
  // `cannot get property "connection" without inject` at registerRoutes,
  // which is the warning DSH prints as "1 entry did not activate sdlc-ui".
  const require = createRequire(import.meta.url);
  let cordis;
  try {
    cordis = require(join(ROOT, '.tools/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'));
  } catch (err) {
    // The vendored runtime is how this suite talks to the real proxy. Skipping
    // would let the activation bug ship again, so a missing cordis fails here.
    assert.fail(`@deepseek-ai/cordis is required to gate sdlc-ui activation (${err?.message ?? err})`);
  }
  const { Context, Service } = cordis;
  const entry = await load('packages/sdlc-client-ui/src/index.js');
  const plugin = unwrapExports(entry);
  assert.deepEqual(plugin.inject, ['connection']);
  assert.equal(typeof plugin.apply, 'function');
  assert.notEqual(plugin, plugin.apply, 'unwrapExports must not reduce the plugin to the bare apply function');

  const root = new Context();
  const registered = [];
  class Connection extends Service {
    constructor(ctx) {
      super(ctx, 'connection');
      this.fetch = {
        register: (route) => {
          registered.push(`${route.methods[0]} ${route.path}`);
          return () => {};
        },
      };
    }
  }
  const connectionFiber = root.plugin(Connection);
  await connectionFiber;
  assert.equal(connectionFiber.state, 2, 'the connection service itself activates');

  const activated = root.plugin(plugin, {});
  await activated;
  assert.equal(
    activated.state,
    2,
    `sdlc-ui fiber failed: ${activated._error?.message ?? activated._error}`,
  );
  assert.deepEqual(registered, [
    'GET /api/sdlc.status',
    'GET /api/sdlc.board',
    'GET /api/sdlc.task',
    'GET /api/sdlc.compare',
    'GET /api/sdlc.config',
    'GET /api/sdlc.metrics',
    'POST /api/sdlc.config',
  ]);

  // The regression: default-exporting apply (or forgetting inject) is fatal,
  // and the message is the one the host prints at enable time. A bare function
  // is what unwrapExports returns from `export default apply`.
  const broken = root.plugin(plugin.apply, {});
  await Promise.resolve(broken).then(
    () => assert.fail('bare apply (no inject) must not activate'),
    (err) => assert.match(err?.message ?? '', /cannot get property "connection" without inject/),
  );
  assert.equal(broken.state, 3, 'a plugin that reads connection without inject ends failed, not loaded');
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
