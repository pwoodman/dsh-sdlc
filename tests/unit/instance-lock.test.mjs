/**
 * tests/unit/instance-lock.test.mjs — OS-level single-writer lock (spec v3 B.2.4, T5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const il = await core.instanceLock();

function lockPath(dir) {
  return join(dir, 'sdlc.lock');
}

test('first acquire wins; a second live acquire raises INSTANCE_LOCKED naming the holder', () => {
  const dir = tempDir('sdlc-lock-');
  try {
    const a = new il.InstanceLock(lockPath(dir), { pid: 111, isAlive: () => true, host: 'h1' });
    assert.equal(a.acquire().acquired, true);
    const b = new il.InstanceLock(lockPath(dir), { pid: 222, isAlive: () => true, host: 'h1' });
    assert.throws(() => b.acquire(), (err) => {
      assert.equal(err.code, 'INSTANCE_LOCKED');
      assert.equal(err.holder.pid, 111);
      return true;
    });
  } finally { cleanup(dir); }
});

test('a dead pid is reclaimed as a takeover and reported to the caller', () => {
  const dir = tempDir('sdlc-lock-');
  try {
    const a = new il.InstanceLock(lockPath(dir), { pid: 111, isAlive: () => true, host: 'h1' });
    a.acquire();
    const takeovers = [];
    const b = new il.InstanceLock(lockPath(dir), { pid: 222, isAlive: () => false, host: 'h1', onTakeover: (h, p) => takeovers.push({ h, p }) });
    const result = b.acquire();
    assert.equal(result.acquired, true);
    assert.equal(result.tookOver, true);
    assert.equal(result.holder.pid, 111);
    assert.equal(takeovers.length, 1);
  } finally { cleanup(dir); }
});

test('a heartbeat older than the stale window is reclaimable', () => {
  const dir = tempDir('sdlc-lock-');
  try {
    const now = () => 1_000_000;
    const a = new il.InstanceLock(lockPath(dir), { pid: 111, isAlive: () => true, host: 'h1', now });
    a.acquire();
    // Rewrite the heartbeat far into the past.
    const stale = { pid: 111, host: 'h1', bootId: 'old', startedAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() };
    writeFileSync(lockPath(dir), JSON.stringify(stale));
    assert.equal(il.isStale(stale, { now: 1_000_000, host: 'h1', isAlive: () => true, staleAfterMs: 30000 }), true);
    const b = new il.InstanceLock(lockPath(dir), { pid: 222, isAlive: () => true, host: 'h1', now });
    assert.equal(b.acquire().tookOver, true);
  } finally { cleanup(dir); }
});

test('a lock on another host is only reclaimed once stale', () => {
  const fresh = { pid: 1, host: 'other', bootId: 'x', heartbeatAt: new Date().toISOString() };
  assert.equal(il.isStale(fresh, { now: Date.now(), host: 'h1', isAlive: () => true }), false);
  const old = { pid: 1, host: 'other', bootId: 'x', heartbeatAt: new Date(Date.now() - 60_000).toISOString() };
  assert.equal(il.isStale(old, { now: Date.now(), host: 'h1', isAlive: () => true }), true);
});

test('heartbeat updates the file; a foreign takeover stops our heartbeat writing', () => {
  const dir = tempDir('sdlc-lock-');
  try {
    const a = new il.InstanceLock(lockPath(dir), { pid: 111, isAlive: () => true, host: 'h1' });
    a.acquire();
    assert.equal(a.heartbeat(), true);
    // Simulate another process taking over.
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 999, host: 'h1', bootId: 'other', heartbeatAt: new Date().toISOString() }));
    assert.equal(a.heartbeat(), false, 'we must stop writing once superseded');
    assert.equal(a.held, false);
  } finally { cleanup(dir); }
});

test('release removes the lock; releasing a superseded lock is a no-op', () => {
  const dir = tempDir('sdlc-lock-');
  try {
    const a = new il.InstanceLock(lockPath(dir), { pid: 111, isAlive: () => true, host: 'h1' });
    a.acquire();
    assert.equal(a.release(), true);
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(a.release(), false);

    const b = new il.InstanceLock(lockPath(dir), { pid: 222, isAlive: () => true, host: 'h1' });
    b.acquire();
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 333, host: 'h1', bootId: 'other', heartbeatAt: new Date().toISOString() }));
    assert.equal(b.release(), false, 'never delete someone else\'s lock');
    assert.equal(existsSync(lockPath(dir)), true);
  } finally { cleanup(dir); }
});

test('NEGATIVE CONTROL: without the lock file, acquisition always succeeds', () => {
  const dir = tempDir('sdlc-lock-');
  try {
    for (let i = 0; i < 3; i += 1) {
      const l = new il.InstanceLock(lockPath(dir), { pid: 100 + i, isAlive: () => true, host: 'h1' });
      if (i === 0) assert.equal(l.acquire().acquired, true);
      else assert.throws(() => l.acquire(), /INSTANCE_LOCKED/);
    }
  } finally { cleanup(dir); }
});
