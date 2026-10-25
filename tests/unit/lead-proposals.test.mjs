/**
 * tests/unit/lead-proposals.test.mjs — D22 phase 1: durable lead proposals.
 *
 * The Lead tools are propose-only (L.1 rule 4): they enqueue a durable row
 * and the transition service (drain) applies it. Model-side `approve` is
 * rejected at enqueue time, executably — never by comment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { core } from '../lib/helpers.mjs';

const { Runtime } = await core.runtime();
const { migrate } = await core.schema();
const { TaskStateService } = await core.stateMachine();

async function freshRuntime() {
  const runtime = new Runtime({ projectRoot: '/tmp/lead-proposals-test', config: {}, useLock: false });
  runtime.db = new DatabaseSync(':memory:');
  migrate(runtime.db);
  runtime.state = new TaskStateService(runtime.db);
  return runtime;
}

test('enqueue persists a queued proposal row', async () => {
  const runtime = await freshRuntime();
  try {
    const res = runtime.queueLeadProposal({ kind: 'plan-delta', payload: { tasks: [], reason: 'r' }, actor: 'lead' });
    assert.equal(res.ok, true);
    assert.equal(res.proposal.status, 'queued');
    const rows = runtime.listProposals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'plan-delta');
    assert.equal(rows[0].status, 'queued');
  } finally { runtime.db.close(); }
});

test('unknown kinds are rejected without a row', async () => {
  const runtime = await freshRuntime();
  try {
    const res = runtime.queueLeadProposal({ kind: 'launch-missiles', payload: {} });
    assert.equal(res.ok, false);
    assert.match(res.error, /UNKNOWN_KIND/);
    assert.equal(runtime.listProposals().length, 0);
  } finally { runtime.db.close(); }
});

test('model-side approve is rejected at enqueue (executable L.1 rule 4)', async () => {
  const runtime = await freshRuntime();
  try {
    const denied = runtime.queueLeadProposal({ kind: 'approve', task_id: 'T1', payload: { to: 'DONE' }, actor: 'lead' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /AUTHORITY_DENIED/);
    assert.equal(runtime.listProposals().length, 0);
    // Human-decided approves may queue (phase 2 executes them).
    const allowed = runtime.queueLeadProposal({ kind: 'approve', task_id: 'T1', payload: { to: 'DONE' }, actor: 'human', decidedBy: 'human' });
    assert.equal(allowed.ok, true);
  } finally { runtime.db.close(); }
});

test('decision drains to the decisions table', async () => {
  const runtime = await freshRuntime();
  try {
    runtime.queueLeadProposal({ kind: 'decision', payload: { question: 'Q?', decision: 'Yes', reason: 'r' }, actor: 'lead' });
    const { applied, rejected } = runtime.drainLeadProposals();
    assert.equal(rejected.length, 0);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].kind, 'decision');
    const rows = runtime.db.prepare('SELECT * FROM decisions').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].question, 'Q?');
    assert.equal(runtime.listProposals({ status: 'queued' }).length, 0);
  } finally { runtime.db.close(); }
});

test('plan-delta drains to BACKLOG tasks', async () => {
  const runtime = await freshRuntime();
  try {
    runtime.queueLeadProposal({
      kind: 'plan-delta',
      payload: { tasks: [{ id: 'T-PLAN-1', title: 'First', objective: 'o', role: 'backend-engineer' }], reason: 'plan' },
      actor: 'lead',
    });
    const { applied, rejected } = runtime.drainLeadProposals();
    assert.equal(rejected.length, 0);
    assert.deepEqual(applied[0].tasks, ['T-PLAN-1']);
    assert.equal(runtime.getTask('T-PLAN-1').state, 'BACKLOG');
  } finally { runtime.db.close(); }
});

test('run drains to a BACKLOG task and records it', async () => {
  const runtime = await freshRuntime();
  try {
    const project = runtime.createProject({ id: 'P1', name: 'p1' });
    runtime.queueLeadProposal({
      kind: 'run',
      payload: {
        project_id: project.id,
        tasks: [{ id: 'T-RUN-1', title: 'goal', objective: 'do the thing', role: 'business-analyst' }],
      },
      actor: 'lead',
    });
    const { applied } = runtime.drainLeadProposals();
    assert.equal(applied.length, 1);
    assert.equal(applied[0].kind, 'run');
    assert.equal(runtime.getTask('T-RUN-1').state, 'BACKLOG');
  } finally { runtime.db.close(); }
});

test('drain is idempotent: second drain finds nothing queued', async () => {
  const runtime = await freshRuntime();
  try {
    runtime.queueLeadProposal({ kind: 'decision', payload: { question: 'Q', decision: 'D' }, actor: 'lead' });
    assert.equal(runtime.drainLeadProposals().applied.length, 1);
    const second = runtime.drainLeadProposals();
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.rejected, []);
  } finally { runtime.db.close(); }
});

test('dispatch proposals apply without a transition (scheduler owns dispatch)', async () => {
  const runtime = await freshRuntime();
  try {
    runtime.addTask({ id: 'T-D1', title: 't', objective: 'o', role: 'backend-engineer' });
    runtime.queueLeadProposal({ kind: 'dispatch', task_id: 'T-D1', payload: { note: 'go' }, actor: 'lead' });
    const { applied, rejected } = runtime.drainLeadProposals();
    assert.equal(rejected.length, 0);
    assert.equal(applied[0].task_id, 'T-D1');
    assert.match(applied[0].note, /scheduler owns dispatch/);
    assert.equal(runtime.getTask('T-D1').state, 'BACKLOG');
    const stored = runtime.listProposals({ status: 'applied' });
    assert.equal(stored[0].reason, 'scheduler owns dispatch');
  } finally { runtime.db.close(); }
});

test('approve rejected at enqueue unless payload.decidedBy is human', async () => {
  const runtime = await freshRuntime();
  try {
    // Top-level decidedBy is the contract path; payload.decidedBy is accepted
    // too so the human command path can attest through the payload body.
    const viaPayload = runtime.queueLeadProposal({
      kind: 'approve', task_id: 'T1',
      payload: { to: 'READY', decidedBy: 'human' }, actor: 'human',
    });
    assert.equal(viaPayload.ok, true);
    const viaModel = runtime.queueLeadProposal({
      kind: 'approve', task_id: 'T1',
      payload: { to: 'READY', decidedBy: 'model' }, actor: 'lead',
    });
    assert.equal(viaModel.ok, false);
    assert.match(viaModel.error, /AUTHORITY_DENIED/);
  } finally { runtime.db.close(); }
});

test('queued approve stays rejected through drain (never executes)', async () => {
  const runtime = await freshRuntime();
  try {
    const q = runtime.queueLeadProposal({
      kind: 'approve', task_id: 'T1',
      payload: { to: 'READY' }, decidedBy: 'human', actor: 'human',
    });
    assert.equal(q.ok, true);
    const { applied, rejected } = runtime.drainLeadProposals();
    assert.deepEqual(applied, []);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].error, /AUTHORITY_DENIED/);
    assert.equal(runtime.listProposals({ status: 'rejected' }).length, 1);
  } finally { runtime.db.close(); }
});

test('plan-delta with a failing task rejects the row and reports the error', async () => {
  const runtime = await freshRuntime();
  try {
    runtime.addTask({ id: 'T-DUP', title: 'taken', objective: 'occupies the id' });
    const q = runtime.queueLeadProposal({
      kind: 'plan-delta',
      payload: { tasks: [{ id: 'T-DUP', title: 'clash', objective: 'duplicate id' }] },
      actor: 'lead',
    });
    assert.equal(q.ok, true);
    const { applied, rejected } = runtime.drainLeadProposals();
    assert.deepEqual(applied, []);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].error, /T-DUP/);
    assert.equal(runtime.listProposals({ status: 'rejected' }).length, 1);
  } finally { runtime.db.close(); }
});

test('old-schema DB gains the proposals table on open (migrate covers existing DBs)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-lead-oldschema-'));
  try {
    const dbPath = join(dir, 'sdlc.db');
    const old = new DatabaseSync(dbPath);
    old.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)');
    old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
    old.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
    old.close();

    const { tableNames } = await core.schema();
    const { Runtime: RT } = await core.runtime();
    const rt = new RT({
      projectRoot: dir,
      config: { storage: { dbPath: '.sdlc/sdlc.db' }, safety: { instanceLock: false } },
      useLock: false,
      dbPath,
    });
    rt.open();
    try {
      assert.ok(tableNames(rt.db).includes('proposals'), 'migrate adds proposals to existing DBs');
      const q = rt.queueLeadProposal({ kind: 'dispatch', task_id: 'T-X', payload: {} });
      assert.equal(q.ok, true, 'the migrated table is writable');
    } finally { rt.close({ releaseLock: false }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
