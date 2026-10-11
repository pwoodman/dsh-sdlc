/**
 * tests/integration/scope-violation-autofail.test.mjs — spec v3 G.3.1, B.3.2, E7 (L4).
 *
 * The diff owns truth: `deriveWorkerResult` computes `files_changed` /
 * `out_of_scope_files` from the git diff, and `verifier.decideAcceptance`
 * auto-FAILs with `SCOPE_VIOLATION` before any gate or review is considered.
 *
 * E7: orchestrator-managed paths (`.sdlc/task-outbox.json`) are dropped before
 * the scope decision, so writing the result channel is NEVER a violation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const FENCED = 'done\n```sdlc-result\n'
  + '{"status":"completed","summary":"x","tests_run":[],"requests":[]}\n```';

test('scope-violation-autofail: out-of-scope file ⇒ SCOPE_VIOLATION and FAILED', async () => {
  const { deriveWorkerResult, scopeVerdict } = await core.workerResult();
  const { decideAcceptance } = await core.verifier();

  const result = deriveWorkerResult({
    filesChanged: ['src/api/customers.ts', 'src/auth/login.ts'],
    contract: { allowed_paths: ['src/api/**'], forbidden_paths: [] },
    claims: { status: 'completed' },
    runtime: { exitCode: 0, turnEndReason: 'completed' },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.files_changed, ['src/api/customers.ts', 'src/auth/login.ts']);
  assert.deepEqual(result.out_of_scope_files, ['src/auth/login.ts']);

  const scope = scopeVerdict(result);
  assert.equal(scope.ok, false);
  assert.equal(scope.code, 'SCOPE_VIOLATION');
  assert.deepEqual(scope.files, ['src/auth/login.ts']);

  // The verifier refuses immediately — even with green gates and an accept review.
  const decision = decideAcceptance({
    riskClass: 'R2',
    scope,
    gateResults: { syntax: { status: 'pass' }, unit: { status: 'pass' } },
    review: { verdict: 'accept' },
    filesChanged: result.files_changed,
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.status, 'FAILED');
  assert.equal(decision.code, 'SCOPE_VIOLATION');
  assert.match(decision.reasons.join(' '), /src\/auth\/login\.ts/);
});

test('scope-violation-autofail: `.sdlc/task-outbox.json` is never a violation (E7)', async () => {
  const { deriveWorkerResult, scopeVerdict, OUTBOX_PATH } = await core.workerResult();
  assert.equal(OUTBOX_PATH, '.sdlc/task-outbox.json');

  const result = deriveWorkerResult({
    filesChanged: [OUTBOX_PATH, '.sdlc/recovery/run-1/diff.patch', 'src/api/customers.ts', 'tests/customers.test.ts'],
    contract: { allowed_paths: ['src/api/**', 'tests/**'] },
    claims: { status: 'completed' },
    runtime: { exitCode: 0, turnEndReason: 'completed' },
  });
  assert.deepEqual(result.files_changed, ['src/api/customers.ts', 'tests/customers.test.ts'], 'orchestrator paths are dropped');
  assert.deepEqual(result.out_of_scope_files, []);
  assert.equal(scopeVerdict(result).code, 'IN_SCOPE');

  const decision = (await core.verifier()).decideAcceptance({
    riskClass: 'R2',
    scope: scopeVerdict(result),
    gateResults: { unit: { status: 'pass' } },
    review: { verdict: 'accept' },
    filesChanged: result.files_changed,
  });
  assert.equal(decision.accept, true);
  assert.equal(decision.status, 'ACCEPTED');
});
test('scope-violation-autofail: forbidden wins over allowed', async () => {
  const { deriveWorkerResult, scopeVerdict } = await core.workerResult();
  const result = deriveWorkerResult({
    filesChanged: ['src/auth/login.ts'],
    contract: { allowed_paths: ['src/**'], forbidden_paths: ['src/auth/**'] },
    claims: { status: 'completed' },
  });
  assert.deepEqual(result.forbidden_files, ['src/auth/login.ts']);
  // forbidden beats allowed: the file is a violation despite matching allowed_paths.
  assert.deepEqual(result.out_of_scope_files, ['src/auth/login.ts']);
  const scope = scopeVerdict(result);
  assert.equal(scope.code, 'SCOPE_VIOLATION');
});

test('scope-violation-autofail: NEGATIVE CONTROL — in-scope diff is accepted by scope', async () => {
  const { deriveWorkerResult, scopeVerdict } = await core.workerResult();
  const result = deriveWorkerResult({
    filesChanged: ['src/api/customers.ts'],
    contract: { allowed_paths: ['src/api/**'] },
    claims: { status: 'completed' },
  });
  assert.deepEqual(result.out_of_scope_files, []);
  const scope = scopeVerdict(result);
  assert.equal(scope.ok, true);
  assert.equal(scope.code, 'IN_SCOPE');
});

test('scope-violation-autofail: Runtime.ingestResult persists FAILED with the scope evidence', async () => {
  const { Runtime } = await core.runtime();
  const root = tempDir('sdlc-scope-');
  const rt = new Runtime({ projectRoot: root, config: {}, useLock: true });
  try {
    rt.open();
    rt.createProject({ id: 'P1', name: 'scope' });
    rt.addTask({
      id: 'API-001', project_id: 'P1', title: 'api', risk_class: 'R2',
      allowed_paths: ['src/api/**'],
    });
    const runId = rt.startWorkerRun({ taskId: 'API-001', attempt: 0, pid: process.pid });

    const ingested = rt.ingestResult({
      runId,
      filesChanged: ['src/api/customers.ts', 'src/auth/login.ts'],
      contract: { allowed_paths: ['src/api/**'], forbidden_paths: [] },
      finalText: FENCED,
      runtime: { exitCode: 0, turnEndReason: 'completed' },
    });
    assert.equal(ingested.claimsSource, 'fenced');
    assert.equal(ingested.scope.code, 'SCOPE_VIOLATION');
    assert.deepEqual(ingested.result.out_of_scope_files, ['src/auth/login.ts']);

    const stored = rt.getWorkerRun(runId);
    // `status` is the runtime-derived run status (exit 0 ⇒ completed); the
    // scope verdict is a separate, authoritative field on the same row.
    assert.equal(stored.status, 'completed');
    assert.equal(stored.result.status, 'completed');
    assert.equal(stored.result.scope.code, 'SCOPE_VIOLATION');

    // The runtime never transfers such a run to VERIFYING as accepted work.
    const reject = (await core.verifier()).decideAcceptance({
      riskClass: 'R2',
      scope: stored.result.scope,
      gateResults: { unit: { status: 'pass' } },
      review: { verdict: 'accept' },
      filesChanged: stored.result.files_changed,
    });
    assert.equal(reject.status, 'FAILED');
    assert.equal(reject.code, 'SCOPE_VIOLATION');
  } finally {
    rt.close();
    cleanup(root);
  }
});
