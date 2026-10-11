/**
 * packages/sdlc-core/src/loop.js — loop detection & elevation (spec v3 B.6).
 *
 * Fingerprint = (task_id, signature) where signature is the failing gate plus
 * the NORMALIZED failure text of the first failing check, plus the sorted top-5
 * `files_changed` of the attempt. LOOP when the same fingerprint is seen ≥2
 * attempts, or the task has ≥3 failed attempts regardless of signature.
 */

import { createHash } from 'node:crypto';

/** Normalize failure text so cosmetically different failures collide (K.3). */
export function normalizeFailureText(text, { limit = 200 } = {}) {
  let s = String(text ?? '');
  s = s.toLowerCase();
  // Absolute and relative file paths → <path>
  s = s.replace(/(?:[a-z]:)?(?:[./][\w.@-]+){2,}/g, '<path>');
  // Hashes / ids / long numbers → <n>
  s = s.replace(/\b[0-9a-f]{7,40}\b/g, '<n>');
  s = s.replace(/\b\d+(\.\d+)?\b/g, '<n>');
  // Collapse whitespace and trim punctuation noise
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, limit);
}

export function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * @param {object} attempt
 * @param {string} attempt.taskId
 * @param {string} [attempt.gate]           first failing gate
 * @param {string} [attempt.failureText]    first failing check output
 * @param {string[]} [attempt.filesChanged]
 */
export function fingerprint({ taskId, gate = 'none', failureText = '', filesChanged = [] } = {}) {
  const signature = `${gate}:${normalizeFailureText(failureText)}`;
  const files = [...new Set(filesChanged)].sort().slice(0, 5).join(',');
  return {
    taskId,
    signature,
    files,
    key: `${taskId}|${sha1(signature)}|${sha1(files)}`,
  };
}

/**
 * @param {Array<{status:string, fingerprint:object}>} attempts
 * @returns {{loop:boolean, reason?:string, fingerprint?:object, count:number}}
 */
export function detectLoop(attempts = [], { loopThreshold = 2, maxFailedAttempts = 3 } = {}) {
  const failures = attempts.filter((a) => a.status === 'failed' || a.status === 'timeout' || a.status === 'aborted');
  if (failures.length >= maxFailedAttempts) {
    return {
      loop: true,
      reason: `max-failed-attempts:${failures.length}`,
      count: failures.length,
      fingerprint: failures[failures.length - 1]?.fingerprint,
    };
  }
  const counts = new Map();
  for (const f of failures) {
    const key = f.fingerprint?.key;
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, n] of counts) {
    if (n >= loopThreshold) {
      return { loop: true, reason: `fingerprint-repeat:${n}`, count: n, key };
    }
  }
  return { loop: false, count: failures.length };
}

/** Build the elevation packet handed to the ELEVATED model (B.6). */
export function buildElevationPacket({
  taskId,
  attempts = [],
  failures = [],
  filesChanged = [],
  outOfScopeFiles = [],
  testOutputPath = null,
  relevantDecisions = [],
  worktreeDiffPath = null,
  request = 'diagnose root cause and propose corrective action',
  maxFailureBytes = 8192,
} = {}) {
  return {
    task_id: taskId,
    attempts: attempts.map((a, i) => ({
      n: a.n ?? i + 1,
      model: a.model ?? null,
      status: a.status,
      signature: a.signature ?? a.fingerprint?.signature ?? null,
    })),
    failures: failures.map((f) => String(f).slice(0, maxFailureBytes)),
    files_changed: filesChanged,
    out_of_scope_files: outOfScopeFiles,
    test_output: testOutputPath,
    relevant_decisions: relevantDecisions,
    worktree_diff_path: worktreeDiffPath,
    request,
  };
}

export const DISPOSITIONS = ['retask', 'replan', 'architecture_review', 'escalate_user'];

/**
 * Validate the ELEVATED model's structured answer. The runtime applies
 * `corrective_plan` only as task-graph PROPOSALS — the model never edits the
 * graph directly (spec §36).
 */
export function parseElevationResponse(raw) {
  let doc = raw;
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw); } catch { return { ok: false, error: 'ELEVATION_MALFORMED' }; }
  }
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'ELEVATION_MALFORMED' };
  const required = ['root_cause', 'failure_pattern', 'mis_decomposition', 'architecture_issue', 'corrective_plan', 'disposition'];
  const missing = required.filter((k) => doc[k] === undefined);
  if (missing.length) return { ok: false, error: `ELEVATION_MALFORMED: missing ${missing.join(', ')}` };
  if (!DISPOSITIONS.includes(doc.disposition)) {
    return { ok: false, error: `ELEVATION_MALFORMED: unknown disposition ${doc.disposition}` };
  }
  return {
    ok: true,
    value: {
      root_cause: String(doc.root_cause),
      failure_pattern: String(doc.failure_pattern),
      mis_decomposition: Boolean(doc.mis_decomposition),
      architecture_issue: Boolean(doc.architecture_issue),
      corrective_plan: Array.isArray(doc.corrective_plan) ? doc.corrective_plan : [],
      disposition: doc.disposition,
    },
  };
}

/** Escalation ladder: CHEAP → BASE → ELEVATED → ARCHITECTURE REVIEW → USER. */
export const LADDER = ['CHEAP', 'BASE', 'ELEVATED', 'ARCHITECTURE_REVIEW', 'USER'];

export function nextLadderStep(current) {
  const idx = LADDER.indexOf(String(current).toUpperCase());
  if (idx < 0 || idx >= LADDER.length - 1) return 'USER';
  return LADDER[idx + 1];
}

export default { fingerprint, normalizeFailureText, detectLoop, buildElevationPacket, parseElevationResponse, LADDER };
