/**
 * tests/contract/worker-result.test.mjs — L3/B.3.2 (L.1 rule 2: the diff owns truth).
 *
 * Exercises deriveWorkerResult / scopeVerdict / ingestOutbox / parseFencedBlock /
 * resolveClaims from packages/sdlc-core/src/worker-result.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { core } from '../lib/helpers.mjs';
import { workerResultSchema, validate, formatErrors } from './schemas.mjs';

const wr = await core.workerResult();

const CONTRACT = {
  allowed_paths: ['src/api/**', 'tests/api/**'],
  forbidden_paths: ['src/api/secret.js'],
};

const FENCE = (doc) => '```sdlc-result\n' + JSON.stringify(doc) + '\n```';

test('deriveWorkerResult: files_changed comes from the diff and drops orchestrator paths', () => {
  const result = wr.deriveWorkerResult({
    filesChanged: ['src/api/a.js', 'src/api/secret.js', 'src/other/b.js', '.sdlc/task-outbox.json', '.dsh/log'],
    contract: CONTRACT,
    claims: { summary: 'did work', tests_run: ['node --test tests/api'] },
    runtime: { exitCode: 0, sessionId: 's-1', attempt: 1 },
  });

  assert.deepEqual(result.files_changed, ['src/api/a.js', 'src/api/secret.js', 'src/other/b.js']);
  assert.ok(!result.files_changed.includes('.sdlc/task-outbox.json'), 'outbox write is never a scope surface');
  assert.ok(!result.files_changed.includes('.dsh/log'));

  // non-empty scope ⇒ SCOPE_VIOLATION (L.1 rule 2 / B.3.2)
  assert.deepEqual(result.out_of_scope_files, ['src/api/secret.js', 'src/other/b.js']);
  assert.deepEqual(result.forbidden_files, ['src/api/secret.js']);

  const verdict = wr.scopeVerdict(result);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'SCOPE_VIOLATION');
  assert.ok(verdict.files.includes('src/api/secret.js'));
  assert.ok(verdict.files.includes('src/other/b.js'));

  const schema = validate(workerResultSchema, result);
  assert.ok(schema.ok, formatErrors(schema, 'derived result'));
});

test('deriveWorkerResult: an in-scope diff is IN_SCOPE', () => {
  const result = wr.deriveWorkerResult({
    filesChanged: ['src/api/a.js', 'tests/api/a.test.js', './src/api/a.js', 'src/api/../src/api/a.js'],
    contract: CONTRACT,
    claims: { summary: 'ok' },
  });
  assert.deepEqual(result.files_changed, ['src/api/a.js', 'tests/api/a.test.js']);
  assert.deepEqual(result.out_of_scope_files, []);
  assert.deepEqual(result.forbidden_files, []);
  assert.deepEqual(wr.scopeVerdict(result), { ok: true, code: 'IN_SCOPE' });
});

test('deriveWorkerResult: runtime-derived status (exit code + turn_end)', () => {
  const statusOf = (runtime) => wr.deriveWorkerResult({ filesChanged: [], contract: CONTRACT, runtime }).status;
  assert.equal(statusOf({ exitCode: 0 }), 'completed');
  assert.equal(statusOf({ exitCode: 0, turnEndReason: 'completed' }), 'completed');
  assert.equal(statusOf({ exitCode: 0, turnEndReason: 'aborted' }), 'aborted');
  assert.equal(statusOf({ exitCode: 1 }), 'failed');
  assert.equal(statusOf({ timedOut: true }), 'timeout');
  assert.equal(statusOf({ exitCode: 0, signal: 'SIGKILL' }), 'timeout');
  // an explicit runtime status wins (the runtime owns state — L.1 rule 1)
  assert.equal(statusOf({ exitCode: 1, status: 'timeout' }), 'timeout');
});

test('deriveWorkerResult preserves structured evidence_claims (B.3.2)', () => {
  const claims = [
    { ac_id: 'AC1', claim: 'pass', artifact: 'tests/api/test_a.py#t' },
    { ac_id: 'AC2', claim: 'fail', artifact: 'tests/api/test_b.py#t' },
  ];
  const result = wr.deriveWorkerResult({
    filesChanged: ['src/api/a.js', 'tests/api/test_a.py'],
    contract: CONTRACT,
    claims: { evidence_claims: claims, tests_run: ['node --test'] },
  });
  assert.deepEqual([...result.evidence_claims], claims);
  assert.deepEqual(result.tests_run, ['node --test']);

  const schema = validate(workerResultSchema, result);
  assert.ok(schema.ok, formatErrors(schema, 'derived result with claims'));
});

test('scopeVerdict: a malformed result is RESULT_MALFORMED, not a scope pass', () => {
  const result = wr.deriveWorkerResult({
    filesChanged: [],
    contract: CONTRACT,
    claims: { __malformed: true },
  });
  assert.equal(result.result_malformed, true);
  assert.deepEqual(wr.scopeVerdict(result), { ok: false, code: 'RESULT_MALFORMED' });
});

test('ingestOutbox: a matching envelope is valid and not suspect', () => {
  const envelope = wr.buildOutbox({
    runId: 'run-1', taskId: 'API-042', attempt: 1, nonce: 'n-1',
    claims: { status: 'completed', summary: 'done' },
  });
  const ingested = wr.ingestOutbox(envelope, { runId: 'run-1', taskId: 'API-042', attempt: 1, nonce: 'n-1' });
  assert.equal(ingested.valid, true);
  assert.equal(ingested.suspect, false);
  assert.equal(ingested.claims.status, 'completed');
  assert.equal(ingested.claims.summary, 'done');
});

test('ingestOutbox: a foreign nonce (or run/task/attempt mismatch) marks claims suspect', () => {
  const envelope = wr.buildOutbox({ runId: 'run-1', taskId: 'API-042', attempt: 1, nonce: 'n-1' });
  const foreign = wr.ingestOutbox(envelope, { runId: 'run-1', taskId: 'API-042', attempt: 1, nonce: 'other-run-nonce' });
  assert.equal(foreign.valid, true);
  assert.equal(foreign.suspect, true, 'a mismatched nonce is forgery until proven otherwise');
  assert.equal(foreign.claims.__suspect, true);

  assert.equal(wr.ingestOutbox(envelope, { runId: 'run-2' }).suspect, true);
  assert.equal(wr.ingestOutbox(envelope, { taskId: 'OTHER-1' }).suspect, true);
  assert.equal(wr.ingestOutbox(envelope, { attempt: 9 }).suspect, true);
});

test('ingestOutbox: missing envelope fields are RESULT_MALFORMED', () => {
  const cases = [
    'not json at all',
    undefined,
    '[]',
    JSON.stringify({ schemaVersion: 1 }),
    JSON.stringify({ schemaVersion: 2, runId: 'r', taskId: 't', attempt: 0, nonce: 'n' }),
    JSON.stringify({ schemaVersion: 1, runId: 'r', taskId: 't', nonce: '' }),
  ];
  for (const raw of cases) {
    const ingested = wr.ingestOutbox(raw, {});
    assert.equal(ingested.valid, false, `expected invalid for ${String(raw).slice(0, 40)}`);
    assert.match(ingested.error, /RESULT_MALFORMED/);
  }
});

test('parseFencedBlock: reads the LAST sdlc-result block and rejects bad JSON', () => {
  const first = FENCE({ status: 'failed', summary: 'first' });
  const last = FENCE({ status: 'completed', summary: 'last', evidence_claims: [], tests_run: ['x'], requests: [] });
  const parsed = wr.parseFencedBlock(`some prose\n${first}\nmore prose\n${last}\n`);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.claims.summary, 'last');

  assert.equal(wr.parseFencedBlock('no block here').valid, false);
  const broken = wr.parseFencedBlock('```sdlc-result\n{ not json }\n```');
  assert.equal(broken.valid, false);
  assert.match(broken.error, /RESULT_MALFORMED/);
});

test('resolveClaims: a valid outbox wins over the fenced block', () => {
  const envelope = wr.buildOutbox({
    runId: 'run-1', taskId: 'API-042', attempt: 1, nonce: 'n-1',
    claims: { status: 'completed', summary: 'outbox truth', tests_run: ['a'] },
  });
  const runMeta = { runId: 'run-1', taskId: 'API-042', attempt: 1, nonce: 'n-1' };

  const agreed = wr.resolveClaims({
    outboxRaw: envelope,
    finalText: FENCE({ status: 'completed', summary: 'outbox truth', evidence_claims: [], tests_run: ['a'], requests: [] }),
    runMeta,
  });
  assert.equal(agreed.source, 'outbox');
  assert.equal(agreed.suspect, false, 'identical claims are not a disagreement');
  assert.equal(agreed.claims.summary, 'outbox truth');

  const disagreed = wr.resolveClaims({
    outboxRaw: envelope,
    finalText: FENCE({ status: 'completed', summary: 'fenced lie', evidence_claims: [], tests_run: [], requests: [] }),
    runMeta,
  });
  assert.equal(disagreed.source, 'outbox');
  assert.equal(disagreed.suspect, true, 'outbox/fenced disagreement marks claims suspect');
});

test('resolveClaims: foreign nonce ⇒ suspect even with no fenced block', () => {
  const envelope = wr.buildOutbox({ runId: 'run-1', taskId: 'API-042', attempt: 1, nonce: 'forged' });
  const resolved = wr.resolveClaims({ outboxRaw: envelope, runMeta: { nonce: 'real' } });
  assert.equal(resolved.source, 'outbox');
  assert.equal(resolved.suspect, true);
});

test('resolveClaims: malformed outbox falls back to a valid fenced block', () => {
  const fallback = wr.resolveClaims({
    outboxRaw: '{"schemaVersion":1,"runId":',
    finalText: FENCE({ status: 'completed', summary: 'fenced', evidence_claims: [], tests_run: [], requests: [] }),
    runMeta: {},
  });
  assert.equal(fallback.source, 'fenced');
  assert.equal(fallback.suspect, false);
  assert.equal(fallback.claims.summary, 'fenced');
});

test('resolveClaims: neither channel ⇒ RESULT_MALFORMED claims', () => {
  const resolved = wr.resolveClaims({ outboxRaw: 'garbage', finalText: 'no fence', runMeta: {} });
  assert.equal(resolved.source, 'none');
  assert.equal(resolved.claims.__malformed, true);
  assert.deepEqual(resolved.claims.evidence_claims, []);
});

// ── negative controls ──────────────────────────────────────────────────────

test('negative control: a worker cannot widen scope by claiming a narrow summary', () => {
  const result = wr.deriveWorkerResult({
    filesChanged: ['src/api/evil.js', 'outside/x.js'],
    contract: { allowed_paths: ['src/api/**'], forbidden_paths: [] },
    claims: { summary: 'only touched src/api', files_changed: ['src/api/a.js'] },
  });
  // the diff owns truth; worker-supplied files_changed is not an input at all
  assert.deepEqual(result.files_changed, ['outside/x.js', 'src/api/evil.js']);
  assert.equal(wr.scopeVerdict(result).code, 'SCOPE_VIOLATION');
});

test('negative control: orchestrator path exclusion does not leak into scope', () => {
  assert.deepEqual(wr.excludeOrchestratorPaths(['.sdlc/task-outbox.json', '.sdlc', '.dsh/x', 'src/a.js']), ['src/a.js']);
  assert.equal(wr.isOrchestratorPath('.sdlc/task-outbox.json'), true);
  assert.equal(wr.isOrchestratorPath('src/a.js'), false);
  // a traversal attempt is not treated as an orchestrator path (and is not in scope either)
  const result = wr.deriveWorkerResult({
    filesChanged: ['../../etc/passwd'],
    contract: { allowed_paths: ['src/**'] },
    claims: {},
  });
  assert.deepEqual(result.files_changed, [], 'unsafe paths are dropped, never allowed by exclusion');
});
