/**
 * eval/lib/records.mjs — the run-record schema and JSONL I/O.
 *
 * One record = one (task, arm, repeat) execution. Records are append-only JSONL
 * so a partial run is still readable, and every record carries the executor and
 * model identity, because a record whose provenance is unknown is not evidence.
 *
 * Every record also carries the `studySeed` of the study that produced it, so a
 * report can refuse a file that mixes two studies (e.g. a re-run appended onto
 * an old `records.jsonl`), and duplicate `runId`s — the signature of an
 * accidental double-append — are detectable instead of silently collapsed.
 */

import { appendFileSync, readFileSync, existsSync } from 'node:fs';

export const RECORD_VERSION = '1.0.0';

export const ARMS = ['control', 'treatment'];

/** A run is `ok` only when the executor really ran; anything else is `invalid`. */
export const VALID_STATUSES = ['ok', 'invalid'];

/** Human meaning of each arm, asserted in the protocol. */
export const ARM_LABELS = {
  control: 'DSH baseline (same model, plugin absent)',
  treatment: 'DSH + SDLC plugin (same model)',
};

/**
 * Whether a record may be used as evidence. A record with no `status` predates
 * this field and is judged on its exit code, so older records stay readable.
 */
export function isRecordValid(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.status !== undefined && rec.status !== 'ok') return false;
  if (rec.executorError != null) return false;
  if (rec.exitCode !== null && rec.exitCode !== 0) return false;
  return true;
}

export const RECORD_SCHEMA = Object.freeze({
  title: 'SDLC evaluation run record',
  type: 'object',
  required: [
    'recordVersion', 'runId', 'taskId', 'arm', 'executor', 'repeat', 'model',
    'startedAt', 'durationMs', 'exitCode', 'acceptance', 'metrics',
  ],
  properties: {
    recordVersion: { const: RECORD_VERSION },
    runId: { type: 'string' },
    taskId: { type: 'string' },
    arm: { enum: ARMS },
    executor: { enum: ['simulate', 'dsh'] },
    repeat: { type: 'integer', minimum: 0 },
    model: { type: ['string', 'null'] },
    modelProvider: { type: ['string', 'null'] },
    studySeed: { type: ['string', 'null'] },
    attempts: { type: 'integer', minimum: 1 },
    status: { enum: VALID_STATUSES },
    startedAt: { type: 'string' },
    durationMs: { type: 'number' },
    tokensIn: { type: ['number', 'null'] },
    tokensOut: { type: ['number', 'null'] },
    costUsd: { type: ['number', 'null'] },
    exitCode: { type: ['integer', 'null'] },
    stderr: { type: ['string', 'null'] },
    acceptance: { type: 'object' },
    metrics: { type: 'object' },
    artifacts: { type: 'object' },
    environment: { type: ['object', 'null'] },
    notes: { type: 'array', items: { type: 'string' } },
    executorError: { type: ['string', 'null'] },
  },
});

export function makeRunId(taskId, arm, repeat, { seed = null } = {}) {
  const suffix = seed == null ? '' : `-s${seed}`;
  return `${taskId}-${arm}-r${repeat}${suffix}`;
}

/** Validate a record; returns `{ok, problems}` and never throws. */
export function validateRecord(rec) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(rec && typeof rec === 'object', 'record must be an object');
  if (!rec || typeof rec !== 'object') return { ok: false, problems };
  need(rec.recordVersion === RECORD_VERSION, `recordVersion must be ${RECORD_VERSION}`);
  for (const k of RECORD_SCHEMA.required) need(rec[k] !== undefined, `missing required field ${k}`);
  need(typeof rec.runId === 'string' && rec.runId.length > 0, 'runId must be a non-empty string');
  need(typeof rec.taskId === 'string' && rec.taskId.length > 0, 'taskId must be a non-empty string');
  need(ARMS.includes(rec.arm), `arm must be one of ${ARMS.join('|')}`);
  need(['simulate', 'dsh'].includes(rec.executor), 'executor must be simulate|dsh');
  need(Number.isInteger(rec.repeat) && rec.repeat >= 0, 'repeat must be a non-negative integer');
  need(typeof rec.acceptance === 'object' && rec.acceptance !== null, 'acceptance must be an object');
  if (rec.acceptance && typeof rec.acceptance === 'object') {
    need(typeof rec.acceptance.passed === 'number', 'acceptance.passed must be a number');
    need(typeof rec.acceptance.total === 'number', 'acceptance.total must be a number');
  }
  need(typeof rec.metrics === 'object' && rec.metrics !== null, 'metrics must be an object');
  if (rec.status !== undefined) need(VALID_STATUSES.includes(rec.status), `status must be one of ${VALID_STATUSES.join('|')}`);
  if (rec.stderr !== undefined) need(rec.stderr === null || typeof rec.stderr === 'string', 'stderr must be a string or null');
  if (rec.modelProvider !== undefined) need(rec.modelProvider === null || typeof rec.modelProvider === 'string', 'modelProvider must be a string or null');
  if (rec.studySeed !== undefined) need(rec.studySeed === null || typeof rec.studySeed === 'string', 'studySeed must be a string or null');
  if (rec.attempts !== undefined) need(Number.isInteger(rec.attempts) && rec.attempts >= 1, 'attempts must be a positive integer');
  if (rec.environment !== undefined) need(rec.environment === null || typeof rec.environment === 'object', 'environment must be an object or null');
  return { ok: problems.length === 0, problems };
}

export function appendRecord(path, rec) {
  const v = validateRecord(rec);
  if (!v.ok) throw new Error(`refusing to append an invalid record: ${v.problems.join('; ')}`);
  appendFileSync(path, `${JSON.stringify(rec)}\n`);
  return rec;
}

/**
 * Read JSONL records, reporting malformed lines instead of throwing. A rejected
 * line keeps its parsed `doc` (when it is JSON at all) so a caller can decide
 * what an out-of-schema record means to it — the report, for example, discloses
 * records with an unknown arm instead of letting them vanish into a count.
 */
export function readRecords(path) {
  if (!existsSync(path)) return { records: [], malformed: [] };
  const records = [];
  const malformed = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const doc = JSON.parse(t);
      const v = validateRecord(doc);
      if (v.ok) records.push(doc);
      else malformed.push({ line: t.slice(0, 200), problems: v.problems, doc });
    } catch (err) {
      malformed.push({ line: t.slice(0, 200), problems: [err.message] });
    }
  }
  return { records, malformed };
}

/** Detect duplicate `runId`s: the signature of an accidental double-append. */
export function findDuplicateRunIds(records) {
  const seen = new Set();
  const dups = new Set();
  for (const r of records) {
    if (seen.has(r.runId)) dups.add(r.runId);
    seen.add(r.runId);
  }
  return [...dups].sort();
}

/** The distinct non-null study seeds present in a record set. */
export function recordSeeds(records) {
  return [...new Set(records.map((r) => r.studySeed ?? null).filter((s) => s != null))].sort();
}

export default { appendRecord, readRecords, validateRecord, isRecordValid, makeRunId, findDuplicateRunIds, recordSeeds, RECORD_SCHEMA, ARMS, ARM_LABELS, VALID_STATUSES };
