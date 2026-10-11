/**
 * tests/fault/db-conflict-and-integrity.test.mjs — L5 fault matrix rows: DB
 * write conflict and integrity gate (spec v3 B.2.3, K.5).
 *
 * Transitions are serialized through the write queue and each runs inside
 * BEGIN IMMEDIATE, so two racing transitions cannot lose an update: the second
 * sees the first's result. `PRAGMA quick_check` refuses to open a corrupt DB.
 *
 * The corrupt-DB case always uses a COPY in a temp dir; the workspace `.sdlc/`
 * is never touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, core } from '../lib/helpers.mjs';

const { TaskStateService } = await core.stateMachine();
const { openDatabase, quickCheck } = await core.schema();

test('two racing transitions through the serialized queue: exactly one applies, none are lost', async () => {
  const svc = new TaskStateService(':memory:');
  try {
    svc._setState('T1', 'FAILED', { attempt: 0, retry_budget: 2 });

    const [a, b] = await Promise.all([
      svc.enqueue(() => svc.transition('T1', 'READY', 'scheduler', { attempt: 0, retryBudget: 2 })),
      svc.enqueue(() => svc.transition('T1', 'READY', 'scheduler', { attempt: 0, retryBudget: 2 })),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    assert.equal(winners.length, 1, 'exactly one transition wins');
    assert.equal(losers.length, 1, 'the loser sees the winner result, it is not re-applied');
    assert.equal(losers[0].error, 'INVALID_TRANSITION');
    assert.match(losers[0].reason, /no transition READY→READY/);

    assert.equal(svc.getState('T1'), 'READY');
    assert.equal(svc.getTask('T1').attempt, 1, 'the attempt delta was applied exactly once');
    assert.equal(svc.getEvents('T1').length, 1, 'exactly one event row was written');
  } finally {
    svc.close();
  }
});

test('the write queue preserves every read-modify-write update (no lost update)', async () => {
  const svc = new TaskStateService(':memory:');
  try {
    svc._setState('C1', 'READY', { attempt: 0, retry_budget: 0 });
    const N = 25;
    const jobs = Array.from({ length: N }, () => svc.enqueue(() => svc._tx(() => {
      const cur = svc.getTask('C1').retry_budget;
      svc.db.prepare('UPDATE tasks SET retry_budget = ? WHERE id = ?').run(cur + 1, 'C1');
    })));
    await Promise.all(jobs);
    assert.equal(svc.getTask('C1').retry_budget, N, 'all increments survived serialization');
  } finally {
    svc.close();
  }
});

test('PRAGMA quick_check refuses to open a corrupt DB copy', () => {
  const dir = tempDir('sdlc-integrity-');
  try {
    const goodPath = join(dir, 'sdlc.db');
    const good = openDatabase(goodPath);
    assert.equal(quickCheck(good), 'ok');
    good.close();

    const corruptPath = join(dir, 'corrupt.db');
    copyFileSync(goodPath, corruptPath);
    // Overwrite the SQLite header region with garbage on the COPY only.
    const buf = readFileSync(corruptPath);
    for (let i = 0; i < Math.min(buf.length, 120); i += 1) buf[i] = 0xff;
    writeFileSync(corruptPath, buf);

    assert.throws(
      () => openDatabase(corruptPath),
      'openDatabase must refuse a corrupt DB rather than start a scheduler on torn state',
    );

    // The underlying gate: either the driver refuses to open it, or quickCheck
    // returns a non-ok value and throws.
    let refused = false;
    try {
      const raw = new DatabaseSync(corruptPath);
      try { quickCheck(raw); } finally { raw.close(); }
    } catch {
      refused = true;
    }
    assert.equal(refused, true, 'quickCheck/open refuses the corrupt DB');

    // Sanity: the untouched original still opens.
    const reopened = openDatabase(goodPath);
    assert.equal(quickCheck(reopened), 'ok');
    reopened.close();
  } finally {
    cleanup(dir);
  }
});
