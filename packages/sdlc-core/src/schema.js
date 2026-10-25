/**
 * packages/sdlc-core/src/schema.js — the plugin-owned SQLite schema (spec v3 B.2.3).
 *
 * Opened through Node's built-in `node:sqlite` (`DatabaseSync`) — zero native
 * dependencies, the same primitive `dsh-session-query-sqlite` already uses
 * in-tree (platform fact P24). Single-writer invariant (P23): only the
 * orchestrator process opens this file; workers never touch it.
 *
 * `events` append-only is a DATABASE INVARIANT (triggers), not a comment — M0-08
 * asserts that `DELETE FROM events` is rejected.
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync } from 'node:fs';

export const SCHEMA_VERSION = 1;

export const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA foreign_keys = ON',
];

export const DDL = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER NOT NULL,
     applied_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY,
     name TEXT,
     repo_path TEXT,
     state TEXT,
     blocked_state TEXT,
     complexity_json TEXT,
     budget_json TEXT,
     created_at TEXT,
     updated_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT,
     title TEXT,
     objective TEXT,
     role TEXT,
     state TEXT CHECK (state IN (
       'BACKLOG','READY','ASSIGNED','IN_PROGRESS','VERIFYING',
       'ACCEPTED','MERGING','DONE','FAILED','ESCALATED','BLOCKED','CANCELLED'
     )),
     attempt INTEGER DEFAULT 0,
     retry_budget INTEGER,
     risk_class TEXT,
     task_class TEXT,
     complexity REAL,
     model_tier TEXT,
     acceptance_criteria_json TEXT,
     allowed_paths_json TEXT,
     forbidden_paths_json TEXT,
     verification_json TEXT,
     estimate_json TEXT,
     plan_hash TEXT,
     worktree_path TEXT,
     branch TEXT,
     waiting_on TEXT,
     created_at TEXT,
     updated_at TEXT,
     FOREIGN KEY (project_id) REFERENCES projects(id)
   )`,

  `CREATE TABLE IF NOT EXISTS task_dependencies (
     task_id TEXT NOT NULL,
     depends_on TEXT NOT NULL,
     PRIMARY KEY (task_id, depends_on)
   )`,

  `CREATE TABLE IF NOT EXISTS task_resources (
     task_id TEXT NOT NULL,
     resource TEXT NOT NULL,
     PRIMARY KEY (task_id, resource)
   )`,

  `CREATE TABLE IF NOT EXISTS worker_runs (
     id TEXT PRIMARY KEY,
     task_id TEXT,
     attempt INTEGER,
     session_id TEXT,
     pid INTEGER,
     model_provider TEXT,
     model_id TEXT,
     status TEXT,
     exit_code INTEGER,
     started_at TEXT,
     finished_at TEXT,
     duration_ms INTEGER,
     tokens_in INTEGER,
     tokens_out INTEGER,
     cost_usd REAL,
     result_json TEXT,
     context_manifest_json TEXT,
     worktree_path TEXT,
     orphaned INTEGER DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS test_results (
     id TEXT PRIMARY KEY,
     task_id TEXT,
     run_id TEXT,
     gate TEXT,
     status TEXT,
     started_at TEXT,
     finished_at TEXT,
     log_path TEXT,
     signature TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS artifacts (
     id TEXT PRIMARY KEY,
     task_id TEXT,
     run_id TEXT,
     kind TEXT,
     path TEXT,
     meta_json TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS decisions (
     id TEXT PRIMARY KEY,
     project_id TEXT,
     question TEXT,
     decision TEXT,
     reason TEXT,
     alternatives_json TEXT,
     consequences_json TEXT,
     tags_json TEXT,
     created_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS requirements (
     id TEXT PRIMARY KEY,
     project_id TEXT,
     statement TEXT,
     source TEXT,
     acceptance_json TEXT,
     status TEXT,
     created_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT,
     project_id TEXT,
     task_id TEXT,
     actor TEXT,
     action TEXT,
     model TEXT,
     result TEXT,
     duration_ms INTEGER,
     payload_json TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS escalations (
     id TEXT PRIMARY KEY,
     task_id TEXT,
     attempt INTEGER,
     level TEXT,
     packet_json TEXT,
     resolution TEXT,
     resolved_by TEXT,
     created_at TEXT,
     resolved_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS model_runs (
     id TEXT PRIMARY KEY,
     model_id TEXT,
     task_id TEXT,
     task_type TEXT,
     complexity REAL,
     duration_ms INTEGER,
     tokens INTEGER,
     cost_usd REAL,
     attempts INTEGER,
     outcome TEXT,
     escalated INTEGER
   )`,

  `CREATE TABLE IF NOT EXISTS instance_lock (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     pid INTEGER,
     host TEXT,
     started_at TEXT,
     heartbeat_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS proposals (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN (
       'dispatch','approve','decision','plan-delta','run'
     )),
     task_id TEXT,
     payload_json TEXT,
     actor TEXT,
     decided_by TEXT,
     status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
       'queued','applied','rejected'
     )),
     reason TEXT,
     created_at TEXT,
     decided_at TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state)`,
  `CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_model_runs_model ON model_runs(model_id, task_type)`,

  // ── append-only enforcement (v3 addition) ──
  `CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
   BEGIN SELECT RAISE(ABORT, 'events is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
   BEGIN SELECT RAISE(ABORT, 'events is append-only'); END`,
];

export const TABLES = [
  'projects', 'tasks', 'task_dependencies', 'task_resources', 'worker_runs',
  'test_results', 'artifacts', 'decisions', 'requirements', 'events',
  'escalations', 'model_runs', 'schema_version', 'instance_lock', 'proposals',
];

/**
 * Apply pragmas + DDL. Idempotent: safe to call on every open.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} applied schema version
 */
