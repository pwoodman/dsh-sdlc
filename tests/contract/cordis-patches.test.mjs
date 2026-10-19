/**
 * tests/contract/cordis-patches.test.mjs — static validation of the DSH bundles.
 *
 * The five `cordis.patch.yml` files are the composition of the profile plugins:
 * every row they declare becomes a loader entry at boot. Nothing in the test
 * suite parsed them before, so a typo in an `id`, a `name` that points at a
 * file that does not exist, or a duplicated row id across a profile's bundles
 * would only surface when DSH tried to boot a profile.
 *
 * This layer is deliberately static: it reads the patch files with the same
 * `yaml-lite` parser the code uses, reads every `packages/*​/package.json` and
 * every `profiles/*​/profile.json`, and asserts the invariants from spec v3
 * C.1/C.3/C.6, errata E2/E4/E6 and P1. It starts no process and needs no
 * network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../lib/helpers.mjs';
import { parseYaml } from '../../packages/sdlc-core/src/yaml-lite.js';
import { ROLES, presetIdFor, PUBLIC_ROLE_IDS } from '../../packages/sdlc-presets/src/roles.js';

/** The seven bundles that declare a patch (spec C.1). */
const PATCH_PACKAGES = ['sdlc-core', 'sdlc-guard', 'sdlc-tools', 'sdlc-presets', 'sdlc-mock-llm', 'sdlc-client-ui', 'sdlc-orchestrator'];

/** Errata E2: the closed set of profile templates. */
const TEMPLATES = new Set(['acp', 'web', 'headless', 'sdk', 'sdk-minimal']);

/** Spec C.1: the nine host service rows sdlc-core declares. */
const HOST_SERVICE_ROWS = [
  'sdlc-tasks',
  'sdlc-scheduler',
  'sdlc-router',
  'sdlc-verifier',
  'sdlc-integration',
  'sdlc-evidence',
  'sdlc-escalation',
  'sdlc-worker-mgr',
  'sdlc-recovery',
];

/** Our own new loader rows: `sdlc-*` host/tools rows and `preset-sdlc-*` presets. */
const OWN_ROW_ID = /^(preset-)?sdlc-/;

// ── fixture loading ─────────────────────────────────────────────────────────

const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = join(ROOT, 'packages', d.name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { dir, pkg };
  });

const byName = new Map(packages.map((p) => [p.pkg.name, p]));

const patchCache = new Map();

/** Parse a patch file into its top-level entries and every `insert` row. */
function loadPatch(absPath) {
  if (!patchCache.has(absPath)) {
    const text = readFileSync(absPath, 'utf8');
    const doc = parseYaml(text) ?? [];
    const rows = [];
    for (const entry of doc) {
      if (entry && Array.isArray(entry.insert)) rows.push(...entry.insert);
    }
    patchCache.set(absPath, { text, doc, rows });
  }
  return patchCache.get(absPath);
}

/** Normalise `dsh.bundle.patch` (string OR ordered list — P1/C1) to abs paths. */
function declaredPatchPaths({ dir, pkg }) {
  const raw = pkg.dsh?.bundle?.patch;
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((rel) => join(dir, rel));
}

/** All patch files declaring rows, paired with the package that declares them. */
function allPatchFiles() {
  const out = [];
  for (const entry of packages) {
    for (const abs of declaredPatchPaths(entry)) out.push({ ...entry, patch: abs });
  }
  return out;
}

function packageForDirName(name) {
  return packages.find((p) => p.dir === join(ROOT, 'packages', name));
}

function loadProfile(name) {
  const path = join(ROOT, 'profiles', name, 'profile.json');
  return { path, profile: JSON.parse(readFileSync(path, 'utf8')) };
}

