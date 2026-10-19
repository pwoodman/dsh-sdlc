/**
 * tests/unit/install-lib.test.mjs — pnpm `minimumReleaseAgeExclude` repair.
 *
 * The Desktop profile carried
 *   - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.19 || 0.4.0-beta.20'
 * pnpm treats that as one invalid pattern and ignores it, so a fresh beta
 * resolved to the previous one. The installer must split it, keep the package
 * name on a bare version, and stay idempotent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReleaseAgeExcludes,
  compareVersions,
  channelForVersion,
  isRegistrySource,
  shouldCheckForUpdate,
  updateDecision,
  isSuitePackage,
  pruneSuiteDependencies,
  syncSuiteBundles,
} from '../../packages/sdlc-orchestrator/src/install-lib.mjs';

const SPEC = '@patwoodman/dsh-sdlc-flow@0.4.0-beta.21';

test('splits a malformed pkg@old || pkg@new entry into valid list items', () => {
  const input = `packages:\n  - .\nminimumReleaseAgeExclude:\n  - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.19 || @patwoodman/dsh-sdlc-flow@0.4.0-beta.20'\n`;
  const out = normalizeReleaseAgeExcludes(input, [SPEC]);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.19'$/m);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.20'$/m);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.21'$/m);
  assert.doesNotMatch(out, /\|\|/, 'no invalid OR pattern survives');
});

test('carries the package name onto a bare version after ||', () => {
  const input = `minimumReleaseAgeExclude:\n  - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.19 || 0.4.0-beta.20'\n`;
  const out = normalizeReleaseAgeExcludes(input, []);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.19'$/m);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.20'$/m);
});

test('preserves every unrelated setting in pnpm-workspace.yaml', () => {
  const input = `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\nminimumReleaseAgeExclude:\n  - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.20'\n`;
  const out = normalizeReleaseAgeExcludes(input, [SPEC]);
  assert.match(out, /^packages:$/m);
  assert.match(out, /^  - \.$/m);
  assert.match(out, /^nodeLinker: hoisted$/m);
  assert.match(out, /^autoInstallPeers: false$/m);
  assert.match(out, /^minimumReleaseAgeExclude:$/m);
});

test('adds the block when the profile has none', () => {
  const out = normalizeReleaseAgeExcludes('packages:\n  - .\n', [SPEC]);
  assert.equal(out, `packages:\n  - .\n\nminimumReleaseAgeExclude:\n  - '${SPEC}'\n`);
});

test('is idempotent, deduplicating and sorting entries', () => {
  const input = `minimumReleaseAgeExclude:\n  - 'z@2.0.0'\n  - 'a@1.0.0'\n`;
  const once = normalizeReleaseAgeExcludes(input, [SPEC, 'a@1.0.0']);
  const twice = normalizeReleaseAgeExcludes(once, [SPEC]);
  assert.equal(twice, once);
  const entries = [...once.matchAll(/^  - '(.+)'$/gm)].map((m) => m[1]);
  assert.deepEqual(entries, [...entries].sort());
  assert.equal(entries.filter((e) => e === 'a@1.0.0').length, 1);
  assert.ok(entries.includes(SPEC));
});

test('an existing non-empty block is rewritten in place, not appended twice', () => {
  const input = `minimumReleaseAgeExclude:\n  - 'old@1.0.0'\n\nnodeLinker: hoisted\n`;
  const out = normalizeReleaseAgeExcludes(input, [SPEC]);
  assert.equal((out.match(/minimumReleaseAgeExclude:/g) ?? []).length, 1);
  assert.match(out, /^nodeLinker: hoisted$/m);
  assert.match(out, /^  - 'old@1\.0\.0'$/m, 'unrelated exemptions are preserved');
  assert.match(out, new RegExp(`^  - '${SPEC.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'$`, 'm'));
});

test('an empty inline list gains exactly one key, not a duplicate', () => {
  const out = normalizeReleaseAgeExcludes('minimumReleaseAgeExclude: []\n', [SPEC]);
  assert.equal((out.match(/^minimumReleaseAgeExclude:/gm) ?? []).length, 1, out);
  assert.match(out, new RegExp(`^  - '${SPEC.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'$`, 'm'));
});

test('a flow-style list is read, merged and rewritten as a block', () => {
  const input = "minimumReleaseAgeExclude: ['a@1.0.0', 'b@2.0.0']\n";
  const out = normalizeReleaseAgeExcludes(input, [SPEC]);
  assert.equal((out.match(/^minimumReleaseAgeExclude:/gm) ?? []).length, 1);
  for (const entry of ['a@1.0.0', 'b@2.0.0', SPEC]) {
    assert.match(out, new RegExp(`^  - '${entry.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'$`, 'm'), out);
  }
});

test('a duplicate key written by an older installer is collapsed', () => {
  const input = "minimumReleaseAgeExclude: []\n\nminimumReleaseAgeExclude:\n  - 'old@1.0.0'\n";
  const out = normalizeReleaseAgeExcludes(input, [SPEC]);
  assert.equal((out.match(/^minimumReleaseAgeExclude:/gm) ?? []).length, 1, out);
  assert.match(out, /^  - 'old@1\.0\.0'$/m);
  assert.match(out, new RegExp(`^  - '${SPEC.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'$`, 'm'));
});

test('semver comparison orders prereleases numerically', () => {
  assert.equal(compareVersions('0.4.0-beta.23', '0.4.0-beta.20'), 1);
  assert.equal(compareVersions('0.4.0-beta.2', '0.4.0-beta.10'), -1);
  assert.equal(compareVersions('0.4.0', '0.4.0-beta.23'), 1);
  assert.equal(compareVersions('0.4.0-beta.23', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.1', '0.4.0'), 1);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('0.4.0-alpha', '0.4.0-beta'), -1);
  assert.throws(() => compareVersions('nope', '0.4.0'), /not a semver version/);
});

test('a prerelease build follows the beta channel; a stable build follows latest', () => {
  assert.equal(channelForVersion('0.4.0-beta.23'), 'beta');
  assert.equal(channelForVersion('0.4.0'), 'latest');
  assert.equal(channelForVersion('not-a-version'), 'latest');
});

test('auto-update only replaces registry installs, never links or paths', () => {
  for (const source of ['0.4.0-beta.20', '^0.4.0', 'latest', 'beta', 'npm:@patwoodman/dsh-sdlc-flow@0.4.0']) {
    assert.equal(isRegistrySource(source), true, source);
  }
  for (const source of ['link:/tmp/plugin', 'file:./plugin', 'workspace:*', 'git+https://github.com/x/y.git', 'https://example.com/p.tgz', '../plugin', '/tmp/plugin', '~/.dsh/plugin']) {
    assert.equal(isRegistrySource(source), false, source);
  }
  assert.equal(isRegistrySource(undefined), false);
});

test('updateDecision updates only when the registry version is newer', () => {
  assert.deepEqual(
    updateDecision({ currentVersion: '0.4.0-beta.20', latestVersion: '0.4.0-beta.23', source: '0.4.0-beta.20' }),
    { action: 'update', version: '0.4.0-beta.23' },
  );
  assert.deepEqual(
    updateDecision({ currentVersion: '0.4.0-beta.23', latestVersion: '0.4.0-beta.23', source: '0.4.0-beta.23' }),
    { action: 'up-to-date' },
  );
  assert.deepEqual(
    updateDecision({ currentVersion: '0.4.0-beta.23', latestVersion: '0.4.0-beta.20', source: '0.4.0-beta.23' }),
    { action: 'up-to-date' },
  );
  assert.equal(
    updateDecision({ currentVersion: '0.4.0-beta.20', latestVersion: '0.4.0-beta.23', source: 'link:/tmp/x' }).action,
    'skip',
  );
  assert.equal(
    updateDecision({ currentVersion: '0.4.0-beta.20', latestVersion: null, source: '0.4.0-beta.20' }).action,
    'skip',
  );
});

test('the update interval tolerates a missing or skewed clock', () => {
  assert.equal(shouldCheckForUpdate(undefined, 1000, 100), true);
  assert.equal(shouldCheckForUpdate(0, 1000, 100), true);
  assert.equal(shouldCheckForUpdate(950, 1000, 100), false);
  assert.equal(shouldCheckForUpdate(900, 1000, 100), true);
  assert.equal(shouldCheckForUpdate(2000, 1000, 100), true, 'a backwards clock forces a check');
});

test('legacy member and pre-rename packages are recognised and pruned', () => {
  const meta = '@patwoodman/dsh-sdlc-flow';
  const members = [
    '@patwoodman/dsh-sdlc-flow-core',
    '@patwoodman/dsh-sdlc-flow-tools',
    '@patwoodman/dsh-sdlc-flow-presets',
    '@patwoodman/dsh-sdlc-flow-ui',
  ];
  assert.equal(isSuitePackage(meta, meta, members), true);
  assert.equal(isSuitePackage('@patwoodman/dsh-sdlc-flow-core', meta, members), true);
  assert.equal(isSuitePackage('@patwoodman/orchestrator-core', meta, members), true);
  assert.equal(isSuitePackage('@other/dsh-sdlc-flow-core', meta, members), true);
  assert.equal(isSuitePackage('@patwoodman/some-other-plugin', meta, members), false);

  const { dependencies, removed } = pruneSuiteDependencies(
    {
      [meta]: '0.4.0-beta.20',
      '@patwoodman/dsh-sdlc-flow-core': '0.4.0-beta.20',
      '@patwoodman/orchestrator': '0.3.0',
      '@patwoodman/some-other-plugin': '1.0.0',
    },
    { metaName: meta, memberNames: members, keep: [meta] },
  );
  assert.deepEqual(removed.sort(), ['@patwoodman/dsh-sdlc-flow-core', '@patwoodman/orchestrator'].sort());
  assert.deepEqual(dependencies, {
    [meta]: '0.4.0-beta.20',
    '@patwoodman/some-other-plugin': '1.0.0',
  });
});

test('bundle sync keeps shipped bundles and replaces the suite selection', () => {
  const meta = '@patwoodman/dsh-sdlc-flow';
  const members = ['@patwoodman/dsh-sdlc-flow-core', '@patwoodman/dsh-sdlc-flow-tools'];
  const result = syncSuiteBundles(
    ['@deepseek-ai/dsh-base', '@patwoodman/orchestrator', '@patwoodman/dsh-sdlc-flow-core', meta],
    [meta],
    { metaName: meta, memberNames: members },
  );
  assert.deepEqual(result.bundles, ['@deepseek-ai/dsh-base', meta]);
  assert.deepEqual(result.removed.sort(), ['@patwoodman/dsh-sdlc-flow-core', '@patwoodman/orchestrator'].sort());

  const empty = syncSuiteBundles(['@deepseek-ai/dsh-base', meta], [], { metaName: meta, memberNames: members });
  assert.deepEqual(empty.bundles, ['@deepseek-ai/dsh-base']);
  assert.deepEqual(empty.removed, [meta]);
});