export function schemaVersion(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!table) return null;
  const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
  return row?.version ?? null;
}

/** Refuse a database written by a newer plugin before any DDL mutates it. */
export function assertSchemaCompatible(db) {
  const version = schemaVersion(db);
  if (version !== null && version > SCHEMA_VERSION) {
    throw new Error(
      `sdlc.db schema version ${version} is newer than this plugin (${SCHEMA_VERSION}); `
      + 'refusing to open or migrate it. Upgrade the plugin or restore a backup.',
    );
  }
  return version;
}

export function migrate(db) {
  // Check BEFORE pragmas/DDL: a future schema must not be partially mutated.
  assertSchemaCompatible(db);
  for (const pragma of PRAGMAS) {
    try { db.exec(pragma); } catch { /* :memory: and read-only mounts may refuse WAL */ }
  }
  for (const statement of DDL) db.exec(statement);
  applyColumnMigrations(db);
  const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
  if (!row) {
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
    return SCHEMA_VERSION;
  }
  if (row.version < SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
    return SCHEMA_VERSION;
  }
  return row.version;
}

/** Integrity gate on open (B.2.3): `PRAGMA quick_check` must return `ok`. */
/**
 * Idempotent additive column migrations. `CREATE TABLE IF NOT EXISTS` cannot
 * add a column to an existing database, so new columns are applied here with a
 * `PRAGMA table_info` guard. Additive only — destructive changes require a
 * backup + schema_version bump.
 */
export function applyColumnMigrations(db) {
  const additions = [
    ['tasks', 'task_class', 'TEXT'],
  ];
  for (const [table, column, type] of additions) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function quickCheck(db) {
  const row = db.prepare('PRAGMA quick_check').get();
  const value = row?.quick_check ?? Object.values(row ?? {})[0];
  if (value !== 'ok') throw new Error(`sdlc.db failed quick_check: ${value}`);
  return 'ok';
}

/**
 * Open (or create) the plugin database. `requireQuickCheckOnOpen` defaults true;
 * a corrupt DB refuses to open rather than starting a scheduler on torn state.
 */
export function openDatabase(dbPath, { requireQuickCheck = true, DatabaseSync: Ctor = DatabaseSync } = {}) {
  const db = new Ctor(dbPath);
  try {
    // Integrity + compatibility BEFORE any write. A torn DB must refuse to open
    // (B.2.3), and a newer schema must never be migrated by an older plugin.
    const version = assertSchemaCompatible(db);
    if (requireQuickCheck) quickCheck(db);
    if (version !== null && version < SCHEMA_VERSION && dbPath !== ':memory:' && existsSync(dbPath)) {
      try { copyFileSync(dbPath, `${dbPath}.bak-v${version}`); } catch { /* backup is best-effort; migration is still checked */ }
    }
    migrate(db);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    throw error;
  }
}

export function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
}

export function triggerNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
    .all()
    .map((r) => r.name);
}

export default { migrate, quickCheck, openDatabase, schemaVersion, assertSchemaCompatible, SCHEMA_VERSION, DDL, TABLES };