const profileNames = readdirSync(join(ROOT, 'profiles'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// ── 1. declared patches exist ───────────────────────────────────────────────

test('contract: every declared dsh.bundle.patch points at an existing file', () => {
  for (const { dir, pkg } of packages) {
    const raw = pkg.dsh?.bundle?.patch;
    if (raw == null) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    assert.ok(list.length >= 1, `${pkg.name}: dsh.bundle.patch is empty`);
    for (const rel of list) {
      assert.equal(typeof rel, 'string', `${pkg.name}: patch entry must be a string`);
      assert.ok(existsSync(join(dir, rel)), `${pkg.name}: patch file ${rel} does not exist`);
    }
  }

  for (const dirName of PATCH_PACKAGES) {
    const entry = packageForDirName(dirName);
    assert.ok(entry, `packages/${dirName} exists`);
    assert.ok(entry.pkg.dsh?.bundle?.patch, `${entry.pkg.name} declares dsh.bundle.patch`);
    assert.equal(declaredPatchPaths(entry).length, 1, `${entry.pkg.name} declares exactly one patch`);
  }

  // P1/C1: the ordered-list form is also valid — sdlc-presets uses exactly one.
  const presets = byName.get('@patwoodman/dsh-sdlc-flow-presets');
  const presetsList = Array.isArray(presets.pkg.dsh.bundle.patch)
    ? presets.pkg.dsh.bundle.patch
    : [presets.pkg.dsh.bundle.patch];
  assert.equal(presetsList.length, 1, 'sdlc-presets declares exactly one patch');
});

// ── 2. row id uniqueness, within a file and across a profile's bundles ──────

test('contract: row ids are unique inside every patch file', () => {
  for (const { pkg, patch } of allPatchFiles()) {
    const { rows } = loadPatch(patch);
    const seen = new Set();
    for (const row of rows) {
      assert.ok(row && typeof row.id === 'string' && row.id.length > 0,
        `${pkg.name}: every row needs a non-empty string id`);
      assert.ok(!seen.has(row.id), `${pkg.name}: duplicate row id "${row.id}" in ${patch}`);
      seen.add(row.id);
    }
  }
});

/** Flatten the rows contributed by every bundle of one profile.
 *
 *  Mirrors the loader: `loadProfileDirectory` iterates the profile's
 *  `dsh.profile.bundles` list and loads each listed package's own patch. It does
 *  NOT walk a bundle's `dependencies` — so neither does this, otherwise the
 *  static check would pass a recipe that composes nothing live. */
function composedRows(profileName, seen = new Set()) {
  const { profile } = loadProfile(profileName);
  const rows = [];
  const walk = (bundle) => {
    if (seen.has(bundle)) return;
    seen.add(bundle);
    const entry = byName.get(bundle);
    assert.ok(entry, `${profileName}: unknown bundle "${bundle}"`);
    for (const patch of declaredPatchPaths(entry)) {
      for (const row of loadPatch(patch).rows) rows.push({ ...row, __bundle: bundle, __patch: patch });
    }
  };
  for (const bundle of profile.bundles) walk(bundle);
  return { profile, rows };
}

test('contract: a profile never composes the same row id twice', () => {
  for (const name of ['sdlc-web', 'sdlc-probe']) {
    const { rows } = composedRows(name);
    const seen = new Set();
    for (const row of rows) {
      assert.ok(!seen.has(row.id), `${name}: duplicate row id "${row.id}" across bundles`);
      seen.add(row.id);
    }
  }

  // Errata E6: mounting @patwoodman/dsh-sdlc-flow-core in a worker starts a second
  // scheduler and a second writer against sdlc.db.
  const { profile, rows } = composedRows('sdlc-worker');
  assert.ok(!profile.bundles.includes('@patwoodman/dsh-sdlc-flow-core'),
    'sdlc-worker bundles must not include @patwoodman/dsh-sdlc-flow-core');
  const coreRows = new Set(loadPatch(declaredPatchPaths(packageForDirName('sdlc-core'))[0]).rows.map((r) => r.id));
  for (const row of rows) {
    assert.ok(!coreRows.has(row.id), `sdlc-worker must not compose core row "${row.id}"`);
  }
});

// ── 2b. the lead really is ONE spec ─────────────────────────────────────────

test('contract: the lead recipe composes the whole lead from a single bundle', () => {
  // The DSH loader mounts only the bundles a profile lists and never descends
  // into a bundle's dependencies, so `['@patwoodman/dsh-sdlc-flow']` must already
  // declare every lead row in its own patch. Without this, the documented
  // one-spec install composes a single `sdlc-orchestrator` row and nothing else.
  const { profile } = loadProfile('sdlc-web');
  assert.deepEqual(profile.bundles, ['@patwoodman/dsh-sdlc-flow'], 'the lead installs exactly one sdlc bundle');

  const { rows } = composedRows('sdlc-web');
  const ids = new Set(rows.map((r) => r.id));
  for (const id of [...HOST_SERVICE_ROWS, 'sdlc-tools', 'sdlc-ui', 'sdlc-presets', 'sdlc-orchestrator']) {
    assert.ok(ids.has(id), `the composed lead is missing row "${id}"`);
  }
  const leadPresets = rows.filter((r) => /^preset-sdlc-/.test(r.id)).map((r) => r.id);
  assert.deepEqual(leadPresets.sort(), PUBLIC_ROLE_IDS.map(presetIdFor).sort(),
    'the composed lead publishes only the selectable role preset(s), not the worker roster');
});

test('contract: the lead meta-bundle overrides the shipped registry, never duplicates it', () => {
  // The web template ships agent-preset-registry. Inserting a second row with
  // the same id+name is loader-accepted, but the plugin manager's uninstall
  // audit matches live rows by id+name and reports "bundle-in-use" forever —
  // the shipped row still matches the removed bundle's contribution. The lead
  // must override the shipped row instead; only the member presets patch
  // (headless/sdk, which ship no registry) inserts it.
  const entry = packageForDirName('sdlc-orchestrator');
  const [patch] = declaredPatchPaths(entry);
  const { doc, rows } = loadPatch(patch);
  assert.equal(rows.filter((row) => row.id === 'agent-preset-registry').length, 0,
    'the lead meta-bundle must not insert agent-preset-registry');
  const overrides = doc.filter((op) => op && !('insert' in op) && op.id === 'agent-preset-registry');
  assert.equal(overrides.length, 1, 'the lead must override the shipped registry once');
  assert.equal(overrides[0].name, '@deepseek-ai/dsh-agent-preset-registry');
  assert.deepEqual(overrides[0].config, { default: 'sdlc-lead' });
});

test('contract: the meta-bundle patch is in sync with its members (generator --check)', () => {
  // packages/sdlc-orchestrator/cordis.patch.yml is generated from the members'
  // patches; a hand edit or a member change that is not regenerated would ship a
  // lead that silently misses rows.
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gen-bundle-patch.mjs'), '--check'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.equal(res.status, 0, `gen-bundle-patch --check failed:\n${res.stderr || res.stdout}`);
});

// ── 3. every row name resolves to a real module ─────────────────────────────

test('contract: our own row names resolve to real src/ (or lib/) files', async () => {
  // Ownership is decided by whether the row's package is one of THIS workspace's
  // manifests, never by a scope literal. The previous `startsWith('@patwoodman/')`
  // filter meant that after `scripts/set-scope.mjs` renamed the suite, every row
  // was skipped and the test passed while checking nothing at all.
  let checked = 0;
  const { resolveRowName } = await import('../../scripts/lib/composition.mjs');
  for (const { pkg, patch } of allPatchFiles()) {
    for (const row of loadPatch(patch).rows) {
      if (typeof row.name !== 'string') continue;
      const pkgName = row.name.split('/').slice(0, 2).join('/');
      // @deepseek-ai/* (and any other out-of-workspace package) is external.
      if (!byName.has(pkgName)) continue;
      checked += 1;
      // Resolve the same way the static composition does: src/ and lib/ files
      // for plain subpaths, and the package `exports` map for folded aliases
      // (`@patwoodman/dsh-sdlc-flow/services` → lib/rows/core/lib/services.js).
      const resolved = resolveRowName(row.name);
      assert.ok(
        resolved.ok,
        `${pkg.name}: row "${row.id}" name "${row.name}" does not resolve (${resolved.reason})`,
      );
    }
  }
  assert.ok(checked > 0, 'at least one own-workspace row name must be checked — a scope rename must not empty this test');
});

// ── 4. sdlc-presets: exactly 26 preset rows + the registry row ─────────────

test('contract: sdlc-presets declares exactly the 26 presetIdFor(roleId) rows', () => {
  const entry = packageForDirName('sdlc-presets');
  const [patch] = declaredPatchPaths(entry);
  const { rows } = loadPatch(patch);

  const presetRows = rows.filter((r) => /^preset-sdlc-/.test(r.id));
  assert.equal(presetRows.length, 26, 'sdlc-presets declares exactly 26 preset rows');
  // …plus the agent-preset-registry row headless/sdk lack, which the presets
  // wait on (without it every treatment run warns 26× "did not activate …
  // waiting for service: agentPresets"). It is FIRST inside insert: because
  // the dialect has no insert-if-missing. The lead meta-bundle is different:
  // web ships the row, so gen-bundle-patch converts this insert into an
  // override (a duplicate id+name blocks plugin-manager uninstall).
  const registry = rows.filter((r) => r.id === 'agent-preset-registry');
  assert.equal(registry.length, 1, 'sdlc-presets declares the agent-preset-registry row once');
  assert.equal(registry[0].name, '@deepseek-ai/dsh-agent-preset-registry');
  // …plus the bundle's own `sdlc-presets` plugin row, which executes its
  // apply() at boot so the SDLC_SELFTEST hook reports the roster (data-only
  // patches never run code — without it the live probe reports zero presets).
  const self = rows.filter((r) => r.id === 'sdlc-presets');
  assert.equal(self.length, 1, 'sdlc-presets declares its self-report plugin row');
  assert.equal(self[0].name, '@patwoodman/dsh-sdlc-flow-presets/plugin');
  assert.equal(rows.length, 28, 'sdlc-presets declares preset rows + registry + self-report');

  const ids = presetRows.map((r) => r.id);
  const expected = ROLES.map((role) => presetIdFor(role.id));
  assert.equal(new Set(ids).size, ids.length, 'preset ids are unique');
  assert.deepEqual([...ids].sort(), [...expected].sort(), 'preset ids equal presetIdFor(roleId)');
  for (const id of expected) assert.ok(ids.includes(id), `missing preset row ${id}`);
});

// ── 5. sdlc-core: the nine host service rows ────────────────────────────────

test('contract: sdlc-core declares the nine host service rows', () => {
  const entry = packageForDirName('sdlc-core');
  const [patch] = declaredPatchPaths(entry);
  const { rows } = loadPatch(patch);

  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, [...HOST_SERVICE_ROWS].sort(), 'sdlc-core declares exactly the nine host service rows');
  for (const row of rows) {
    assert.equal(typeof row.config?.service, 'string', `row "${row.id}" has a config.service string`);
  }
});

// ── 6. errata E4: no `remove:` and no insert-wrapped existing-row override ──

test('contract: no patch uses remove: or inserts an id-targeted existing-row override', () => {
  for (const { pkg, patch } of allPatchFiles()) {
    const { text, doc, rows } = loadPatch(patch);

    assert.doesNotMatch(text, /^\s*remove\s*:/m, `${pkg.name}: patch must not use a remove: op`);
    for (const op of doc) {
      assert.ok(!op || !('remove' in op), `${pkg.name}: patch entry uses remove:`);
    }

    // An `insert:` list may only contain NEW rows of ours. A row id belonging
    // to some pre-existing loader row (e.g. agent-default-model) inserted here
    // would be a duplicate; the id-targeted override form belongs at top level.
    // (`agent-preset-registry` is the one deliberate exception IN THE MEMBER
    // PATCH: the row must reach headless/sdk profiles that ship no such id, and
    // the dialect has no insert-if-missing. The lead meta-bundle must NOT
    // insert it — web ships the row, and a duplicate id+name blocks the plugin
    // manager's uninstall audit. gen-bundle-patch converts that member insert
    // into a top-level override for the lead; see the registry test above.)
    for (const row of rows) {
      assert.ok(OWN_ROW_ID.test(row.id) || row.id === 'agent-preset-registry',
        `${pkg.name}: row "${row.id}" inside insert: is not our own sdlc-*/preset-sdlc-* row (E4)`);
    }
  }
});

// ── 7. `!!js` tags never appear on id:/name: lines ──────────────────────────

test('contract: !!js expressions never sit on an id: or name: line', () => {
  for (const { pkg, patch } of allPatchFiles()) {
    const lines = loadPatch(patch).text.split('\n');
    for (const line of lines) {
      if (!line.includes('!!js')) continue;
      assert.doesNotMatch(line, /^\s*(id|name)\s*:/,
        `${pkg.name}: !!js on an id:/name: line is not a valid config value: ${line.trim()}`);
    }
  }
});

// ── 8. profiles: template set, mustNotContain, bundle references ────────────

test('contract: profiles use a valid template and respect mustNotContain', () => {
  assert.ok(profileNames.length >= 3, 'the three sdlc profiles exist');

  for (const name of profileNames) {
    const { profile } = loadProfile(name);
    assert.ok(TEMPLATES.has(profile.template),
      `${name}: template "${profile.template}" is outside {${[...TEMPLATES].join(', ')}} (E2)`);
    assert.ok(Array.isArray(profile.bundles), `${name}: bundles is an array`);
    assert.ok(Array.isArray(profile.mustNotContain), `${name}: mustNotContain is an array`);
    for (const bundle of profile.bundles) {
      assert.ok(byName.has(bundle), `${name}: bundle "${bundle}" has no packages/*/package.json`);
    }
    for (const forbidden of profile.mustNotContain) {
      assert.ok(!profile.bundles.includes(forbidden),
        `${name}: mustNotContain "${forbidden}" is still in bundles`);
    }
  }

  // Errata E6 explicitly: the worker profile must exclude core.
  const worker = loadProfile('sdlc-worker').profile;
  assert.ok(worker.mustNotContain.includes('@patwoodman/dsh-sdlc-flow-core'),
    'sdlc-worker mustNotContain @patwoodman/dsh-sdlc-flow-core');
  assert.ok(!worker.bundles.includes('@patwoodman/dsh-sdlc-flow-core'),
    'sdlc-worker bundles must not include @patwoodman/dsh-sdlc-flow-core');
});
