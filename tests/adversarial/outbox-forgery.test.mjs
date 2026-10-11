/**
 * tests/adversarial/outbox-forgery.test.mjs — L6 threat T2: a worker forges a
 * successful result (spec v3 B.3.2, K.7, L.4 T2).
 *
 * The DIFF owns truth (L.1 rule 2): `files_changed` is derived from real git,
 * never from the worker's outbox. A forged `completed` status for a failed run
 * is a FALSE_DONE_CLAIM; an out-of-scope file is a SCOPE_VIOLATION.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, core, makeRepo, git } from '../lib/helpers.mjs';

const { buildOutbox, resolveClaims, deriveWorkerResult, scopeVerdict } = await core.workerResult();
const { decideAcceptance } = await core.verifier();

const CONTRACT = { allowed_paths: ['src/api/**'], forbidden_paths: [] };

/** The runtime-derived truth: tracked changes vs the base, plus new files. */
function changedFilesFromGit(repo, base) {
  const tracked = git(['diff', '--name-only', base], repo).split('\n');
  const others = git(['ls-files', '--others', '--exclude-standard'], repo).split('\n');
  return [...new Set([...tracked, ...others].map((s) => s.trim()).filter(Boolean))].sort();
}

const forgedOutbox = (claims) => JSON.stringify(buildOutbox({
  runId: 'R1', taskId: 'T1', attempt: 0, nonce: 'NONCE-1', claims,
}));

test('a hand-crafted `completed` outbox cannot override a failed run (FALSE_DONE_CLAIM)', () => {
  const repo = makeRepo({ 'src/api/app.js': 'v1\n' });
  try {
    const base = git(['rev-parse', 'HEAD'], repo);
    writeFileSync(join(repo, 'src/api/app.js'), 'v2\n'); // the worker did change a file

    const claims = resolveClaims({
      outboxRaw: forgedOutbox({
        status: 'completed',
        summary: 'all acceptance criteria pass',
        evidence_claims: [{ ac_id: 'AC1', claim: 'pass', artifact: 'src/api/app.js' }],
        tests_run: ['unit'],
      }),
      runMeta: { runId: 'R1', taskId: 'T1', attempt: 0, nonce: 'NONCE-1' },
    });
    assert.equal(claims.valid, undefined); // resolveClaims returns a source envelope
    assert.equal(claims.claims.status, 'completed');

    const result = deriveWorkerResult({
      filesChanged: changedFilesFromGit(repo, base),
      contract: CONTRACT,
      claims: claims.claims,
      runtime: { exitCode: 1, turnEndReason: 'error', attempt: 0 },
    });
    assert.equal(result.status, 'failed', 'runtime status owns the run outcome');
    assert.equal(result.worker_claimed_status, 'completed', 'the lie is preserved as a claim, not as truth');
    assert.deepEqual(result.files_changed, ['src/api/app.js']);

    const decision = decideAcceptance({
      riskClass: 'R2',
      gateResults: { unit: { status: 'pass' } },
      review: { verdict: 'accept' },
      scope: scopeVerdict(result),
      claims: claims.claims,
      filesChanged: result.files_changed,
      runtimeStatus: result.status,
    });
    assert.equal(decision.accept, false);
    assert.equal(decision.code, 'FALSE_DONE_CLAIM');
    assert.match(decision.reasons.join(' '), /runtime status is failed/);
  } finally {
    cleanup(repo);
  }
});

test('claimed files the worker never touched are ignored; the git diff wins', () => {
  const repo = makeRepo({ 'src/api/app.js': 'v1\n' });
  try {
    const base = git(['rev-parse', 'HEAD'], repo);
    // No change at all in the worktree, but the outbox claims an imaginary file.
    const claims = resolveClaims({
      outboxRaw: forgedOutbox({
        status: 'completed',
        summary: 'created src/imaginary.ts',
        evidence_claims: [{ ac_id: 'AC1', claim: 'pass', artifact: 'src/imaginary.ts' }],
      }),
      runMeta: { runId: 'R1', taskId: 'T1', attempt: 0, nonce: 'NONCE-1' },
    });

    const result = deriveWorkerResult({
      filesChanged: changedFilesFromGit(repo, base),
      contract: CONTRACT,
      claims: claims.claims,
      runtime: { exitCode: 0, turnEndReason: 'completed', attempt: 0 },
    });
    assert.deepEqual(result.files_changed, [], 'the diff-derived list is empty');
    assert.equal(result.files_changed.includes('src/imaginary.ts'), false, 'the phantom file never appears');
    // The claim is preserved as DATA on the resolved envelope (data, not truth).
    assert.equal(claims.claims.evidence_claims[0].artifact, 'src/imaginary.ts');
    // FIXED (was bug #1 reported by the L6 pass): object-shaped evidence claims
    // are now preserved end to end. They remain HINTS — the authoritative file
    // list above is still empty, so acceptance never sees the phantom file as
    // real work. `result.files_changed` is what the verifier acts on.
    assert.deepEqual(result.evidence_claims, [{ ac_id: 'AC1', claim: 'pass', artifact: 'src/imaginary.ts' }]);
    assert.equal(result.files_changed.includes('src/imaginary.ts'), false);
  } finally {
    cleanup(repo);
  }
});

test('a real out-of-scope write is a SCOPE_VIOLATION regardless of the outbox', () => {
  const repo = makeRepo({ 'src/api/app.js': 'v1\n' });
  try {
    const base = git(['rev-parse', 'HEAD'], repo);
    writeFileSync(join(repo, 'src/evil.ts'), 'malicious\n'); // outside allowed_paths

    const filesChanged = changedFilesFromGit(repo, base);
    assert.ok(filesChanged.includes('src/evil.ts'));

    const claims = resolveClaims({
      outboxRaw: forgedOutbox({ status: 'completed', summary: 'looks fine' }),
      runMeta: { runId: 'R1', taskId: 'T1', attempt: 0, nonce: 'NONCE-1' },
    });
    const result = deriveWorkerResult({
      filesChanged,
      contract: CONTRACT,
      claims: claims.claims,
      runtime: { exitCode: 0, turnEndReason: 'completed', attempt: 0 },
    });
    assert.deepEqual(result.out_of_scope_files, ['src/evil.ts']);

    const scope = scopeVerdict(result);
    assert.equal(scope.ok, false);
    assert.equal(scope.code, 'SCOPE_VIOLATION');

    const decision = decideAcceptance({
      riskClass: 'R2',
      gateResults: { unit: { status: 'pass' } },
      review: { verdict: 'accept' },
      scope,
      claims: claims.claims,
      filesChanged: result.files_changed,
      runtimeStatus: 'completed',
    });
    assert.equal(decision.accept, false);
    assert.equal(decision.code, 'SCOPE_VIOLATION');
  } finally {
    cleanup(repo);
  }
});
