/**
 * tests/unit/tools.test.mjs — model-facing tools & the outbox channel (spec v3 C.4, B.3.2, L.1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const tools = await core.tools();
const wr = await core.workerResult();

test('the declared tool surface matches C.4 exactly', () => {
  assert.deepEqual(tools.WORKER_TOOLS, ['sdlc_report_result', 'sdlc_claim_check', 'sdlc_request_decision']);
  assert.deepEqual(tools.LEAD_TOOLS, ['sdlc_dispatch_task', 'sdlc_approve_transition', 'sdlc_record_decision', 'sdlc_plan_delta']);
  assert.deepEqual(Object.keys(tools.TOOL_DEFS).sort(), [...tools.WORKER_TOOLS, ...tools.LEAD_TOOLS].sort());
});

test('every tool has a canonical output schema and a pure render (C.4 DSL)', () => {
  for (const [name, def] of Object.entries(tools.TOOL_DEFS)) {
    assert.equal(def.name, name);
    assert.ok(def.description, `${name} has no description`);
    assert.equal(def.parameters.type, 'object');
    assert.ok(def.output?.schema, `${name} has no output schema`);
    assert.equal(typeof def.output.render, 'function');
    assert.equal(def.authority, 'propose', `${name} must be propose-only`);
  }
});

test('the /sdlc command surface is declared and authority commands are user-only', () => {
  for (const c of ['run', 'status', 'tasks', 'workers', 'models', 'logs', 'verify', 'resume', 'stop', 'explain', 'retry', 'elevate', 'approve', 'reject', 'doctor', 'config', 'debug']) {
    assert.ok(tools.COMMANDS.includes(c), `missing command ${c}`);
  }
  for (const c of tools.AUTHORITY_COMMANDS) assert.ok(tools.COMMANDS.includes(c));
  assert.deepEqual(tools.AUTHORITY_COMMANDS, ['approve', 'reject', 'stop', 'retry', 'elevate']);
  // `debug` is read-only review surface: never an authority command.
  assert.ok(!tools.AUTHORITY_COMMANDS.includes('debug'), 'debug must not grant authority');
  assert.deepEqual(tools.DEBUG_COMMANDS, ['compare', 'trace']);
});

test('argument validation enforces required fields, types and enums', () => {
  assert.equal(tools.validateToolArgs('sdlc_report_result', { status: 'completed', summary: 'ok' }).ok, true);
  assert.match(tools.validateToolArgs('sdlc_report_result', { summary: 'ok' }).error, /missing required parameter status/);
  assert.match(tools.validateToolArgs('sdlc_report_result', { status: 'nope', summary: 'ok' }).error, /must be one of/);
  assert.match(tools.validateToolArgs('sdlc_report_result', { status: 'completed', summary: 'ok', tests_run: 'x' }).error, /must be an array/);
  assert.match(tools.validateToolArgs('nope', {}).error, /unknown tool/);
});

test('sdlc_report_result writes a schema-valid outbox atomically (B.3.2)', () => {
  const dir = tempDir('sdlc-tools-');
  try {
    const handlers = tools.createHandlers({ worktreePath: dir, runMeta: { runId: 'R1', taskId: 'T1', attempt: 1, nonce: 'n1' } });
    const result = handlers.sdlc_report_result({ status: 'completed', summary: 'did the thing' });
    assert.equal(result.ok, true);
    const raw = readFileSync(join(dir, wr.OUTBOX_PATH), 'utf8');
    const ingested = wr.ingestOutbox(raw, { runId: 'R1', taskId: 'T1', attempt: 1, nonce: 'n1' });
    assert.equal(ingested.valid, true);
    assert.equal(ingested.suspect, false);
    assert.equal(ingested.claims.summary, 'did the thing');
    assert.equal(existsSync(join(dir, wr.OUTBOX_PATH)), true);
  } finally { cleanup(dir); }
});

test('claims accumulate and end up in the reported outbox', () => {
  const dir = tempDir('sdlc-tools-');
  try {
    const handlers = tools.createHandlers({ worktreePath: dir, runMeta: { runId: 'R', taskId: 'T', attempt: 0, nonce: 'x' } });
    handlers.sdlc_claim_check({ ac_id: 'AC1', claim: 'pass', artifact: 'tests/x.test.ts' });
    handlers.sdlc_claim_check({ ac_id: 'AC2', claim: 'fail' });
    const { envelope } = handlers.sdlc_report_result({ status: 'completed', summary: 's' });
    assert.deepEqual(envelope.evidence_claims.map((c) => c.ac_id), ['AC1', 'AC2']);
  } finally { cleanup(dir); }
});

test('sdlc_request_decision records an explicit ask for the Lead', () => {
  const dir = tempDir('sdlc-tools-');
  try {
    const handlers = tools.createHandlers({ worktreePath: dir, runMeta: {} });
    const result = handlers.sdlc_request_decision({ question: 'Which schema?', options: ['a', 'b'], blocking: true });
    assert.equal(result.ok, true);
    assert.equal(result.blocking, true);
    assert.match(readFileSync(join(dir, '.sdlc', 'requests.jsonl'), 'utf8'), /Which schema\?/);
  } finally { cleanup(dir); }
});

test('a model tool can never grant authority (L.1 rule 4)', () => {
  const handlers = tools.createHandlers({ worktreePath: null, runMeta: {} });
  const approval = handlers.sdlc_approve_transition({ task_id: 'T1', to: 'DONE' });
  assert.equal(approval.ok, false);
  assert.match(approval.error, /AUTHORITY_DENIED/);
  const dispatch = handlers.sdlc_dispatch_task({ task_id: 'T1' });
  assert.equal(dispatch.ok, false);
  assert.match(dispatch.error, /INVALID_TRANSITION/);
});

test('decision and plan-delta proposals are queued, not applied', () => {
  const handlers = tools.createHandlers({ worktreePath: null, runMeta: {} });
  const decision = handlers.sdlc_record_decision({ question: 'q', decision: 'd' });
  assert.equal(decision.ok, true);
  assert.equal(decision.proposal.kind, 'decision');
  const delta = handlers.sdlc_plan_delta({ tasks: [{ id: 'X' }, { id: 'Y' }] });
  assert.equal(delta.count, 2);
  assert.equal(delta.proposal.kind, 'plan-delta');
});

test('the plugin registration lists match the declared surface (used by M0-03/04)', async () => {
  const plugin = await core.tools();
  assert.equal(typeof plugin.createHandlers, 'function');
  const toolsPlugin = await import(`file://${join((await import('../lib/helpers.mjs')).ROOT, 'packages/sdlc-tools/src/plugin.js')}`);
  const fakeCtx = { tools: { register: (t) => registered.push(t.name) }, commands: { register: (c) => commands.push(c.name) }, logger: { warn() {} } };
  const registered = [];
  const commands = [];
  const report = toolsPlugin.apply(fakeCtx, {});
  assert.equal(registered.length, Object.keys(plugin.TOOL_DEFS).length);
  assert.ok(report.commands.includes('run'));
  assert.ok(report.commands.includes('doctor'));
});
