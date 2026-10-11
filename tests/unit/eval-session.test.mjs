/**
 * tests/unit/eval-session.test.mjs — locating a run's session log.
 *
 * The pilot found that a live run's identity was recorded as "the model we
 * intended" rather than "the model that ran", because discovery looked only for
 * `session.jsonl.zstd` while DSH 0.2.0-rc.2 writes `session.v4.jsonl.zstd`. The
 * versioned name, the plain name, the `cwd` confirmation and the malformed-log
 * case are all pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { readSessionInfo, findSessionLogs, findSessionForRun } from '../../eval/lib/session.mjs';

/** Write a session log made of one zstd frame per event, like DSH does. */
function writeLog(dir, name, events) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const frames = events.map((e) => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')));
  writeFileSync(path, Buffer.concat(frames));
  return path;
}

/** A DSH-shaped sessions tree: <home>/sessions/<project>/<session>/<log>. */
function makeHome({ cwd, model = 'test-model', provider = 'devpass', name = 'session.v4.jsonl.zstd', events = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'eval-session-'));
  const sessionDir = join(home, 'sessions', '--encoded-project--', `session-abc-${Math.random().toString(16).slice(2)}`);
  writeLog(sessionDir, name, events ?? [
    { type: 'session', version: 4, id: 'session-abc', createdAt: 1700000000000, cwd },
    { type: 'request/header', data: { header: { config: { provider, model } } } },
  ]);
  return home;
}

test('readSessionInfo reads the id, cwd and the model that actually ran', () => {
  const home = makeHome({ cwd: '/work/x' });
  try {
    const [log] = findSessionLogs({ home });
    const info = readSessionInfo(log.path);
    assert.equal(info.id, 'session-abc');
    assert.equal(info.cwd, '/work/x');
    assert.equal(info.provider, 'devpass');
    assert.equal(info.model, 'test-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discovery matches the VERSIONED session log name DSH actually writes', () => {
  const home = makeHome({ cwd: '/work/x', name: 'session.v4.jsonl.zstd' });
  try {
    const logs = findSessionLogs({ home });
    assert.equal(logs.length, 1);
    assert.match(logs[0].path, /session\.v4\.jsonl\.zstd$/);
    assert.equal(readSessionInfo(logs[0].path).model, 'test-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discovery also matches an unversioned plain session log', () => {
  const home = makeHome({ cwd: '/work/x', name: 'session.jsonl' });
  try {
    const logs = findSessionLogs({ home });
    assert.equal(logs.length, 1);
    assert.match(logs[0].path, /session\.jsonl$/);
    assert.equal(readSessionInfo(logs[0].path).model, 'test-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('findSessionForRun confirms the cwd and refuses a foreign run', () => {
  const home = makeHome({ cwd: '/work/mine' });
  try {
    const mine = findSessionForRun({ home, cwd: '/work/mine', sinceMs: 0 });
    assert.ok(mine, 'the run in the requested cwd is found');
    assert.equal(mine.info.cwd, '/work/mine');
    // A workspace whose session is not present must not adopt someone else's.
    assert.equal(findSessionForRun({ home, cwd: '/work/someone-else', sinceMs: 0 }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a session log older than the run is not adopted', () => {
  const home = makeHome({ cwd: '/work/mine' });
  try {
    const future = Date.now() + 60_000;
    assert.equal(findSessionForRun({ home, cwd: '/work/mine', sinceMs: future }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a log with no request/header yields a null model, never a guess', () => {
  const home = makeHome({ cwd: '/work/x', events: [{ type: 'session', version: 4, id: 'session-abc', cwd: '/work/x' }] });
  try {
    const [log] = findSessionLogs({ home });
    const info = readSessionInfo(log.path);
    assert.equal(info.id, 'session-abc');
    assert.equal(info.model, null);
    assert.equal(info.provider, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
