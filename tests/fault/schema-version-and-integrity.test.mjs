/**
 * tests/fault/schema-version-and-integrity.test.mjs — an older plugin must not
 * migrate a newer database, and a corrupt file must refuse to open before any
 * DDL is applied.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, cleanup } from '../lib/helpers.mjs';

const schema = await import('../../packages/sdlc-core/src/schema.js');

test('a database written by a newer schema is refused before any DDL', () => {
  const dir = tempDir('sdlc-schema-future-');
  const path = join(dir, 'sdlc.db');
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(999, new Date().toISOString());
    db.close();

    assert.throws(() => schema.openDatabase(path), /schema version 999 is newer/);

    // No migration ran: the tasks table still does not exist.
    const raw = new DatabaseSync(path);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    raw.close();
    assert.deepEqual(tables, ['schema_version']);
  } finally {
    cleanup(dir);
  }
});

test('the current schema opens, and a fresh database migrates to the current version', () => {
  const dir = tempDir('sdlc-schema-current-');
  const path = join(dir, 'sdlc.db');
  try {
    const db = schema.openDatabase(path);
    assert.equal(schema.schemaVersion(db), schema.SCHEMA_VERSION);
    assert.ok(schema.tableNames(db).includes('tasks'));
    db.close();
  } finally {
    cleanup(dir);
  }
});

test('a corrupt database refuses to open instead of starting on torn state', () => {
  const dir = tempDir('sdlc-schema-corrupt-');
  const path = join(dir, 'sdlc.db');
  try {
    writeFileSync(path, 'this is not a sqlite database');
    assert.throws(() => schema.openDatabase(path));
  } finally {
    cleanup(dir);
  }
});

test('migrate() itself refuses a future schema (direct callers like TaskStateService)', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(999, new Date().toISOString());
    assert.throws(() => schema.migrate(db), /schema version 999 is newer/);
  } finally {
    db.close();
  }
});
