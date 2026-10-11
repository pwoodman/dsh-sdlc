/**
 * tests/contract/outbox.test.mjs — L3/B.3.2, the canonical result channel.
 *
 * buildOutbox/ingestOutbox round-trip, the atomic `writeOutbox` from
 * packages/sdlc-tools, and the proposal-only guarantee of createHandlers:
 * a model tool can shape a proposal, it can never grant authority (L.1 rule 4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';

import { core, tempDir, cleanup, readJson, exists } from '../lib/helpers.mjs';
import { outboxSchema, validate, formatErrors } from './schemas.mjs';

const wr = await core.workerResult();
const tools = await core.tools();

const RUN_META = { runId: 'run-77', taskId: 'API-042', attempt: 2, nonce: 'nonce-abc123' };

test('buildOutbox → ingestOutbox round-trips the envelope (matching provenance)', () => {
  const envelope = wr.buildOutbox({
    ...RUN_META,
    claims: {
      status: 'completed',
      summary: 'customers endpoint added',
      evidence_claims: [{ ac_id: 'AC1', claim: 'pass', artifact: 'tests/x.py#t' }],
      tests_run: ['pnpm test'],
      requests: ['need AUTH-001'],
    },
  });

  const schema = validate(outboxSchema, envelope);
  assert.ok(schema.ok, formatErrors(schema, 'built outbox'));
  assert.equal(envelope.schemaVersion, wr.OUTBOX_SCHEMA_VERSION);

  const ingested = wr.ingestOutbox(envelope, RUN_META);
  assert.equal(ingested.valid, true);
  assert.equal(ingested.suspect, false);
  assert.equal(ingested.claims.status, 'completed');
  assert.equal(ingested.claims.summary, 'customers endpoint added');
  assert.deepEqual(ingested.claims.tests_run, ['pnpm test']);
  assert.deepEqual(ingested.claims.evidence_claims, envelope.evidence_claims);
});

test('writeOutbox writes atomically to <worktree>/.sdlc/task-outbox.json and it passes the schema', () => {
  const worktree = tempDir('sdlc-outbox-');
  try {
    const envelope = wr.buildOutbox({ ...RUN_META, claims: { status: 'completed', summary: 'written' } });
    const target = tools.writeOutbox(worktree, envelope);

    assert.equal(target, join(worktree, '.sdlc', 'task-outbox.json'));
    assert.ok(exists(target), 'outbox exists at the canonical path');

    const entries = readdirSync(join(worktree, '.sdlc'));
    assert.deepEqual(entries.filter((f) => f.includes('.tmp-')), [], 'the atomic temp file is removed by rename');

    const onDisk = readJson(target);
    assert.deepEqual(onDisk, envelope);
    const schema = validate(outboxSchema, onDisk);
    assert.ok(schema.ok, formatErrors(schema, 'on-disk outbox'));

    // The orchestrator can ingest exactly what the worker tool wrote.
    const ingested = wr.ingestOutbox(onDisk, RUN_META);
    assert.equal(ingested.valid, true);
    assert.equal(ingested.suspect, false);
    assert.equal(ingested.claims.summary, 'written');
  } finally {
    cleanup(worktree);
  }
});

test('createHandlers.sdlc_report_result persists a schema-valid proposal (and claims accumulate)', () => {
  const worktree = tempDir('sdlc-handlers-');
  try {
    const handlers = tools.createHandlers({ worktreePath: worktree, runMeta: RUN_META });
    handlers.sdlc_claim_check({ ac_id: 'AC1', claim: 'pass', artifact: 'tests/x.py#t' });
    const res = handlers.sdlc_report_result({ status: 'completed', summary: 'all AC pass' });

    assert.equal(res.ok, true);
    const schema = validate(outboxSchema, res.envelope);
    assert.ok(schema.ok, formatErrors(schema, 'handler envelope'));
    assert.deepEqual(res.envelope.evidence_claims, [{ ac_id: 'AC1', claim: 'pass', artifact: 'tests/x.py#t' }]);

    const onDisk = readJson(join(worktree, '.sdlc', 'task-outbox.json'));
    assert.deepEqual(onDisk, res.envelope);
  } finally {
    cleanup(worktree);
  }
});

test('createHandlers.sdlc_request_decision records a non-blocking and a blocking ask', () => {
  const worktree = tempDir('sdlc-requests-');
  try {
    const handlers = tools.createHandlers({ worktreePath: worktree, runMeta: RUN_META });
    const a = handlers.sdlc_request_decision({ question: 'which table?' });
    const b = handlers.sdlc_request_decision({ question: 'need credentials', blocking: true });
    assert.equal(a.ok, true);
    assert.equal(b.blocking, true);

    const res = handlers.sdlc_report_result({ status: 'aborted', summary: 'blocked' });
    assert.equal(res.envelope.requests.length, 2);
    assert.ok(exists(join(worktree, '.sdlc', 'requests.jsonl')));
  } finally {
    cleanup(worktree);
  }
});

// ── authority is human (L.1 rule 4) ────────────────────────────────────────

test('proposal handlers never grant authority', () => {
  const worktree = tempDir('sdlc-authority-');
  try {
    const handlers = tools.createHandlers({ worktreePath: worktree, runMeta: RUN_META });

    const approve = handlers.sdlc_approve_transition({ task_id: 'API-042', to: 'ACCEPTED' });
    assert.equal(approve.ok, false);
    assert.match(approve.error, /AUTHORITY_DENIED/);

    const dispatch = handlers.sdlc_dispatch_task({ task_id: 'API-042' });
    assert.equal(dispatch.ok, false);
    assert.match(dispatch.error, /INVALID_TRANSITION/);

    // Every registered model tool is propose-only.
    for (const name of tools.ALL_TOOLS) {
      assert.equal(tools.TOOL_DEFS[name].authority, 'propose', `${name} must be propose-only`);
    }
  } finally {
    cleanup(worktree);
  }
});

test('negative control: a model tool cannot approve its own transition for any target', () => {
  const handlers = tools.createHandlers({ worktreePath: null, runMeta: RUN_META });
  for (const to of ['ACCEPTED', 'DONE', 'MERGING', 'DONE']) {
    const res = handlers.sdlc_approve_transition({ task_id: 'API-042', to });
    assert.equal(res.ok, false, `approval of ${to} must never succeed from a model tool`);
    assert.match(res.error, /AUTHORITY_DENIED/);
  }
});

test('negative control: a truncated outbox file is RESULT_MALFORMED', () => {
  const worktree = tempDir('sdlc-corrupt-');
  try {
    const dir = join(worktree, '.sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task-outbox.json'), '{"schemaVersion":1,"runId":"run-77","taskId":"API-04');

    const raw = readFileSync(join(dir, 'task-outbox.json'), 'utf8');
    const ingested = wr.ingestOutbox(raw, RUN_META);
    assert.equal(ingested.valid, false);
    assert.match(ingested.error, /RESULT_MALFORMED/);
  } finally {
    cleanup(worktree);
  }
});
