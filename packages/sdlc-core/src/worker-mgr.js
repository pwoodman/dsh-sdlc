/**
 * packages/sdlc-core/src/worker-mgr.js — worker dispatch primitives (spec v3 C.2, B.3.2, B.10, E5).
 *
 * The single most consequential platform finding (E5/P25): `ctx.subprocess`
 * builds a child env from the parent MINUS every name matching
 * /KEY|PASSWORD|SECRET|TOKEN/i and MINUS every `DSH_*` name — so `DSH_HOME` and
 * all provider keys are stripped unless passed EXPLICITLY. Worker launch must
 * therefore always pass an `env` map, and env-key authentication is an audited
 * opt-in (`execution.workerEnvKeys`), not a default.
 */

import { randomUUID, createHash } from 'node:crypto';
import { basename } from 'node:path';

export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/** Reproduce the platform scrub so we can assert we survive it. */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('DSH_')) continue;
    if (SENSITIVE_ENV_PATTERN.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The explicit env map handed to `ctx.subprocess.spawn` (B.10).
 * `DSH_HOME` is ALWAYS forwarded; provider keys only when the deployment opted
 * in, and the choice is recorded in the worker_runs context manifest.
 */
export function buildWorkerEnv({
  dshHome,
  baseEnv = process.env,
  workerEnvKeys = [],
  extra = {},
} = {}) {
  const env = {};
  if (baseEnv.PATH) env.PATH = baseEnv.PATH;
  if (dshHome) env.DSH_HOME = dshHome;
  const forwarded = [];
  for (const key of workerEnvKeys) {
    if (baseEnv[key] !== undefined) {
      env[key] = baseEnv[key];
      forwarded.push(key);
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v;
  }
  return {
    env,
    audit: {
      DSH_HOME: dshHome ?? null,
      path: env.PATH ? '<from-parent>' : null,
      forwardedEnvKeys: forwarded.sort(),
      credentialPolicy: forwarded.length ? 'env-keys' : 'credential-store',
    },
  };
}

/**
 * Worker launch argv (E1: there is NO `--headless` flag — the PROFILE is
 * one-shot). `--patch` carries the id-targeted tier overlay (C.6/E4).
 */
export function buildSpawnArgv({ profile = 'sdlc-worker', tierOverlay = null, prompt, sessionId = null, extra = [] } = {}) {
  const argv = ['dsh', '--profile', profile];
  if (tierOverlay) argv.push('--patch', tierOverlay);
  if (sessionId) argv.push('--session-id', sessionId);
  argv.push('--json');
  if (extra.length) argv.push(...extra);
  if (prompt) argv.push(prompt);
  return argv;
}

/** Deterministic run identity: one row per (task, attempt). */
export function workerRunId(taskId, attempt, nonce = null) {
  const key = nonce ? `${taskId}:${attempt}:${nonce}` : `${taskId}:${attempt}`;
  return `${taskId}-a${attempt}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
}

/** Per-run nonce: the outbox provenance check compares against this (B.3.2). */
export function nonceFor(runId) {
  return createHash('sha256').update(`${runId}:${randomUUID()}`).digest('hex').slice(0, 32);
}

/**
 * Re-derive the status from the headless contract (P4/P32): exit 0 = completed,
 * 1 = aborted/errored; the `final`/`turn_end` event refines it.
 */
export function classifyExit({ exitCode, signal = null, turnEndReason = null } = {}) {
  if (signal === 'SIGKILL') return 'timeout';
  if (signal === 'SIGTERM') return 'aborted';
  if (exitCode === 0 && (turnEndReason == null || turnEndReason === 'completed')) return 'completed';
  if (turnEndReason === 'aborted') return 'aborted';
  return 'failed';
}

export const NDJSON_EVENT_TYPES = ['session', 'status', 'text', 'thinking', 'tool_call', 'tool_result', 'turn_end', 'final', 'error'];

/**
 * Parse the headless NDJSON stream. Strings are capped at 8 KiB and lines at
 * 32 KiB by the platform, but the `final` event is UNCAPPED (P32) — which is
 * why the fenced-block fallback survives.
 */
export function parseNdjson(stream) {
  const events = [];
  const malformed = [];
  for (const line of String(stream ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const doc = JSON.parse(trimmed);
      events.push(doc);
    } catch {
      malformed.push(trimmed.slice(0, 500));
    }
  }
  return { events, malformed };
}

export function finalText(events = []) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'final' && typeof events[i].text === 'string') return events[i].text;
  }
  return null;
}

export function turnEndReason(events = []) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn_end') return events[i].reason ?? events[i].status ?? null;
  }
  return null;
}

/** Port allocator block: BASE_PORT + 10·slot … +9 (B.10). */
export function portBlock(basePort, slot, size = 10) {
  const base = basePort + size * slot;
  return { base, ports: Array.from({ length: size }, (_, i) => base + i) };
}

/** Load the task contract into the worktree before launch (guard input). */
export function contractPathFor(worktreePath) {
  return `${worktreePath}/.sdlc/task-contract.json`;
}

/** `.git/info/exclude` line for orchestrator paths (E7: never the repo .gitignore). */
export function worktreeExcludeEntries(worktreePath) {
  return [
    { path: `${worktreePath}/.git/info/exclude`, lines: ['.sdlc/'] },
  ];
}

/** Concurrency cap (B.10): min(cores/2, ram/2, provider_limit, configured). */
export function providerLimitFromRegistry(registry = [], provider) {
  const entry = registry.find((r) => r.provider === provider && r.limits?.maxConcurrent != null);
  return entry ? entry.limits.maxConcurrent : Infinity;
}

/**
 * Resume rule (E8): a retry resumes the SAME worker session ONLY while the
 * worktree and preset are unchanged; a re-created worktree starts fresh.
 */
export function sessionForAttempt({ previousSessionId, worktreeRecreated, presetChanged } = {}) {
  if (!previousSessionId) return { sessionId: null, fresh: true, reason: 'first-attempt' };
  if (worktreeRecreated) return { sessionId: null, fresh: true, reason: 'worktree-recreated' };
  if (presetChanged) return { sessionId: null, fresh: true, reason: 'preset-changed' };
  return { sessionId: previousSessionId, fresh: false, reason: 'same-worktree' };
}

/** NDJSON capture path for a worker run (B.10: stderr is never forwarded). */
export function workerLogPath(root, taskId, runId) {
  return `${root}/.sdlc/verification/${taskId}/worker-${runId}.ndjson`;
}

export function runLabel(runId) {
  return basename(runId);
}

export default {
  buildWorkerEnv, buildSpawnArgv, workerRunId, nonceFor, classifyExit, parseNdjson,
  finalText, turnEndReason, portBlock, sessionForAttempt, SENSITIVE_ENV_PATTERN,
};
