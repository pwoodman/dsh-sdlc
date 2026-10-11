/**
 * packages/sdlc-core/src/worker-result.js — WorkerResult derivation (spec v3 B.3.2).
 *
 * The load-bearing rule of the whole orchestrator (L.1 rule 2): the DIFF owns
 * truth. `files_changed` and `out_of_scope_files` come from git, never from a
 * worker. A worker may claim anything; the worktree cannot lie.
 *
 * `ORCHESTRATOR_PATHS` (E7) are the worker's own result channel: they are
 * excluded from the diff before any scope decision, so writing the outbox can
 * never be a `SCOPE_VIOLATION`.
 */

import { matchAny, normalizePath, asArray } from './glob-lite.js';

/** Coerce to an array WITHOUT dropping non-string entries (evidence claims are objects). */
function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export const ORCHESTRATOR_PATHS = ['.sdlc/**', '.dsh/**'];

/** Files inside ORCHESTRATOR_PATHS that a worker may never write (B.3.2). */
export const PROTECTED_ORCHESTRATOR_PATHS = [
  '.sdlc/sdlc.db',
  '.sdlc/sdlc.db-*',
  '.sdlc/sdlc.lock',
  '.sdlc/instance.lock',
  '.sdlc/task-contract.json',
  '.sdlc/backup/**',
];

export const OUTBOX_PATH = '.sdlc/task-outbox.json';

export function isOrchestratorPath(path) {
  if (matchAny(ORCHESTRATOR_PATHS, path)) return true;
  // `.sdlc` itself (directory entry) counts as orchestrator-managed.
  const norm = normalizePath(String(path));
  return norm.ok && (norm.path === '.sdlc' || norm.path.startsWith('.sdlc/') ||
    norm.path === '.dsh' || norm.path.startsWith('.dsh/'));
}

export function excludeOrchestratorPaths(paths) {
  return normalizeList(paths).filter((p) => !isOrchestratorPath(p));
}

function normalizeList(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(paths)) {
    const norm = normalizePath(String(raw));
    if (!norm.ok) continue;
    if (seen.has(norm.path)) continue;
    seen.add(norm.path);
    out.push(norm.path);
  }
  return out.sort();
}

/**
 * Files the worker changed that its contract did not allow.
 * Computed AFTER dropping ORCHESTRATOR_PATHS (E7). Non-empty ⇒ SCOPE_VIOLATION.
 */
export function outOfScope(changed, allowedPaths, forbiddenPaths = []) {
  const scoped = excludeOrchestratorPaths(changed);
  const forbidden = asArray(forbiddenPaths);
  return scoped.filter((p) => matchAny(allowedPaths, p) === null || matchAny(forbidden, p) !== null);
}

/** Files inside allowed_paths that the contract explicitly forbade. */
export function forbiddenTouched(changed, forbiddenPaths) {
  const scoped = excludeOrchestratorPaths(changed);
  return scoped.filter((p) => matchAny(forbiddenPaths, p) !== null);
}

/**
 * Parse `git diff --name-only` OR `git status --porcelain` (`-z`) OR default
 * (space-separated) porcelain output into paths.
 *
 * Default porcelain looks like ` M src/a.ts`, `?? src/new.ts`,
 * `R  src/old.ts -> src/new.ts`; the `-z` form is NUL-separated with no status
 * prefix. Both are handled, and a status word is never returned as a path.
 */
export function parseGitNames(text) {
  const src = String(text ?? '');
  if (src.includes('\0')) return normalizeList(src.split('\0'));
  const out = [];
  for (const line of src.split('\n')) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed.trim() === '') continue;
    if (trimmed.includes('\t')) {
      // Porcelain -z/older tab form: "M\tpath" or "R  old\tnew"
      const parts = trimmed.split('\t');
      out.push(parts[parts.length - 1]);
      continue;
    }
    const status = trimmed.match(/^([ MADRCU?!]{1,2})\s+(.*)$/);
    if (status) {
      const rest = status[2];
      const renamed = rest.match(/^(.+?) -> (.+)$/);
      out.push(renamed ? renamed[2] : rest);
      continue;
    }
    out.push(trimmed);
  }
  return normalizeList(out);
}

