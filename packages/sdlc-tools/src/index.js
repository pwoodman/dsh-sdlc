/**
 * packages/sdlc-tools/src/index.js — model-facing tools and the /sdlc command surface.
 *
 * AUTHORITY (spec v3 C.4, L.1): tools are PROPOSE-ONLY. They run inside the
 * worker's own process and write a schema-validated proposal to the worktree
 * outbox (B.3.2); they have no `sdlc.db` access and no cross-process write path.
 * The transition service validates and applies. Anything that GRANTS authority
 * (approve/reject/stop) is a user-only command handler — never a model tool.
 */

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildOutbox, OUTBOX_PATH } from '../../sdlc-core/src/worker-result.js';

export const WORKER_TOOLS = ['sdlc_report_result', 'sdlc_claim_check', 'sdlc_request_decision'];
export const LEAD_TOOLS = ['sdlc_dispatch_task', 'sdlc_approve_transition', 'sdlc_record_decision', 'sdlc_plan_delta'];
export const ALL_TOOLS = [...WORKER_TOOLS, ...LEAD_TOOLS];

export const COMMANDS = [
  'run', 'status', 'tasks', 'workers', 'models', 'logs', 'verify', 'resume', 'stop',
  'explain', 'retry', 'elevate', 'approve', 'reject', 'doctor', 'config', 'init', 'lock', 'selftest',
  'debug',
];

/**
 * The `debug` command surface (review + improvement). Read-only: it renders
 * recorded run anatomy (time/tokens/tracepaths) side by side. Like `status`
 * and `explain` it grants no authority, so it is available to every mode —
 * including headless deployments that are otherwise guests of the state
 * machine (fail-closed, C.2/L.5).
 */
export const DEBUG_COMMANDS = ['compare', 'trace'];

/** Commands that grant authority; user-only, executed directly by the handler. */
export const AUTHORITY_COMMANDS = ['approve', 'reject', 'stop', 'retry', 'elevate'];

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const ARRAY_STR = (description) => S('array', description, { items: { type: 'string' } });

/**
 * Tool definitions in the `defineTool` DSL shape (C.4): every tool has a
 * canonical `output` schema and a pure `render()`.
 */
export const TOOL_DEFS = {
  sdlc_report_result: {
    name: 'sdlc_report_result',
    description: 'Report the outcome of this task. Writes a proposal to .sdlc/task-outbox.json; the runtime verifies it against the git diff.',
    parameters: {
      type: 'object',
      properties: {
        status: S('string', 'completed | failed | aborted', { enum: ['completed', 'failed', 'aborted'] }),
        summary: S('string', 'One-paragraph summary of what changed'),
        evidence_claims: S('array', 'Per acceptance criterion claims', {
          items: {
            type: 'object',
            properties: { ac_id: S('string', 'AC id'), claim: S('string', 'pass | fail'), artifact: S('string', 'Path or test id') },
            required: ['ac_id', 'claim'],
          },
        }),
        tests_run: ARRAY_STR('Test commands or selectors that were run'),
        requests: ARRAY_STR('Explicit asks for the Lead (dependencies, decisions)'),
      },
      required: ['status', 'summary'],
    },
    output: { schema: { type: 'object', properties: { ok: S('boolean', 'proposal accepted') } }, render: (r) => (r.ok ? 'result recorded' : 'result rejected') },
    authority: 'propose',
  },
  sdlc_claim_check: {
    name: 'sdlc_claim_check',
    description: 'Claim that a specific acceptance-criteria check passed, with its artifact. Claims are hints; the verifier re-runs the gate.',
    parameters: {
      type: 'object',
      properties: {
        ac_id: S('string', 'Acceptance criterion id'),
        claim: S('string', 'pass | fail', { enum: ['pass', 'fail'] }),
        artifact: S('string', 'Evidence path or test identifier'),
      },
      required: ['ac_id', 'claim'],
    },
    output: { schema: { type: 'object', properties: { ok: S('boolean', 'claim recorded') } }, render: (r) => (r.ok ? 'claim recorded' : 'claim rejected') },
    authority: 'propose',
  },
  sdlc_request_decision: {
    name: 'sdlc_request_decision',
    description: 'Ask the Lead for a decision or a missing dependency. In a headless worker this resolves unavailable and the task stays BLOCKED (fail-closed).',
    parameters: {
      type: 'object',
      properties: {
        question: S('string', 'The decision required'),
        options: ARRAY_STR('Candidate options'),
        blocking: S('boolean', 'Whether work cannot continue without an answer'),
      },
      required: ['question'],
    },
    output: { schema: { type: 'object', properties: { ok: S('boolean', 'request queued') } }, render: (r) => (r.ok ? 'decision requested' : 'request rejected') },
    authority: 'propose',
  },
  sdlc_dispatch_task: {
    name: 'sdlc_dispatch_task',
    description: 'Propose dispatching a persisted task. The scheduler decides; an illegal proposal returns INVALID_TRANSITION.',
    parameters: {
      type: 'object',
      properties: { task_id: S('string', 'Task id'), note: S('string', 'Why now') },
      required: ['task_id'],
    },
    output: { schema: { type: 'object', properties: { ok: S('boolean', ''), error: S('string', '') } }, render: (r) => (r.ok ? `dispatched ${r.task_id ?? ''}` : r.error) },
    authority: 'propose',
  },
  sdlc_approve_transition: {
    name: 'sdlc_approve_transition',
    description: 'Propose approving a transition. The runtime applies it only if the transition matrix and evidence allow it; a model can never grant authority (L.1 rule 4).',
    parameters: {
      type: 'object',
      properties: { task_id: S('string', 'Task id'), to: S('string', 'Target state'), reason: S('string', 'Evidence') },
      required: ['task_id', 'to'],
    },
    output: { schema: { type: 'object', properties: { ok: S('boolean', ''), error: S('string', '') } }, render: (r) => (r.ok ? 'proposal recorded' : r.error) },
    authority: 'propose',
  },
  sdlc_record_decision: {
    name: 'sdlc_record_decision',
    description: 'Propose recording an ADR in the decision ledger.',
    parameters: {
      type: 'object',
      properties: {
        question: S('string', ''), decision: S('string', ''), reason: S('string', ''),
        alternatives: ARRAY_STR(''), consequences: ARRAY_STR(''), tags: ARRAY_STR(''),
      },
      required: ['question', 'decision'],
    },
    output: { schema: { type: 'object', properties: { ok: S('boolean', '') } }, render: (r) => (r.ok ? 'decision recorded' : 'rejected') },
    authority: 'propose',
  },
  sdlc_plan_delta: {
    name: 'sdlc_plan_delta',
    description: 'Propose adding or editing tasks. The runtime applies deltas only through the normal planner path (spec §36).',
    parameters: {
      type: 'object',
      properties: { tasks: S('array', 'Task proposals', { items: { type: 'object' } }), reason: S('string', '') },
      required: ['tasks'],
    },
    output: { schema: { type: 'object', properties: { ok: S('boolean', ''), count: S('number', '') } }, render: (r) => (r.ok ? `${r.count ?? 0} task proposals queued` : 'rejected') },
    authority: 'propose',
  },
};

