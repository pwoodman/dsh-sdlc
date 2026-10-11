/**
 * packages/sdlc-core/src/instance-lock.js — OS-level single-writer lock (spec v3 B.2.4).
 *
 * The single-writer invariant (C.5) is enforced by the OS, not by convention:
 * two orchestrator processes must never share one `.sdlc/`. This is what makes
 * `sdlc-web` + `sdlc-probe` + a stray worker safe to run concurrently against
 * one project.
 *
 *   1. create `.sdlc/sdlc.lock` with O_CREAT|O_EXCL, writing {pid, host, bootId, startedAt}
 *   2. if it exists: same host + live pid ⇒ refuse (INSTANCE_LOCKED);
 *      dead pid or different host ⇒ take over, recording it in `events`
 *   3. a 5 s heartbeat; a lock older than 30 s is stale and reclaimable
 *   4. release on clean exit; a hard kill leaves a stale lock that (2) reclaims
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export const HEARTBEAT_INTERVAL_MS = 5000;
export const STALE_AFTER_MS = 30000;

export function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export function lockAgeMs(lock, now = Date.now()) {
  const stamp = Date.parse(lock?.heartbeatAt ?? lock?.startedAt ?? '');
  return Number.isNaN(stamp) ? Number.POSITIVE_INFINITY : now - stamp;
}

export function isStale(lock, { now = Date.now(), host = hostname(), isAlive = defaultIsAlive, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!lock) return true;
  if (lock.host !== host) return lockAgeMs(lock, now) > staleAfterMs;
  if (!isAlive(lock.pid)) return true;
  return lockAgeMs(lock, now) > staleAfterMs;
}

export class InstanceLockedError extends Error {
  constructor(holder) {
    super(`INSTANCE_LOCKED: .sdlc/ is held by pid ${holder?.pid} on ${holder?.host} (started ${holder?.startedAt})`);
    this.name = 'InstanceLockedError';
    this.code = 'INSTANCE_LOCKED';
    this.holder = holder;
  }
}

export class InstanceLock {
  constructor(lockPath, {
    host = hostname(),
    pid = process.pid,
    now = () => Date.now(),
    isAlive = defaultIsAlive,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    staleAfterMs = STALE_AFTER_MS,
    bootId = randomUUID(),
    onTakeover = null,
    timer = null,
  } = {}) {
    this.path = lockPath;
    this.host = host;
    this.pid = pid;
    this.now = now;
    this.isAlive = isAlive;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.staleAfterMs = staleAfterMs;
    this.bootId = bootId;
    this.onTakeover = onTakeover;
    this.timer = timer;
    this.held = false;
  }

  _payload(now = this.now()) {
    return {
      pid: this.pid,
      host: this.host,
      bootId: this.bootId,
      startedAt: new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
    };
  }

  /**
   * @returns {{acquired:true, tookOver:boolean, holder:object|null}}
   * @throws {InstanceLockedError} when a live holder owns the lock
   */
  acquire() {
    const payload = this._payload();
    try {
      const fd = openSync(this.path, 'wx');
      writeFileSync(fd, JSON.stringify(payload, null, 2) + '\n');
      closeSync(fd);
      this.held = true;
      return { acquired: true, tookOver: false, holder: null };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const holder = readLock(this.path);
    const stale = isStale(holder, {
      now: this.now(),
      host: this.host,
      isAlive: this.isAlive,
      staleAfterMs: this.staleAfterMs,
    });

    if (!stale) throw new InstanceLockedError(holder);

    // Dead pid or different host: take over, recording the takeover.
    writeFileSync(this.path, JSON.stringify(payload, null, 2) + '\n');
    this.held = true;
    if (this.onTakeover) this.onTakeover(holder, payload);
    return { acquired: true, tookOver: true, holder };
  }

  heartbeat() {
    if (!this.held) return false;
    const current = readLock(this.path);
    if (current && current.bootId !== this.bootId) {
      // Another process took over (our heartbeat was stale): stop writing.
      this.held = false;
      return false;
    }
    writeFileSync(this.path, JSON.stringify(this._payload(), null, 2) + '\n');
    return true;
  }

  /** Start a 5 s heartbeat. The DSH host's timer is injected for tests. */
  startHeartbeat(scheduler = { setInterval, clearInterval }) {
    if (this.timer) return this.timer;
    this.timer = scheduler.setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
    return this.timer;
  }

  release({ scheduler = { clearInterval } } = {}) {
    if (this.timer) {
      scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.held) return false;
    const current = readLock(this.path);
    if (current && current.bootId !== this.bootId) {
      this.held = false;
      return false;
    }
    try { unlinkSync(this.path); } catch { /* already gone */ }
    this.held = false;
    return true;
  }
}

/** Register SIGINT/SIGTERM release handlers (B.2.4 step 4). */
export function installExitHandlers(lock, target = process) {
  const release = () => { lock.release(); };
  target.once('SIGINT', () => { release(); target.exit?.(130); });
  target.once('SIGTERM', () => { release(); target.exit?.(143); });
  target.once('exit', release);
  return release;
}

export default { InstanceLock, InstanceLockedError, readLock, isStale, installExitHandlers };
