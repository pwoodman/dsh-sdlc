/**
 * tests/unit/install-lib-atomic.test.mjs — profile writes and the cross-process
 * install lock.
 *
 * A manual install and the background auto-updater can race; a torn
 * `package.json` or a lost `minimumReleaseAgeExclude` entry then breaks the
 * next boot. Writes go through temp+fsync+rename, and one installer holds a
 * pid-stamped lock at a time (stale/dead holders are reclaimed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, cleanup } from '../lib/helpers.mjs';
import {
  writeFileAtomic,
  acquireInstallLock,
  resolveDshSpawn,
} from '../../packages/sdlc-orchestrator/src/install-lib.mjs';

test('writeFileAtomic replaces a JSON file without leaving a temp file', () => {
  const dir = tempDir('sdlc-atomic-');
  try {
    const path = join(dir, 'package.json');
    writeFileAtomic(path, '{"a":1}\n');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { a: 1 });
    writeFileAtomic(path, `${JSON.stringify({ big: 'x'.repeat(200_000) })}\n`);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).big.length, 200_000);
    assert.deepEqual(readdirSync(dir), ['package.json']);
  } finally { cleanup(dir); }
});

test('the install lock admits one holder and releases cleanly', () => {
  const dir = tempDir('sdlc-lock-');
  try {
    const lock = join(dir, '.sdlc-install.lock');
    const release = acquireInstallLock(lock, { now: () => 1_000, isAlive: () => true });
    assert.ok(existsSync(lock));
    assert.throws(() => acquireInstallLock(lock, { now: () => 1_000, isAlive: () => true }), (error) => {
      assert.equal(error.code, 'INSTALL_LOCKED');
      assert.match(error.message, /another installer/);
      return true;
    });
    release();
    assert.equal(existsSync(lock), false);
    const release2 = acquireInstallLock(lock, { now: () => 1_000, isAlive: () => true });
    release2();
  } finally { cleanup(dir); }
});

test('a stale or dead-pid lock is reclaimed; a malformed lock is reclaimed', () => {
  const dir = tempDir('sdlc-lock-stale-');
  try {
    const lock = join(dir, '.sdlc-install.lock');
    writeFileSync(lock, JSON.stringify({ pid: 999_999, host: 'x', startedAt: 0, token: 'old' }));
    const release = acquireInstallLock(lock, { now: () => 10 * 60 * 1000 + 1, isAlive: () => false });
    release();

    writeFileSync(lock, 'not json');
    const release2 = acquireInstallLock(lock, { now: () => 1, isAlive: () => true });
    release2();

    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'x', startedAt: 1, token: 'live' }));
    assert.throws(
      () => acquireInstallLock(lock, { now: () => 2, staleMs: 10_000, isAlive: () => true }),
      /INSTALL_LOCKED/,
    );
  } finally { cleanup(dir); }
});

test('release never deletes another process\'s lock', () => {
  const dir = tempDir('sdlc-lock-owner-');
  try {
    const lock = join(dir, '.sdlc-install.lock');
    const release = acquireInstallLock(lock, { now: () => 1, isAlive: () => true });
    // Simulate a replacement owner between acquire and release.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'x', startedAt: 2, token: 'other' }));
    release();
    assert.ok(existsSync(lock), 'the replacement lock survives');
  } finally { cleanup(dir); }
});

test('dsh spawn resolves .cmd through cmd.exe on Windows and direct on POSIX', () => {
  const win = resolveDshSpawn(['--version'], { platform: 'win32', comspec: 'C:\\Windows\\cmd.exe' });
  assert.equal(win.command, 'C:\\Windows\\cmd.exe');
  assert.deepEqual(win.args, ['/d', '/s', '/c', 'dsh.cmd', '--version']);
  const posix = resolveDshSpawn(['--version'], { platform: 'linux' });
  assert.equal(posix.command, 'dsh');
  assert.deepEqual(posix.args, ['--version']);
});
