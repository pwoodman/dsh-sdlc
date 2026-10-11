/**
 * tests/unit/schema.test.mjs — persistence schema & migrations (spec v3 B.2.3, M0-08).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const schema = await core.schema();

test('migrate creates every table and trigger, and is idempotent', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const version = schema.migrate(db);
  assert.equal(version, schema.SCHEMA_VERSION);
  assert.equal(schema.migrate(db), schema.SCHEMA_VERSION, 're-running migrate is safe');
  const tables = schema.tableNames(db);
  for (const t of schema.TABLES) assert.ok(tables.includes(t), `missing table ${t}`);
  const triggers = schema.triggerNames(db);
  assert.ok(triggers.includes('events_no_update'));
  assert.ok(triggers.includes('events_no_delete'));
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, schema.SCHEMA_VERSION);
  db.close();
});

test('events are append-only: UPDATE and DELETE are rejected by triggers', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  schema.migrate(db);
  db.prepare("INSERT INTO events(ts, actor, action) VALUES ('now','test','x')").run();
  assert.throws(() => db.prepare('DELETE FROM events').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE events SET actor='y'").run(), /append-only/);
  // INSERT still works
  db.prepare("INSERT INTO events(ts, actor, action) VALUES ('now','test','y')").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
  db.close();
});

test('task state CHECK constraint rejects an unknown state', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  schema.migrate(db);
  assert.throws(() => db.prepare("INSERT INTO tasks(id, state) VALUES ('T','NOPE')").run(), /CHECK/i);
  db.prepare("INSERT INTO tasks(id, state) VALUES ('T','BACKLOG')").run();
  db.close();
});

test('quickCheck returns ok on a healthy file database', () => {
  const dir = tempDir('sdlc-schema-');
  try {
    const db = schema.openDatabase(join(dir, 'sdlc.db'));
    assert.equal(schema.quickCheck(db), 'ok');
    db.close();
  } finally {
    cleanup(dir);
  }
});

test('a corrupt database is refused on open (integrity gate, B.2.3)', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = tempDir('sdlc-corrupt-');
  try {
    const path = join(dir, 'sdlc.db');
    const db = schema.openDatabase(path);
    db.close();
    // Overwrite the page data with garbage, keeping the SQLite header length plausible.
    writeFileSync(path, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0x41)]));
    assert.throws(() => {
      const broken = schema.openDatabase(path);
      broken.close();
    });
  } finally {
    cleanup(dir);
  }
});

test('instance_lock is a single row by construction', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  schema.migrate(db);
  db.prepare("INSERT INTO instance_lock(id, pid, host) VALUES (1, 1, 'h')").run();
  assert.throws(() => db.prepare("INSERT INTO instance_lock(id, pid, host) VALUES (2, 2, 'h')").run(), /CHECK/i);
  db.close();
});