/** Atomic outbox write (write temp + rename) — B.3.2. */
export function writeOutbox(worktreePath, envelope) {
  const target = join(worktreePath, OUTBOX_PATH);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(envelope, null, 2) + '\n');
  renameSync(tmp, target);
  return target;
}

export function appendRequest(worktreePath, request) {
  const target = join(worktreePath, '.sdlc', 'requests.jsonl');
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, JSON.stringify({ ...request, at: new Date().toISOString() }) + '\n');
  return target;
}

/**
 * Handlers for the proposal channel. `allowed_paths`/`forbidden_paths` are NOT
 * consulted here — the guard does that; these handlers only shape proposals.
 */
export function createHandlers({ worktreePath, runMeta = {} } = {}) {
  const state = { claims: [], requests: [], reported: null };

  return {
    sdlc_report_result(args) {
      const envelope = buildOutbox({
        runId: runMeta.runId, taskId: runMeta.taskId, attempt: runMeta.attempt, nonce: runMeta.nonce,
        claims: {
          status: args.status, summary: args.summary,
          evidence_claims: args.evidence_claims ?? state.claims,
          tests_run: args.tests_run ?? [], requests: [...state.requests, ...(args.requests ?? [])],
        },
      });
      if (worktreePath) writeOutbox(worktreePath, envelope);
      state.reported = envelope;
      return { ok: true, envelope };
    },
    sdlc_claim_check(args) {
      state.claims.push({ ac_id: args.ac_id, claim: args.claim, artifact: args.artifact ?? null });
      return { ok: true, claims: state.claims.length };
    },
    sdlc_request_decision(args) {
      const request = { question: args.question, options: args.options ?? [], blocking: Boolean(args.blocking) };
      state.requests.push(request);
      if (worktreePath) appendRequest(worktreePath, request);
      return { ok: true, queued: true, blocking: request.blocking };
    },
    sdlc_dispatch_task(args) {
      return { ok: false, error: 'INVALID_TRANSITION: dispatch is owned by the scheduler', task_id: args.task_id };
    },
    sdlc_approve_transition(args) {
      return { ok: false, error: 'AUTHORITY_DENIED: approvals are user-only (L.1 rule 4)', task_id: args.task_id };
    },
    sdlc_record_decision(args) {
      return { ok: true, proposal: { kind: 'decision', ...args } };
    },
    sdlc_plan_delta(args) {
      return { ok: true, count: (args.tasks ?? []).length, proposal: { kind: 'plan-delta', ...args } };
    },
    _state: state,
  };
}

/** Validate args against the tool's parameter schema (minimal JSON-Schema subset). */
export function validateToolArgs(name, args = {}) {
  const def = TOOL_DEFS[name];
  if (!def) return { ok: false, error: `unknown tool ${name}` };
  const errors = [];
  for (const key of def.parameters.required ?? []) {
    if (args[key] === undefined) errors.push(`missing required parameter ${key}`);
  }
  for (const [key, spec] of Object.entries(def.parameters.properties ?? {})) {
    const value = args[key];
    if (value === undefined) continue;
    if (spec.type === 'array' && !Array.isArray(value)) errors.push(`${key} must be an array`);
    if (spec.type === 'string' && typeof value !== 'string') errors.push(`${key} must be a string`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') errors.push(`${key} must be a boolean`);
    if (spec.enum && !spec.enum.includes(value)) errors.push(`${key} must be one of ${spec.enum.join('|')}`);
  }
  return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
}

export default { TOOL_DEFS, WORKER_TOOLS, LEAD_TOOLS, COMMANDS, createHandlers, writeOutbox };
