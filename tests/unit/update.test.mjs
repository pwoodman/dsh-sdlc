/**
 * tests/unit/update.test.mjs — the lead's self-update decision and side effects.
 *
 * The registry, clock, cache and plugin manager are injected, so this test
 * never touches the network or the real DSH home.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  checkForUpdate,
  findInstalledProfile,
  scheduleUpdateCheck,
  updateCachePath,
  updateMode,
} from '../../packages/sdlc-orchestrator/src/update.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-update-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function packument(version) {
  return { ok: true, json: async () => ({ 'dist-tags': { beta: version, latest: version } }) };
}

function managerStub(result = { changed: true, application: 'restart-required', version: '0.4.0-beta.23' }) {
  const calls = [];
  return {
    calls,
    async installBundle(spec, options) {
      calls.push({ spec, options });
      return result;
    },
  };
}

test('installs a newer beta and reports restart-required', async (t) => {
  const dir = tempDir(t);
  const manager = managerStub();
  const result = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    channel: 'beta',
    manager,
    cachePath: join(dir, 'cache.json'),
    now: 10_000,
    intervalMs: 1_000,
    fetchImpl: async () => packument('0.4.0-beta.23'),
  });
  assert.equal(result.status, 'installed');
  assert.equal(result.version, '0.4.0-beta.23');
  assert.equal(result.restartRequired, true);
  assert.deepEqual(manager.calls, [
    { spec: '@patwoodman/dsh-sdlc-flow@0.4.0-beta.23', options: { saveExact: true } },
  ]);
  const cache = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8'));
  assert.equal(cache.latest, '0.4.0-beta.23');
  assert.equal(cache.checkedAt, 10_000);
});

test('does nothing when the registry version is not newer', async (t) => {
  const dir = tempDir(t);
  const manager = managerStub();
  const result = await checkForUpdate({
    currentVersion: '0.4.0-beta.23',
    source: '0.4.0-beta.23',
    channel: 'beta',
    manager,
    cachePath: join(dir, 'cache.json'),
    now: 10_000,
    intervalMs: 1_000,
    fetchImpl: async () => packument('0.4.0-beta.23'),
  });
  assert.equal(result.status, 'up-to-date');
  assert.equal(manager.calls.length, 0);
});

test('honours the check interval without asking the registry again', async (t) => {
  const dir = tempDir(t);
  const cachePath = join(dir, 'cache.json');
  writeFileSync(cachePath, JSON.stringify({ checkedAt: 10_000, latest: '0.4.0-beta.23' }));
  let fetched = 0;
  const result = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    manager: managerStub(),
    cachePath,
    now: 10_500,
    intervalMs: 1_000,
    fetchImpl: async () => { fetched += 1; return packument('0.4.0-beta.23'); },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'interval');
  assert.equal(fetched, 0);
});

test('never replaces a link, file, git or path install', async (t) => {
  const dir = tempDir(t);
  let fetched = 0;
  for (const source of ['link:/tmp/plugin', 'file:./plugin', 'git+https://github.com/x/y.git', '../plugin']) {
    const result = await checkForUpdate({
      currentVersion: '0.4.0-beta.20',
      source,
      manager: managerStub(),
      cachePath: join(dir, 'cache.json'),
      now: 10_000,
      intervalMs: 1_000,
      fetchImpl: async () => { fetched += 1; return packument('0.4.0-beta.23'); },
    });
    assert.equal(result.status, 'skipped', source);
    assert.equal(result.reason, 'non-registry-install', source);
  }
  assert.equal(fetched, 0);
});

test('check mode reports availability without installing', async (t) => {
  const dir = tempDir(t);
  const manager = managerStub();
  const result = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    channel: 'beta',
    manager,
    cachePath: join(dir, 'cache.json'),
    now: 10_000,
    intervalMs: 1_000,
    mode: 'check',
    fetchImpl: async () => packument('0.4.0-beta.23'),
  });
  assert.equal(result.status, 'available');
  assert.equal(result.latest, '0.4.0-beta.23');
  assert.equal(manager.calls.length, 0);
});

test('registry and install failures are reported, never thrown', async (t) => {
  const dir = tempDir(t);
  const registryFailure = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    manager: managerStub(),
    cachePath: join(dir, 'cache.json'),
    now: 10_000,
    intervalMs: 1_000,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(registryFailure.status, 'error');
  assert.match(registryFailure.error, /HTTP 503/);

  const installFailure = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    channel: 'beta',
    manager: { async installBundle() { throw new Error('pnpm exploded'); } },
    cachePath: join(dir, 'cache2.json'),
    now: 10_000,
    intervalMs: 1_000,
    fetchImpl: async () => packument('0.4.0-beta.23'),
  });
  assert.equal(installFailure.status, 'error');
  assert.match(installFailure.error, /pnpm exploded/);
});

test('scheduling is inert in plain contexts and when disabled', () => {
  assert.equal(scheduleUpdateCheck({ logger: { warn() {} } }, {}), null, 'no ctx.get → no timer');
  const ctx = { get() { return undefined; }, effect() {}, logger: { warn() {}, debug() {} } };
  assert.equal(scheduleUpdateCheck(ctx, { autoUpdate: 'off' }), null);
  assert.equal(scheduleUpdateCheck(ctx, { autoUpdate: false }), null);
});

test('the update cache lives under DSH_HOME and is keyed by profile', () => {
  assert.equal(updateCachePath({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/.sdlc-update.json');
  assert.equal(updateCachePath({ DSH_HOME: '/tmp/dsh-home' }, 'desktop'), '/tmp/dsh-home/.sdlc-update-desktop.json');
});

test('findInstalledProfile matches only the profile that loaded this package copy', (t) => {
  const home = tempDir(t);
  const installed = join(home, 'profiles', 'sdlc-web');
  mkdirSync(join(installed, 'node_modules', '@patwoodman', 'dsh-sdlc-flow'), { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({
    dependencies: { '@patwoodman/dsh-sdlc-flow': '0.4.0-beta.20' },
    dsh: { profile: { bundles: ['@patwoodman/dsh-sdlc-flow'] } },
  }));
  const ownManifest = join(installed, 'node_modules', '@patwoodman', 'dsh-sdlc-flow', 'package.json');
  writeFileSync(ownManifest, JSON.stringify({ name: '@patwoodman/dsh-sdlc-flow', version: '0.4.0-beta.20' }));

  const found = findInstalledProfile({ env: { DSH_HOME: home }, ownManifestPath: ownManifest });
  assert.equal(found.name, 'sdlc-web');
  assert.equal(found.source, '0.4.0-beta.20');

  const otherHome = tempDir(t);
  const otherManifest = join(otherHome, 'package.json');
  writeFileSync(otherManifest, JSON.stringify({ name: 'some-other-package', version: '1.0.0' }));
  assert.equal(findInstalledProfile({ env: { DSH_HOME: otherHome }, ownManifestPath: otherManifest }), null);
});


test('prerelease builds check by default; stable builds install; explicit values win', () => {
  assert.equal(updateMode({}, {}, '0.4.0-beta.23'), 'check');
  assert.equal(updateMode({}, {}, '0.4.0'), 'install');
  assert.equal(updateMode({ autoUpdate: 'install' }, {}, '0.4.0-beta.23'), 'install');
  assert.equal(updateMode({ autoUpdate: 'check' }, {}, '0.4.0'), 'check');
  assert.equal(updateMode({ autoUpdate: 'off' }, {}, '0.4.0'), 'off');
});
