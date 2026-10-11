/**
 * tests/unit/worker-result.test.mjs — WorkerResult derivation (spec v3 B.3.2, E7, G.2.5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const wr = await core.workerResult();

test('orchestrator paths are excluded from files_changed (E7)', () => {
  const changed = ['src/a.ts', '.sdlc/task-outbox.json', '.dsh/state.json', '.sdlc/verification/T/unit.log'];
  assert.deepEqual(wr.excludeOrchestratorPaths(changed), ['src/a.ts']);
});

test('out_of_scope_files = diff minus allowed_paths, after the exclusion', () => {
  assert.deepEqual(wr.outOfScope(['src/a.ts'], ['src/**'], []), []);
  assert.deepEqual(wr.outOfScope(['src/a.ts', 'other/b.ts'], ['src/**'], []), ['other/b.ts']);
  assert.deepEqual(wr.outOfScope(['src/auth/login.ts'], ['src/**'], ['src/auth/**']), ['src/auth/login.ts']);
  assert.deepEqual(wr.outOfScope(['.sdlc/task-outbox.json'], ['src/**'], []), [], 'the outbox is never a violation');
});

test('normalization dedupes, sorts and drops unsafe paths', () => {
  assert.deepEqual(wr.parseGitNames('b.ts\na.ts\nb.ts\n\n'), ['a.ts', 'b.ts']);
  assert.deepEqual(wr.excludeOrchestratorPaths(['../escape', 'a.ts']), ['a.ts']);
});

test('git porcelain output is parsed correctly', () => {
  assert.deepEqual(wr.parseGitNames('M\tsrc/a.ts\nA\tsrc/b.ts\n'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(wr.parseGitNames('R  src/old.ts\tsrc/new.ts'), ['src/new.ts']);
});

test('status is runtime-derived from exit code + turn_end, never worker-claimed', () => {
  assert.equal(wr.deriveStatus({ exitCode: 0 }), 'completed');
  assert.equal(wr.deriveStatus({ exitCode: 0, turnEndReason: 'completed' }), 'completed');
  assert.equal(wr.deriveStatus({ exitCode: 1, turnEndReason: 'error' }), 'failed');
  assert.equal(wr.deriveStatus({ exitCode: 1, turnEndReason: 'aborted' }), 'aborted');
  assert.equal(wr.deriveStatus({ exitCode: 1, signal: 'SIGKILL' }), 'timeout');
  assert.equal(wr.deriveStatus({ exitCode: 0, timedOut: true }), 'timeout');

  const result = wr.deriveWorkerResult({
    filesChanged: ['src/a.ts'],
    contract: { allowed_paths: ['src/**'] },
    claims: { status: 'completed', summary: 'done' },
    runtime: { exitCode: 1, turnEndReason: 'error' },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.worker_claimed_status, 'completed', 'the claim is preserved but not authoritative');
});

test('a worker claim never overrides the git-derived file list', () => {
  const result = wr.deriveWorkerResult({
    filesChanged: ['src/a.ts'],
    contract: { allowed_paths: ['src/**'] },
    claims: { summary: 'I also changed src/secret.ts' },
    runtime: { exitCode: 0 },
  });
  assert.deepEqual(result.files_changed, ['src/a.ts']);
});

test('scopeVerdict maps to SCOPE_VIOLATION / RESULT_MALFORMED / IN_SCOPE', () => {
  const good = wr.deriveWorkerResult({ filesChanged: ['src/a.ts'], contract: { allowed_paths: ['src/**'] }, runtime: { exitCode: 0 } });
  assert.deepEqual(wr.scopeVerdict(good), { ok: true, code: 'IN_SCOPE' });
  const bad = wr.deriveWorkerResult({ filesChanged: ['other/b.ts'], contract: { allowed_paths: ['src/**'] }, runtime: { exitCode: 0 } });
  assert.equal(wr.scopeVerdict(bad).code, 'SCOPE_VIOLATION');
  assert.deepEqual(wr.scopeVerdict(bad).files, ['other/b.ts']);
  const malformed = wr.deriveWorkerResult({ claims: { __malformed: true } });
  assert.equal(wr.scopeVerdict(malformed).code, 'RESULT_MALFORMED');
});

test('outbox prototype: build → ingest round-trip with matching provenance', () => {
  const env = wr.buildOutbox({ runId: 'R1', taskId: 'T1', attempt: 2, nonce: 'abc', claims: { status: 'completed', summary: 'ok' } });
  assert.equal(env.schemaVersion, 1);
  const ingested = wr.ingestOutbox(env, { runId: 'R1', taskId: 'T1', attempt: 2, nonce: 'abc' });
  assert.equal(ingested.valid, true);
  assert.equal(ingested.suspect, false);
  assert.equal(ingested.claims.status, 'completed');
});

test('outbox provenance: a foreign or replayed nonce marks the claims suspect', () => {
  const env = wr.buildOutbox({ runId: 'R1', taskId: 'T1', attempt: 1, nonce: 'abc', claims: { status: 'completed' } });
  assert.equal(wr.ingestOutbox(env, { runId: 'R1', taskId: 'T1', attempt: 1, nonce: 'zzz' }).suspect, true);
  assert.equal(wr.ingestOutbox(env, { runId: 'R2', taskId: 'T1', attempt: 1, nonce: 'abc' }).suspect, true);
  assert.equal(wr.ingestOutbox(env, { runId: 'R1', taskId: 'T2', attempt: 1, nonce: 'abc' }).suspect, true);
  assert.equal(wr.ingestOutbox(env, { runId: 'R1', taskId: 'T1', attempt: 9, nonce: 'abc' }).suspect, true);
});

test('outbox schema violations are RESULT_MALFORMED', () => {
  assert.equal(wr.ingestOutbox('{ not json').valid, false);
  assert.match(wr.ingestOutbox('{ not json').error, /RESULT_MALFORMED/);
  assert.equal(wr.ingestOutbox({ schemaVersion: 1 }).valid, false);
  assert.equal(wr.ingestOutbox(wr.buildOutbox({ runId: 'R', taskId: 'T', attempt: 0, nonce: 'n', claims: {} })).valid, true);
});

test('fenced block fallback parses the last sdlc-result block', () => {
  const text = 'work done\n```sdlc-result\n{"status":"completed","summary":"first","tests_run":[],"requests":[]}\n```\nmore\n```sdlc-result\n{"status":"completed","summary":"last","tests_run":["unit"],"requests":[]}\n```';
  const parsed = wr.parseFencedBlock(text);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.claims.summary, 'last');
  assert.equal(wr.parseFencedBlock('no block here').valid, false);
  assert.equal(wr.parseFencedBlock('```sdlc-result\n{oops}\n```').valid, false);
});

test('channel precedence: a valid outbox wins; disagreement marks suspect (B.3.2)', () => {
  const outboxRaw = wr.buildOutbox({ runId: 'R1', taskId: 'T1', attempt: 1, nonce: 'n', claims: { status: 'completed', summary: 'outbox' } });
  const agreeing = wr.resolveClaims({ outboxRaw, finalText: '```sdlc-result\n{"status":"completed","summary":"outbox","evidence_claims":[],"tests_run":[],"requests":[]}\n```', runMeta: { runId: 'R1', taskId: 'T1', attempt: 1, nonce: 'n' } });
  assert.equal(agreeing.source, 'outbox');
  assert.equal(agreeing.suspect, false);

  const disagreeing = wr.resolveClaims({ outboxRaw, finalText: '```sdlc-result\n{"status":"failed","summary":"fenced"}\n```', runMeta: {} });
  assert.equal(disagreeing.source, 'outbox');
  assert.equal(disagreeing.suspect, true);

  const fencedOnly = wr.resolveClaims({ finalText: '```sdlc-result\n{"status":"completed","summary":"fenced"}\n```' });
  assert.equal(fencedOnly.source, 'fenced');
  assert.equal(fencedOnly.suspect, false);

  const neither = wr.resolveClaims({});
  assert.equal(neither.source, 'none');
  assert.equal(neither.claims.__malformed, true);
});
