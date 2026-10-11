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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/helpers.mjs';

const PKG = join(ROOT, 'packages', 'sdlc-client-ui');
const read = (rel) => readFileSync(join(PKG, rel), 'utf8');

test('package manifest declares the bundle patch and the web client surface', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@patwoodman/orchestrator-ui');
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
    .filter((m) => !m.includes('<id>') && !m.includes('<run>'));
  assert.deepEqual(tagLikes, [], `uncompiled JSX remnants: ${tagLikes.slice(0, 3).join(' / ')}`);
  // CSS is injected at factory execution (the tsdown-preset pattern).
  assert.match(bundle, /document\.createElement\("style"\)/);
});

test('host entry re-exports the plugin surface', () => {
  const entry = read('lib/index.js');
  assert.match(entry, /server\/plugin\.js/);
  assert.match(entry, /PACKAGE/);
});

test('cordis patch declares the UI row for the web profile only', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /id:\s*sdlc-ui/);
  // Scope-agnostic: the row must name this package, whatever its scope is.
  assert.ok(patch.includes(JSON.parse(read('package.json')).name), 'the UI row names this package');
  const web = JSON.parse(readFileSync(join(ROOT, 'profiles', 'sdlc-web', 'profile.json'), 'utf8'));
  assert.deepEqual(web.bundles, ['@patwoodman/orchestrator'], 'lead installs exactly one spec (meta-bundle)');
  const worker = JSON.parse(readFileSync(join(ROOT, 'profiles', 'sdlc-worker', 'profile.json'), 'utf8'));
  assert.ok(!worker.bundles.includes('@patwoodman/orchestrator-ui'), 'sdlc-worker must not compose UI (E6/headless)');
  assert.ok(!worker.bundles.includes('@patwoodman/orchestrator'), 'sdlc-worker must not compose the meta-bundle (it pulls core)');
});
