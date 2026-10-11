/**
 * tests/fault/stale-lock.test.mjs — L5 fault matrix row: stale lock (spec v3 B.2.4, K.5, T5).
 *
 * A `.sdlc/sdlc.lock` left behind by a dead pid must be reclaimed on the next
 * acquire, and the takeover must be recorded in `events`. A live holder must
 * make the second acquire fail with INSTANCE_LOCKED / RuntimeLockedError naming
 * the holder pid — and that failure must be attributable to the lock alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tempDir, cleanup, core } from '../lib/helpers.mjs';

const { InstanceLock, InstanceLockedError, readLock, isStale } = await core.instanceLock();
const { TaskStateService } = await core.stateMachine();
const { Runtime, RuntimeLockedError } = await core.runtime();

const HOST = hostname();
const ISO = (ms) => new Date(ms).toISOString();

/** Write a lock document directly, as a crashed process would have left it. */
function writeLock(lockPath, over = {}) {
  const now = Date.now();
  writeFileSync(lockPath, JSON.stringify({
    pid: over.pid ?? 999999,
    host: over.host ?? HOST,
    bootId: over.bootId ?? 'boot-crashed',
    startedAt: over.startedAt ?? ISO(now - 60_000),
    heartbeatAt: over.heartbeatAt ?? ISO(now - 60_000),
  }, null, 2) + '\n');
}

test('a stale lock with a dead pid is reclaimed and the takeover is recorded in events', () => {
  const dir = tempDir('sdlc-stale-lock-');
  const db = new TaskStateService(':memory:');
  try {
    const lockPath = join(dir, 'sdlc.lock');
    writeLock(lockPath, { pid: 999999, bootId: 'dead-boot' });
    assert.equal(isStale(readLock(lockPath), { host: HOST, isAlive: () => false }), true);

    const lock = new InstanceLock(lockPath, {
      host: HOST,
      pid: process.pid,
      isAlive: () => false,
      onTakeover: (holder, payload) => {
        db.record({
          taskId: 'LOCK-1',
          actor: 'recovery',
          action: 'lock-takeover',
          payload: { previousPid: holder?.pid, previousBootId: holder?.bootId, newPid: payload.pid },
        });
      },
    });

    const res = lock.acquire();
    assert.equal(res.acquired, true);
    assert.equal(res.tookOver, true);
    assert.equal(res.holder.pid, 999999);

    // The new owner owns the file and can heartbeat.
    const onDisk = readLock(lockPath);
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.bootId, lock.bootId);
    assert.notEqual(onDisk.bootId, 'dead-boot');
    assert.equal(lock.heartbeat(), true);

    // The takeover is durable evidence in `events`, not a silent overwrite.
    const events = db.getEvents('LOCK-1');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'recovery');
    assert.equal(events[0].action, 'lock-takeover');
    const payload = JSON.parse(events[0].payload_json);
    assert.equal(payload.previousPid, 999999);
    assert.equal(payload.newPid, process.pid);

    assert.equal(lock.release(), true);
    assert.equal(readLock(lockPath), null);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('two live-lock acquires raise INSTANCE_LOCKED naming the holder pid (negative control)', () => {
  const dir = tempDir('sdlc-live-lock-');
  try {
    const lockPath = join(dir, 'sdlc.lock');
    const first = new InstanceLock(lockPath, { host: HOST, pid: process.pid, isAlive: () => true });
    assert.equal(first.acquire().acquired, true);

    const second = new InstanceLock(lockPath, { host: HOST, pid: process.pid + 1, isAlive: () => true });
    assert.throws(
      () => second.acquire(),
      (err) => {
        assert.ok(err instanceof InstanceLockedError, 'expected InstanceLockedError');
        assert.equal(err.code, 'INSTANCE_LOCKED');
        assert.equal(err.holder.pid, process.pid);
        assert.match(err.message, new RegExp(`pid ${process.pid}`));
        return true;
      },
    );

    // Negative control: the failure was the lock, not the path or the options.
    // Remove exactly the lock file and the same third acquire succeeds.
    unlinkSync(lockPath);
    const third = new InstanceLock(lockPath, { host: HOST, pid: process.pid + 2, isAlive: () => true });
    assert.equal(third.acquire().acquired, true);
  } finally {
    cleanup(dir);
  }
});

test('Runtime.open surfaces RuntimeLockedError naming the holder pid', () => {
  const dir = tempDir('sdlc-runtime-lock-');
  try {
    const sdlcDir = join(dir, '.sdlc');
    mkdirSync(sdlcDir, { recursive: true });
    // A lock held by THIS live process: same host, alive pid, fresh heartbeat.
    writeLock(join(sdlcDir, 'sdlc.lock'), {
      pid: process.pid,
      startedAt: ISO(Date.now()),
      heartbeatAt: ISO(Date.now()),
    });

    const rt = new Runtime({ projectRoot: dir, config: {} });
    assert.throws(
      () => rt.open(),
      (err) => {
        assert.ok(err instanceof RuntimeLockedError, 'expected RuntimeLockedError');
        assert.equal(err.code, 'INSTANCE_LOCKED');
        assert.equal(err.holder.pid, process.pid);
        assert.match(err.message, new RegExp(`pid ${process.pid}`));
        return true;
      },
    );
  } finally {
    cleanup(dir);
  }
});
