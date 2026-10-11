/**
 * tests/lib/normalize-events.mjs — the K.6 determinism normalizer.
 *
 * "Divergence" must always mean the same thing, so normalization is implemented
 * ONCE here and reused by every determinism test: strip timestamps, generated
 * ids, durations, pids, ports, absolute temp paths and wall-clock ordering
 * artefacts, then assert byte equality of the normalized stream.
 */

const ID_KEYS = /(^|_)(id|run_id|runId|session_id|sessionId|nonce|pid|uuid)$/i;
const DURATION_KEYS = /(duration|elapsed|ms|latency|took)$/i;
const TIME_KEYS = /(^|_)(ts|time|timestamp|started_at|finished_at|created_at|updated_at|at)$/i;

export function normalizeValue(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (TIME_KEYS.test(k)) { out[k] = '<time>'; continue; }
      if (DURATION_KEYS.test(k)) { out[k] = 0; continue; }
      if (ID_KEYS.test(k) && typeof value[k] === 'string') { out[k] = '<id>'; continue; }
      out[k] = normalizeValue(value[k], k);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
      .replace(/\b[0-9a-f]{7,40}\b/g, '<id>')
      .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<tmp>')
      .replace(/\b\d{4,}\b/g, '<n>');
  }
  return value;
}

/** Normalize an `events` row (DB shape) to a stable, comparable object. */
export function normalizeEvent(row) {
  return normalizeValue({
    actor: row.actor,
    action: row.action,
    model: row.model ?? null,
    result: row.result ?? null,
    task_id: row.task_id ?? null,
    payload: row.payload_json ? safeParse(row.payload_json) : null,
  });
}

export function normalizeEvents(rows = []) {
  return rows.map(normalizeEvent);
}

export function eventStreamKey(rows = []) {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

export function diffStreams(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  const out = [];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    if (left[i] !== right[i]) out.push({ line: i, left: left[i] ?? null, right: right[i] ?? null });
  }
  return out;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

export default { normalizeEvents, normalizeEvent, normalizeValue, eventStreamKey, diffStreams };
