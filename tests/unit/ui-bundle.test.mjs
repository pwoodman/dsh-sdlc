/**
 * tests/unit/ui-bundle.test.mjs — the sdlc-client-ui build contract.
 *
 * Pins what `scripts/build-ui.mjs` produces without a TS toolchain:
 * the closure-factory client bundle (`window.__ModuleLoader__.load`, react
 * externals, no JSX remnants, CSS injected), the host entry re-export, and
 * the package manifest (`dsh.bundle.patch` + `dsh.client` platform web).
 * The JSX subset compiler is pinned with positive + negative cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, core, clientBundleExports } from '../lib/helpers.mjs';

const PKG = join(ROOT, 'packages', 'sdlc-client-ui');
const read = (rel) => readFileSync(join(PKG, rel), 'utf8');

test('package manifest declares the bundle patch and the web client surface', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@patwoodman/dsh-sdlc-flow-ui');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0);
  assert.ok(pkg.exports['./client'], 'the ./client export is what the loader discovers');
  assert.ok(existsSync(join(PKG, 'cordis.patch.yml')), 'declared patch exists');
  assert.ok(existsSync(join(PKG, 'lib', 'index.js')), 'host entry built');
  assert.ok(existsSync(join(PKG, 'lib', 'client.js')), 'browser bundle built');
});

test('client bundle uses the closure-factory form with react externals', () => {
  const bundle = read('lib/client.js');
  // The loader keys its module table by the id, so it must be exactly the
  // package name — not a copy of it that a scope rename could leave behind.
  const pkgName = JSON.parse(read('package.json')).name;
  assert.ok(bundle.includes(`id: ${JSON.stringify(pkgName)}`), `bundle id must equal the package name (${pkgName})`);
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(bundle, /require\("react"\)/);
  assert.match(bundle, /require\("react\/jsx-runtime"\)/);
  assert.match(bundle, /exports\.apply/);
  assert.match(bundle, /exports\.inject/);
  // No ESM remnants in the shipped bundle.
  assert.doesNotMatch(bundle, /^import\s/m);
  assert.doesNotMatch(bundle, /^export\s+(function|const|async)/m);
  // No uncompiled JSX: every element compiles to __jsx/__jsxs. (JSDoc like
  // `?id=<id>` survives verbatim in comments — match element-shaped code
  // outside comments by requiring the __jsx call to exist and outnumber any
  // `<Tag` text.)
  assert.match(bundle, /__jsx\(/);
  const tagLikes = (bundle.match(/<[A-Za-z][A-Za-z0-9_.]*(\s[^<>]*|\s*)(\/>|>)/g) ?? [])
    .filter((m) => !m.includes('<id>') && !m.includes('<run>') && !m.includes('<your goal>'));
  assert.deepEqual(tagLikes, [], `uncompiled JSX remnants: ${tagLikes.slice(0, 3).join(' / ')}`);
  // CSS is injected at factory execution (the tsdown-preset pattern).
  assert.match(bundle, /document\.createElement\("style"\)/);
});

test('the bundle declares every React binding the client sources import', () => {
  // Regression: the closure bundler strips `import { useRef } from "react"`
  // and used to re-declare only a hardcoded three hooks, so using a fourth
  // hook crashed the sidebar slot at runtime (`useRef is not defined`). The
  // build now derives the list from the sources; this test pins the contract.
  const dir = join(PKG, 'src', 'client');
  const used = new Map();
  for (const file of readdirSync(dir)) {
    if (!/\.(js|jsx)$/.test(file)) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]react['"]/g)) {
      for (const raw of match[1].split(',')) {
        const entry = raw.trim();
        if (!entry) continue;
        const [imported, local = imported] = entry.split(/\s+as\s+/).map((name) => name.trim());
        used.set(local, imported);
      }
    }
  }
  assert.ok(used.size > 0, 'the client imports React hooks');
  const bundle = read('lib/client.js');
  for (const [local, imported] of used) {
    assert.ok(
      bundle.includes(`var ${local} = react.${imported};`),
      `bundle must declare var ${local} = react.${imported} (missing bindings crash the slot)`,
    );
  }
});

test('host entry re-exports the plugin surface', () => {
  const entry = read('lib/index.js');
  assert.match(entry, /server\/plugin\.js/);
  assert.match(entry, /PACKAGE/);
  // The loader reads `plugin.inject` from this module's namespace when it
  // activates the sdlc-ui row (no default export → the namespace IS the
  // plugin object). A missing re-export here is the exact regression that
  // made the row throw `cannot get property "connection" without inject`.
  assert.match(entry, /inject/);
});

test('host plugin declares the connection service inject', async () => {
  const entry = await import(`file://${join(PKG, 'src', 'index.js')}`);
  assert.deepEqual(entry.inject, ['connection']);
  // The loader prefers `.default`. A default that is `apply` has no `.inject`
  // and activates as `cannot get property "connection" without inject`.
  assert.equal(entry.default, undefined, 'src entry must not default-export apply');
  const plugin = await core.uiPlugin();
  assert.deepEqual(plugin.inject, ['connection']);
  assert.equal(plugin.default, undefined, 'server/plugin.js must not default-export apply');

  // lib/index.js is what a published install activates. The source contract
  // above is not sufficient: a stale or hand-edited build can drop `inject`
  // or grow a default export after the src/ tree is already correct.
  const built = await import(`file://${join(PKG, 'lib', 'index.js')}`);
  assert.deepEqual(built.inject, ['connection'], 'built host entry re-exports inject');
  assert.equal(typeof built.apply, 'function');
  assert.equal(built.default, undefined, 'built host entry must not default-export apply');
  const builtPlugin = await import(`file://${join(PKG, 'lib', 'server', 'plugin.js')}`);
  assert.equal(builtPlugin.default, undefined, 'built server plugin must not default-export apply');
  assert.deepEqual(builtPlugin.inject, ['connection']);
});

test('client bundle factory wires apply + inject under the loader contract', () => {
  // Grepping the bundle for `exports.inject` is not enough: the closure
  // factory is what the web module table executes, and a stripped or renamed
  // export there is the client-side twin of the connection bug — the sdlc tab
  // would never activate, with no error anywhere. So evaluate the shipped
  // artifact against a stub module loader (tests/lib/helpers.mjs) and assert
  // what the loader consumes.
  const { id, exports } = clientBundleExports();
  assert.equal(id, JSON.parse(read('package.json')).name, 'factory id equals the package name');
  assert.equal(typeof exports.apply, 'function', 'exports.apply is wired at the factory tail');
  assert.deepEqual(
    exports.inject,
    ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote', 'sessions', 'uiSession'],
    'exports.inject is wired and names exactly the browser services the client apply reads',
  );
  // The web module table unwraps with `exports.default ?? exports` (the same
  // Cordis unwrapExports the host loader uses). A factory that only sets
  // named exports leaves the default branch empty; a factory whose default
  // is the bare apply function drops inject. Either way the sidebar tab
  // never receives slots/locale/sidebarRight and the SDLC panel never mounts.
  assert.equal(exports.default?.apply, exports.apply, 'default export is the plugin object, not the bare apply');
  assert.deepEqual(exports.default?.inject, exports.inject, 'unwrapExports(default) still carries inject');
});

test('cordis patch declares the UI row for the web profile only', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /id:\s*sdlc-ui/);
  // Scope-agnostic: the row must name this package, whatever its scope is.
  assert.ok(patch.includes(JSON.parse(read('package.json')).name), 'the UI row names this package');
  const web = JSON.parse(readFileSync(join(ROOT, 'profiles', 'sdlc-web', 'profile.json'), 'utf8'));
  assert.deepEqual(web.bundles, ['@patwoodman/dsh-sdlc-flow'], 'lead installs exactly one spec (meta-bundle)');
  const worker = JSON.parse(readFileSync(join(ROOT, 'profiles', 'sdlc-worker', 'profile.json'), 'utf8'));
  assert.ok(!worker.bundles.includes('@patwoodman/dsh-sdlc-flow-ui'), 'sdlc-worker must not compose UI (E6/headless)');
  assert.ok(!worker.bundles.includes('@patwoodman/dsh-sdlc-flow'), 'sdlc-worker must not compose the meta-bundle (it pulls core)');
});

test('the bundle registers a reachable SDLC tab with a guide entry', () => {
  const { exports } = clientBundleExports();
  const definitions = [];
  const injected = [];
  let bodyRegistration = null;
  let registeredDefinition = null;
  let captureBody = false;
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    sidebarRightTabs: { register: (definition) => { definitions.push(definition); return () => {}; } },
    sidebarRight: { mounted: { getSnapshot: () => undefined, subscribe: () => () => {} }, openTab: () => {} },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    uiSession: { adapter: { current: { getSnapshot: () => ({}) } } },
    slots: {
      inject: (name, body) => {
        injected.push(name);
        captureBody = name === 'sidebar.right.pane.tab';
        if (captureBody) bodyRegistration = body();
        else body();
        captureBody = false;
        return () => {};
      },
      register: (definition) => { if (captureBody) registeredDefinition = definition; return () => {}; },
    },
    on: () => {},
    effect: (fn) => { fn(); },
  };
  exports.apply(ctx, { autoOpen: false });
  assert.equal(definitions.length, 1);
  const definition = definitions[0];
  assert.equal(definition.kind, 'sdlc');
  assert.equal(definition.id, '@patwoodman/dsh-sdlc-flow-ui');
  assert.ok(Array.isArray(definition.guide) && definition.guide.length === 1, 'the guide is the page type\'s door');
  assert.equal(definition.guide[0].id, 'flow');
  assert.equal(typeof definition.guide[0].order, 'number');
  assert.equal(definition.guide[0].title(), 'guide.title');
  assert.deepEqual(injected.sort(), ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  assert.ok(exports.default.inject.includes('sidebarRightTabs'));
  assert.match(read('lib/client.js'), /Needs attention/, 'the attention-first Flow panel is in the shipped bundle');
  assert.match(read('lib/client.js'), /Task detail/, 'task cards expand into a detail surface');
  assert.doesNotMatch(read('lib/client.js'), /StatusPanel|BoardPanel/, 'the duplicate Status and Board tabs are gone');
  assert.match(read('lib/client.js'), /__SDLC_VERSION__/, 'the panel build version is injected at bundle time');
  assert.match(read('lib/client.js'), /sessionId/, 'the tab body reads the session id for the workspace cwd');
  assert.ok(bodyRegistration, 'the tab body was registered');
  assert.ok(registeredDefinition, 'the tab body definition was registered');
  assert.equal(typeof registeredDefinition.store?.create, 'function', 'the slot gets a DSH store handle, not a raw store');
  const instance = registeredDefinition.store.create();
  assert.equal(typeof instance.getSnapshot, 'function');
  assert.equal(typeof instance.subscribe, 'function');
  assert.equal(typeof instance.clearPersisted, 'function');

  // React automatic-runtime contract: children live in props; the third jsx
  // argument is a key. Emitting `__jsx(tag, null, child)` crashed the first
  // real render with "reading 'key'".
  const bundle = read('lib/client.js');
  assert.match(bundle, /__jsx\("span", \{children:/);
  assert.doesNotMatch(bundle, /__jsx\([^,]+, null[,)]/);
  assert.doesNotMatch(bundle, /__jsxs\([^,]+, null[,)]/);

  // JSX whitespace between two expressions on one line is a single space.
  // The compiler used to drop it, so the state legend rendered "READY8".
  assert.ok(bundle.includes('stateLabel(t, segment.state)), " ", __jsx("b"'), 'a same-line space between expression children survives compilation');
  // Flow and Tasks share one snapshot; the tab polls it with the session cwd.
  assert.match(bundle, /stores\.loadFlow\(\{ cwd \}\)/, 'the tab effect loads and polls the flow snapshot with the session cwd');
  assert.match(bundle, /stores\.loadConfig\(cwd\)/, 'opening Settings loads the config snapshot with the session cwd');
});