/** Runtime-derived run status (exit code + turn_end), never worker-claimed. */
export function deriveStatus({ exitCode, turnEndReason, timedOut = false, signal = null } = {}) {
  if (timedOut || signal === 'SIGKILL') return 'timeout';
  if (exitCode === 0 && (turnEndReason == null || turnEndReason === 'completed')) return 'completed';
  if (turnEndReason === 'aborted' || signal === 'SIGTERM') return 'aborted';
  return 'failed';
}

/**
 * Derive the authoritative result record.
 * @param {object} input
 * @param {string[]} input.filesChanged      from git diff (authoritative)
 * @param {object} input.contract            task contract (allowed/forbidden paths)
 * @param {object} input.claims              worker-claimed portion (may be absent)
 * @param {object} input.runtime             {exitCode, turnEndReason, timedOut, signal, sessionId, tokens, costUsd, durationMs, model, attempt}
 */
export function deriveWorkerResult({ filesChanged = [], contract = {}, claims = {}, runtime = {} } = {}) {
  const changed = excludeOrchestratorPaths(filesChanged);
  const scope = outOfScope(changed, contract.allowed_paths ?? [], contract.forbidden_paths ?? []);
  const forbidden = forbiddenTouched(changed, contract.forbidden_paths ?? []);

  const status = runtime.status ?? deriveStatus(runtime);
  const violations = [...scope, ...forbidden];

  return {
    status,
    summary: claims.summary ?? '',
    evidence_claims: asList(claims.evidence_claims),
    tests_run: asArray(claims.tests_run),
    requests: asList(claims.requests),
    files_changed: changed,
    out_of_scope_files: scope,
    forbidden_files: forbidden,
    result_malformed: claims.__malformed === true,
    suspect: claims.__suspect === true,
    session_id: runtime.sessionId ?? null,
    tokens: runtime.tokens ?? { in: 0, out: 0 },
    cost_usd: runtime.costUsd ?? 0,
    duration_ms: runtime.durationMs ?? 0,
    model: runtime.model ?? null,
    attempt: runtime.attempt ?? 0,
    worker_claimed_status: claims.status ?? null,
  };
}

/** The machine verdict for a derived result: does it pass scope? */
export function scopeVerdict(result) {
  if (result.result_malformed) return { ok: false, code: 'RESULT_MALFORMED' };
  if (result.out_of_scope_files.length || result.forbidden_files.length) {
    return {
      ok: false,
      code: 'SCOPE_VIOLATION',
      files: [...result.out_of_scope_files, ...result.forbidden_files],
    };
  }
  return { ok: true, code: 'IN_SCOPE' };
}

// ── result channels (B.3.2) ────────────────────────────────────────────────

export const OUTBOX_SCHEMA_VERSION = 1;

/**
 * Validate + provenance-check an outbox document against the worker_runs row.
 * A mismatched nonce (or a run/task/attempt mismatch) marks the claims
 * `suspect` — verification must then refuse ACCEPTED.
 */
export function ingestOutbox(raw, runMeta = {}) {
  let doc = raw;
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw); } catch { return { valid: false, error: 'RESULT_MALFORMED: unparseable outbox' }; }
  }
  if (!doc || typeof doc !== 'object') return { valid: false, error: 'RESULT_MALFORMED: not an object' };
  const errors = [];
  if (doc.schemaVersion !== OUTBOX_SCHEMA_VERSION) errors.push(`schemaVersion: expected ${OUTBOX_SCHEMA_VERSION}`);
  if (!doc.runId) errors.push('runId missing');
  if (!doc.taskId) errors.push('taskId missing');
  if (!Number.isInteger(doc.attempt)) errors.push('attempt missing');
  if (typeof doc.nonce !== 'string' || doc.nonce.length === 0) errors.push('nonce missing');
  if (errors.length) return { valid: false, error: `RESULT_MALFORMED: ${errors.join('; ')}` };

  const mismatch =
    (runMeta.runId != null && doc.runId !== runMeta.runId) ||
    (runMeta.taskId != null && doc.taskId !== runMeta.taskId) ||
    (runMeta.attempt != null && doc.attempt !== runMeta.attempt) ||
    (runMeta.nonce != null && doc.nonce !== runMeta.nonce);

  return {
    valid: true,
    suspect: Boolean(mismatch),
    claims: {
      status: doc.status,
      summary: doc.summary,
      evidence_claims: doc.evidence_claims,
      tests_run: doc.tests_run,
      requests: doc.requests,
      __suspect: Boolean(mismatch),
    },
  };
}

