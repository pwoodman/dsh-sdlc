/**
 * tests/unit/update-safety.test.mjs — the auto-updater must fail safe.
 *
 * Three live hazards are pinned here:
 *   - a failed install must NOT write the 24 h interval marker (it used to be
 *     written before `installBundle`, so one transient pnpm failure disabled
 *     updates for a day);
 *   - "installed" means the version on disk was verified, not just that the
 *     plugin manager returned;
 *   - a major version is a product decision, not a background side effect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkForUpdate } from '../../packages/sdlc-orchestrator/src/update.js';
import { updateDecision } from '../../packages/sdlc-orchestrator/src/install-lib.mjs';

function tempCache(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-update-safety-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'cache.json');
}

function packument(version) {
  return { ok: true, json: async () => ({ 'dist-tags': { beta: version, latest: version } }) };
}

function manager(result = { changed: true, application: 'restart-required', version: '0.4.0-beta.23' }) {
  const calls = [];
  return {
    calls,
    async installBundle(spec, options) {
      calls.push({ spec, options });
      return result;
    },
  };
}

test('a failed install is retried on the next boot, not cached for 24 hours', async (t) => {
  const cachePath = tempCache(t);
  let fetches = 0;
  const failing = {
    async installBundle() {
      throw new Error('pnpm exploded');
    },
  };
  const first = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    channel: 'beta',
    manager: failing,
    cachePath,
    now: 1_000,
    intervalMs: 86_400_000,
    fetchImpl: async () => { fetches += 1; return packument('0.4.0-beta.23'); },
  });
  assert.equal(first.status, 'error');
  assert.ok(existsSync(cachePath), 'the failure is recorded for a short backoff');
  const failed = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(failed.checkedAt ?? null, null, 'a failed install must not write the 24h success marker');
  assert.equal(failed.failedVersion, '0.4.0-beta.23');

  const working = manager();
  const second = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    channel: 'beta',
    manager: working,
    cachePath,
    now: 1_000 + 60 * 60 * 1000 + 1,
    intervalMs: 86_400_000,
    fetchImpl: async () => { fetches += 1; return packument('0.4.0-beta.23'); },
  });
  assert.equal(second.status, 'installed');
  assert.equal(fetches, 2, 'the retry reached the registry');
  assert.equal(working.calls.length, 1);
  assert.equal(existsSync(cachePath), true, 'a successful install records the interval');
});

test('an install that cannot be verified is not reported as installed', async (t) => {
  const cachePath = tempCache(t);
  const result = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    channel: 'beta',
    manager: manager({ changed: true, application: 'restart-required' }),
    verifyInstalled: () => null,
    cachePath,
    now: 1_000,
    intervalMs: 1_000,
    fetchImpl: async () => packument('0.4.0-beta.23'),
  });
  assert.equal(result.status, 'unverified');
  assert.equal(result.restartRequired, true);
  assert.equal(existsSync(cachePath), false);
});

test('an install that leaves the old version on disk is an error', async (t) => {
  const cachePath = tempCache(t);
  const result = await checkForUpdate({
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    channel: 'beta',
    manager: manager({ changed: true, application: 'restart-required' }),
    verifyInstalled: () => '0.4.0-beta.20',
    cachePath,
    now: 1_000,
    intervalMs: 1_000,
    fetchImpl: async () => packument('0.4.0-beta.23'),
  });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'installed-version-mismatch');
  assert.match(result.error, /expected 0\.4\.0-beta\.23, found 0\.4\.0-beta\.20/);
});

test('a major release is not installed in the background', async (t) => {
  const cachePath = tempCache(t);
  const mgr = manager({ changed: true, version: '1.0.0' });
  const result = await checkForUpdate({
    currentVersion: '0.4.0',
    source: '0.4.0',
    channel: 'latest',
    manager: mgr,
    cachePath,
    now: 1_000,
    intervalMs: 1_000,
    fetchImpl: async () => packument('1.0.0'),
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'major-update-requires-consent');
  assert.equal(mgr.calls.length, 0, 'the manager was never asked to install a major');
  assert.equal(updateDecision({ currentVersion: '0.4.0', latestVersion: '1.0.0', source: '0.4.0' }).action, 'skip');
  assert.equal(updateDecision({ currentVersion: '0.4.0', latestVersion: '0.5.0', source: '0.4.0' }).action, 'update');
  assert.equal(updateDecision({ currentVersion: '0.4.0', latestVersion: '1.0.0', source: '0.4.0', allowMajor: true }).action, 'update');
});

test('two concurrent checks share one registry lookup and one install', async (t) => {
  const cachePath = tempCache(t);
  let installs = 0;
  let fetches = 0;
  const mgr = {
    async installBundle() {
      installs += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { changed: true, application: 'restart-required', version: '0.4.0-beta.23' };
    },
  };
  const options = {
    currentVersion: '0.4.0-beta.20',
    source: '0.4.0-beta.20',
    channel: 'beta',
    manager: mgr,
    cachePath,
    now: 1_000,
    intervalMs: 1_000,
    fetchImpl: async () => { fetches += 1; return packument('0.4.0-beta.23'); },
  };
  const [a, b] = await Promise.all([checkForUpdate(options), checkForUpdate(options)]);
  assert.equal(a.status, 'installed');
  assert.equal(b.status, 'installed');
  assert.equal(installs, 1, 'one install, not two');
  assert.equal(fetches, 1, 'one registry lookup');
});
