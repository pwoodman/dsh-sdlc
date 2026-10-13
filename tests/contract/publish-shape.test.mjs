/**
 * tests/contract/publish-shape.test.mjs — publish readiness (best-practice shape).
 *
 * Pins the npm-distribution contract every shippable bundle must satisfy
 * (per the DSH cookbook `adding-a-package.md`):
 *   - publishable bundles are NOT private, carry an MIT license, and ship
 *     locale display metadata (title/description) + icon-safe exports;
 *   - every bundle declares the DSH peer as a bounded range (P36, beta.2) and
 *     declares its patch;
 *   - the meta-bundle depends on exact versions of its four members;
 *   - the worker profile never composes the meta-bundle (E6);
 *   - sdlc-mock-llm stays private (test-only, never published).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/helpers.mjs';
import { DSH_PEER_RANGE, dshPeerSatisfied } from '../../scripts/lib/semver-lite.mjs';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const SHIPPABLE = [
  '@patwoodman/orchestrator',
  '@patwoodman/orchestrator-core',
  '@patwoodman/orchestrator-guard',
  '@patwoodman/orchestrator-tools',
  '@patwoodman/orchestrator-presets',
  '@patwoodman/orchestrator-ui',
  '@patwoodman/orchestrator-cli',
];

function pkgDir(name) {
  for (const d of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const manifest = join(ROOT, 'packages', d.name, 'package.json');
    if (!existsSync(manifest)) continue;
    if (JSON.parse(readFileSync(manifest, 'utf8')).name === name) return join(ROOT, 'packages', d.name);
  }
  return null;
}

test('publish: shippable bundles are public, licensed, and versioned with root', () => {
  for (const name of SHIPPABLE) {
    const dir = pkgDir(name);
    assert.ok(dir, `${name} exists under packages/`);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.ok(!pkg.private, `${name} must not be private (publishable)`);
    assert.equal(pkg.license, 'MIT', `${name} needs an MIT license`);
    assert.equal(pkg.version, VERSION, `${name} version tracks root (${VERSION})`);
    assert.ok(existsSync(join(dir, 'LICENSE')), `${name} ships a LICENSE file`);
    assert.ok((pkg.files ?? []).includes('LICENSE'), `${name} files[] includes LICENSE`);
  }
});

test('publish: mock-llm stays private (test-only, never published)', () => {
  const dir = pkgDir('@patwoodman/orchestrator-mock-llm');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true, 'mock-llm must stay private');
});

test('publish: every bundle declares the DSH peer range and declares its patch', () => {
  for (const name of [...SHIPPABLE, '@patwoodman/orchestrator-mock-llm']) {
    const dir = pkgDir(name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh'], DSH_PEER_RANGE, `${name} declares dsh peer ${DSH_PEER_RANGE} (P36, beta.2)`);
    if (name === '@patwoodman/orchestrator-cli') continue; // CLI is not a DSH bundle
    const patch = pkg.dsh?.bundle?.patch;
    assert.ok(patch, `${name} declares dsh.bundle.patch`);
    for (const rel of Array.isArray(patch) ? patch : [patch]) {
      assert.ok(existsSync(join(dir, rel)), `${name}: patch ${rel} exists`);
    }
  }
});

test('publish: the peer range admits the verified ground-truth runtimes and excludes the next line', () => {
  // The range must stay compatible with what the gates actually verified.
  assert.ok(dshPeerSatisfied('0.2.0-rc.2'), '0.2.0-rc.2 (verified ground truth) must stay in range');
  assert.ok(dshPeerSatisfied('0.2.1-alpha.2'), '0.2.x prereleases must stay in range');
  assert.ok(!dshPeerSatisfied('0.3.0'), 'the 0.3 line is out of range by design');
  assert.ok(!dshPeerSatisfied('0.1.0'), 'older lines are out of range');
});

test('publish: display metadata (locale title/description) exists and is exported', () => {
  for (const name of SHIPPABLE) {
    const dir = pkgDir(name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const lang of ['en', 'zh']) {
      const rel = `locale/${lang}.json`;
      assert.ok(existsSync(join(dir, rel)), `${name} ships ${rel}`);
      const doc = JSON.parse(readFileSync(join(dir, rel), 'utf8'));
      assert.ok(typeof doc.meta?.title === 'string' && doc.meta.title.length > 0, `${name}/${rel} has meta.title`);
      assert.ok(typeof doc.meta?.description === 'string' && doc.meta.description.length > 0, `${name}/${rel} has meta.description`);
    }
    assert.ok(pkg.exports?.['./locale/*.json'], `${name} exports ./locale/*.json`);
    assert.ok(pkg.exports?.['./package.json'], `${name} exports ./package.json (locale fallback reads it)`);
    assert.ok((pkg.files ?? []).includes('locale/*.json'), `${name} files[] includes locale`);
  }
});

test('publish: per-package build entry exists and is runnable offline', () => {
  for (const name of SHIPPABLE) {
    const dir = pkgDir(name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts?.build, `${name} has a build script`);
    assert.ok(pkg.scripts?.prepack, `${name} builds on prepack`);
    // `prepack` only covers `npm pack`/`npm publish`. A git/GitHub or `file:`
    // install runs `prepare` instead — without it the consumer gets a package
    // with no lib/ and the loader reports a missing host entry.
    assert.ok(pkg.scripts?.prepare, `${name} builds on prepare (git and file: installs)`);
  }
});

test('publish: bundles ship and export a package-root icon and their patch', () => {
  // The Plugin Manager and Settings read display metadata "without activating
  // plugins": locale JSON for title/description, and an icon from an exported
  // resource (or a top-level `icon` in package.json, which takes priority).
  // Missing them is not fatal — the panel falls back to name/description and
  // generic artwork — but the cookbook makes them part of the delivery
  // checklist, so they are pinned here.
  const MAX_ICON_BYTES = 256 * 1024;
  for (const name of SHIPPABLE) {
    const dir = pkgDir(name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (name === '@patwoodman/orchestrator-cli') continue; // the CLI is not a bundle
    assert.equal(pkg.icon, 'icon.svg', `${name} declares a package-root icon`);
    assert.ok(existsSync(join(dir, 'icon.svg')), `${name} ships icon.svg`);
    assert.ok(readFileSync(join(dir, 'icon.svg')).length <= MAX_ICON_BYTES, `${name} icon is under 256 KiB`);
    assert.equal(pkg.exports?.['./icon'], './icon.svg', `${name} exports ./icon`);
    assert.equal(pkg.exports?.['./cordis.patch.yml'], './cordis.patch.yml', `${name} exports its patch`);
    assert.ok((pkg.files ?? []).includes('icon.svg'), `${name} files[] includes the icon`);
    assert.ok(existsSync(join(dir, 'README.md')), `${name} ships a README`);
    assert.ok((pkg.files ?? []).includes('README.md'), `${name} files[] includes the README`);
  }
});

test('publish: scoped packages declare public access and a node engine', () => {
  for (const name of SHIPPABLE) {
    const dir = pkgDir(name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // npm publishes scoped packages as restricted by default; without this the
    // first `npm publish` is refused.
    assert.equal(pkg.publishConfig?.access, 'public', `${name} publishes with public access`);
    assert.ok(pkg.engines?.node, `${name} declares engines.node (node:sqlite needs >= 22.5)`);
  }
});

test('publish: the meta-bundle is self-contained — no member dependencies', () => {
  // The whole point of the fold (beta.9): a profile installs ONE own-scope
  // package, so the plugin manager's remove button uninstalls everything in
  // one click — no ghost member entries, nothing refused as "still required".
  const dir = pkgDir('@patwoodman/orchestrator');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'meta-bundle must not depend on its members anymore');
  assert.ok(!pkg.dependencies?.['@patwoodman/orchestrator-guard'], 'meta-bundle must not pull the guard');
  assert.ok(!pkg.dependencies?.['@patwoodman/orchestrator-cli'], 'meta-bundle must not pull the CLI');
  // The folded member trees travel inside the meta package…
  for (const short of ['guard', 'core', 'tools', 'presets', 'ui', 'cli']) {
    assert.ok(existsSync(join(dir, 'lib', 'rows', short, 'lib')), `meta-bundle folds ${short} under lib/rows/${short}/lib`);
  }
  // …resolvable through the flat aliases the folded patch rows use.
  for (const alias of ['./core', './services', './selftest', './tools', './tools-plugin', './presets', './presets-plugin', './ui']) {
    assert.ok(pkg.exports?.[alias], `meta-bundle exports ${alias} for the folded rows`);
  }
  // …and the generated patch references NO member package as a row name.
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  const nameLines = patch.split('\n').filter((line) => /name:/.test(line));
  for (const line of nameLines) {
    assert.ok(!/@patwoodman\/orchestrator-(core|tools|presets|ui|guard|cli)/.test(line), `folded patch row name must not name a member: ${line.trim()}`);
  }
});

test('publish: worker profile never composes the meta-bundle (E6)', () => {
  const worker = JSON.parse(readFileSync(join(ROOT, 'profiles', 'sdlc-worker', 'profile.json'), 'utf8'));
  assert.ok(!worker.bundles.includes('@patwoodman/orchestrator'), 'worker must not install the meta-bundle (it pulls core)');
  const web = JSON.parse(readFileSync(join(ROOT, 'profiles', 'sdlc-web', 'profile.json'), 'utf8'));
  assert.deepEqual(web.bundles, ['@patwoodman/orchestrator'], 'lead installs exactly one spec');
});
