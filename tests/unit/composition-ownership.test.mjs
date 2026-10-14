/**
 * tests/unit/composition-ownership.test.mjs — "is this bundle OURS?".
 *
 * Regression: `scripts/install-local.mjs` decided which entries in
 * `dsh.profile.bundles` were the suite's own by testing a hardcoded
 * `@patwoodman/` prefix. `scripts/set-scope.mjs` renames the whole suite in one
 * pass, and a tree that had been re-scoped still carried the OLD scope in the
 * bundle list. The installer did not recognise it, left it selected, and the
 * lead then composed every row twice — M0-02 failed with 39 duplicate row ids
 * and `doctor` reported the extra bundle. The same literal was in the
 * dead-dependency repair, so a moved checkout kept an unresolvable
 * `@old-scope/...` dependency that broke `dsh plugin add` for every profile.
 *
 * The helpers are derived from the workspace manifests, so a rename cannot
 * desynchronise them. These tests pin the *behaviour* (recognise any scope this
 * suite has been published under, never claim a foreign package) and run against
 * a synthetic package map so they keep meaning after the next rename.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownScope, ownBundlePrefix, isOwnBundleName, loadPackages } from '../../scripts/lib/composition.mjs';

/** A package map in the shape `loadPackages()` returns. */
const mapOf = (...names) =>
  new Map(names.map((name) => [name, { name, dir: `/tmp/${name}`, pkg: { name } }]));

test('ownScope derives the scope from the manifests, not a constant', () => {
  // Basenames are whatever the workspace manifests carry: the meta-bundle is
  // the one WITHOUT a member suffix (-core/-tools/-guard/…), whatever its stem.
  assert.equal(ownScope(mapOf('@acme/dsh-sdlc-flow', '@acme/dsh-sdlc-flow-core', '@acme/dsh-sdlc-flow-tools')), '@acme');
  assert.equal(ownScope(mapOf('@my-name/dsh-sdlc-flow-core', '@my-name/dsh-sdlc-flow-tools')), '@my-name');
  // A single unpublished member still identifies the suite.
  assert.equal(ownScope(mapOf('@solo/dsh-sdlc-flow-guard')), '@solo');
});

test('ownScope picks the scope that holds the meta-bundle when two are present', () => {
  // The real tree after a scope rename: the packages all moved, but a stray
  // manifest from the previous scope could still be around.
  const scope = ownScope(mapOf('@old/dsh-sdlc-flow-stale', '@new/dsh-sdlc-flow', '@new/dsh-sdlc-flow-core', '@new/dsh-sdlc-flow-tools'));
  assert.equal(scope, '@new');
});

test('ownScope falls back to the majority scope for a map with no members', () => {
  assert.equal(ownScope(mapOf('@a/one', '@a/two', '@b/three')), '@a');
  assert.equal(ownScope(new Map()), '@sdlc', 'an empty map falls back to the documented default');
});

test('ownBundlePrefix is the scope plus a slash', () => {
  const packages = mapOf('@acme/orchestrator', '@acme/orchestrator-core');
  assert.equal(ownBundlePrefix(packages), '@acme/');
});

test('isOwnBundleName recognises the suite under ANY scope it has lived at', () => {
  const packages = mapOf('@new/dsh-sdlc-flow', '@new/dsh-sdlc-flow-core', '@new/dsh-sdlc-flow-tools');
  // Current scope.
  assert.equal(isOwnBundleName('@new/dsh-sdlc-flow', packages), true);
  assert.equal(isOwnBundleName('@new/dsh-sdlc-flow-core', packages), true);
  // A scope the tree no longer uses: this is the entry an upgrade must clean up,
  // and the reason the check cannot filter on the current prefix alone.
  assert.equal(isOwnBundleName('@old/dsh-sdlc-flow', packages), true);
  assert.equal(isOwnBundleName('@sdlc/dsh-sdlc-flow-tools', packages), true);
});

test('isOwnBundleName matches on the basename, so a stale scope is still ours', () => {
  const packages = mapOf('@new/dsh-sdlc-flow', '@new/dsh-sdlc-flow-core');
  // Deliberate: the alternative — recognising only scopes this tree has used —
  // would need a history of every scope, and the profiles are ours end to end,
  // so an own-basename bundle under an unknown scope is far more likely to be a
  // leftover from a rename than someone else's package.
  assert.equal(isOwnBundleName('@someone-else/dsh-sdlc-flow', packages), true);
});

test('isOwnBundleName never claims a foreign package or malformed input', () => {
  const packages = mapOf('@new/dsh-sdlc-flow', '@new/dsh-sdlc-flow-core');
  assert.equal(isOwnBundleName('@deepseek-ai/dsh-base', packages), false);
  assert.equal(isOwnBundleName('@deepseek-ai/dsh-web-app', packages), false);
  assert.equal(isOwnBundleName('@deepseek-ai/dsh-headless', packages), false);
  assert.equal(isOwnBundleName('dsh-sdlc-flow', packages), false, 'a bare name has no scope');
  assert.equal(isOwnBundleName(undefined, packages), false);
  assert.equal(isOwnBundleName('', packages), false);
  assert.equal(isOwnBundleName('@new', packages), false);
  assert.equal(isOwnBundleName('@new/dsh-sdlc-flow-extra', packages), false, 'a prefix of a real basename is not a match');
});

test('the real tree identifies itself and leaves the platform bundles alone', () => {
  const packages = loadPackages();
  const scope = ownScope(packages);
  assert.match(scope, /^@[^/]+$/, `derived scope ${scope}`);
  const names = [...packages.keys()];
  assert.ok(names.every((n) => n.startsWith(`${scope}/`)), 'every workspace package lives under the derived scope');
  assert.equal(isOwnBundleName(`${scope}/dsh-sdlc-flow`, packages), true);
  assert.equal(isOwnBundleName('@deepseek-ai/dsh-base', packages), false);
});