/** Parse a single fenced ```sdlc-result block (the fallback channel). */
export function parseFencedBlock(text) {
  const src = String(text ?? '');
  const re = /```sdlc-result\s*\n([\s\S]*?)```/g;
  let match;
  let last = null;
  while ((match = re.exec(src)) !== null) last = match[1];
  if (last == null) return { valid: false, error: 'no sdlc-result fenced block' };
  try {
    const doc = JSON.parse(last);
    return {
      valid: true,
      suspect: false,
      claims: {
        status: doc.status,
        summary: doc.summary,
        evidence_claims: doc.evidence_claims,
        tests_run: doc.tests_run,
        requests: doc.requests,
      },
    };
  } catch (err) {
    return { valid: false, error: `RESULT_MALFORMED: fenced block is not JSON (${err.message})` };
  }
}

/**
 * Fixed precedence (B.3.2): a valid outbox wins; outbox/fenced-block
 * disagreement marks claims suspect; neither valid ⇒ RESULT_MALFORMED.
 */
export function resolveClaims({ outboxRaw, finalText, runMeta } = {}) {
  const outbox = outboxRaw != null ? ingestOutbox(outboxRaw, runMeta) : { valid: false };
  const fenced = finalText != null ? parseFencedBlock(finalText) : { valid: false };

  if (outbox.valid && fenced.valid) {
    // Compare the CLAIM payload only — never internal markers such as
    // `__suspect`, which the outbox branch adds for caller convenience.
    const disagree = comparableClaims(outbox.claims) !== comparableClaims(fenced.claims);
    return {
      source: 'outbox',
      suspect: outbox.suspect || disagree,
      claims: { ...outbox.claims, __suspect: outbox.suspect || disagree },
    };
  }
  if (outbox.valid) return { source: 'outbox', suspect: outbox.suspect, claims: outbox.claims };
  if (fenced.valid) return { source: 'fenced', suspect: false, claims: fenced.claims };
  return {
    source: 'none',
    suspect: false,
    claims: { __malformed: true, summary: '', evidence_claims: [], tests_run: [], requests: [] },
  };
}

function comparableClaims(claims = {}) {
  const pick = (v) => (Array.isArray(v) ? v : v == null ? [] : v);
  return JSON.stringify({
    status: claims.status ?? null,
    summary: claims.summary ?? '',
    evidence_claims: pick(claims.evidence_claims),
    tests_run: pick(claims.tests_run),
    requests: pick(claims.requests),
  });
}

/** Serialize the outbox envelope a worker tool writes (atomic write is the caller's job). */
export function buildOutbox({ runId, taskId, attempt, nonce, claims = {} }) {
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    runId,
    taskId,
    attempt,
    nonce,
    status: claims.status ?? 'completed',
    summary: claims.summary ?? '',
    evidence_claims: claims.evidence_claims ?? [],
    tests_run: claims.tests_run ?? [],
    requests: claims.requests ?? [],
  };
}

export default {
  ORCHESTRATOR_PATHS,
  excludeOrchestratorPaths,
  outOfScope,
  deriveWorkerResult,
  scopeVerdict,
  ingestOutbox,
  parseFencedBlock,
  resolveClaims,
};
