/**
 * tests/fault/corrupt-outbox.test.mjs — L5 fault matrix rows: truncated/corrupt
 * outbox and outbox nonce mismatch (spec v3 B.3.2, K.5).
 *
 * The outbox is a worker-controlled channel: it may be truncated, or it may be
 * another run's document. Either way the runtime derives RESULT_MALFORMED or
 * `suspect` and verification must refuse ACCEPTED. The fenced block in the
 * uncapped `final` event is the documented fallback channel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const wr = await core.workerResult();
const { buildOutbox, ingestOutbox, parseFencedBlock, resolveClaims, deriveWorkerResult, scopeVerdict } = wr;
const { decideAcceptance } = await core.verifier();

const CONTRACT = { allowed_paths: ['src/**'], forbidden_paths: [] };

test('a truncated outbox yields RESULT_MALFORMED and the attempt is counted', () => {
  const truncated = '{"schemaVersion":1,"runId":"R1","taskId":"T1","attempt":0,"nonce":"n","status":"comple';

  const ing = ingestOutbox(truncated);
  assert.equal(ing.valid, false);
  assert.match(ing.error, /RESULT_MALFORMED/);

  const claims = resolveClaims({ outboxRaw: truncated });
  assert.equal(claims.source, 'none');
  assert.equal(claims.claims.__malformed, true);

  const result = deriveWorkerResult({
    filesChanged: ['src/api/app.js'],
    contract: CONTRACT,
    claims: claims.claims,
    runtime: { exitCode: 1, turnEndReason: 'error', attempt: 2 },
  });
  assert.equal(result.result_malformed, true);
  assert.equal(result.attempt, 2, 'the attempt number is carried even for a malformed result');
  assert.equal(scopeVerdict(result).code, 'RESULT_MALFORMED');

  // A missing attempt field is itself malformed — the attempt is mandatory.
  const noAttempt = ingestOutbox({ schemaVersion: 1, runId: 'R1', taskId: 'T1', nonce: 'n' });
  assert.equal(noAttempt.valid, false);
  assert.match(noAttempt.error, /attempt missing/);
});

test('the fenced-block fallback in the uncapped final event is attempted', () => {
  const truncated = '{"schemaVersion":1,"runId":"R1","taskId":"T1","attempt":0,"nonce":"n","status":"comple';
  const finalText = 'partial work completed\n```sdlc-result\n'
    + '{"status":"completed","summary":"recovered via the final event","tests_run":["unit"],"requests":[]}\n```';

  const parsed = parseFencedBlock(finalText);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.claims.status, 'completed');

  const claims = resolveClaims({ outboxRaw: truncated, finalText });
  assert.equal(claims.source, 'fenced', 'the fallback channel is used when the outbox is unparseable');
  assert.equal(claims.claims.status, 'completed');

  const result = deriveWorkerResult({ filesChanged: [], contract: CONTRACT, claims: claims.claims, runtime: { exitCode: 0, attempt: 0 } });
  assert.equal(result.result_malformed, false);
  assert.equal(result.status, 'completed');

  // A fenced block that is not JSON is malformed too.
  assert.equal(parseFencedBlock('```sdlc-result\nnot json\n```').valid, false);
  assert.equal(resolveClaims({ outboxRaw: truncated, finalText: '```sdlc-result\nnot json\n```' }).claims.__malformed, true);
});

test('a foreign or duplicated nonce marks claims suspect and verification refuses ACCEPTED', () => {
  const outbox = buildOutbox({
    runId: 'R1', taskId: 'T1', attempt: 0, nonce: 'NONCE-A',
    claims: { status: 'completed', summary: 'looks fine' },
  });
  const raw = JSON.stringify(outbox);

  // Foreign nonce: the document is valid but was minted for a different run.
  const foreign = ingestOutbox(raw, { runId: 'R1', taskId: 'T1', attempt: 0, nonce: 'NONCE-B' });
  assert.equal(foreign.valid, true);
  assert.equal(foreign.suspect, true);

  // Duplicated nonce: run R2 replays run R1's outbox.
  const duplicated = ingestOutbox(raw, { runId: 'R2', taskId: 'T2', attempt: 0, nonce: 'NONCE-A' });
  assert.equal(duplicated.valid, true);
  assert.equal(duplicated.suspect, true, 'a reused nonce is suspect');

  const claims = resolveClaims({ outboxRaw: raw, runMeta: { runId: 'R2', taskId: 'T2', attempt: 0, nonce: 'NONCE-A' } });
  assert.equal(claims.suspect, true);
  assert.equal(claims.claims.__suspect, true);

  const result = deriveWorkerResult({ filesChanged: [], contract: CONTRACT, claims: claims.claims, runtime: { exitCode: 0, attempt: 0 } });
  assert.equal(result.suspect, true);
  assert.equal(result.worker_claimed_status, 'completed');

  const decision = decideAcceptance({
    riskClass: 'R1',
    gateResults: { unit: { status: 'pass' } },
    scope: scopeVerdict(result),
    claims: claims.claims,
    filesChanged: result.files_changed,
    runtimeStatus: 'completed',
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.code, 'RESULT_MALFORMED');
  assert.match(decision.reasons.join(' '), /suspect/);
});
