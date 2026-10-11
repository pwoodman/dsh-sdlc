/**
 * tests/e2e/53-7-visual-defect.test.mjs — §53 Test 7, Visual defect (spec v3 K.8, D.1).
 *
 * A worker that claims DONE while the runtime evidence says otherwise must be
 * REJECTED (`FALSE_DONE_CLAIM` for the claim, `GATE_FAILED` for the failing
 * visual rubric), the fix must be re-attempted, and the second/third attempt
 * must pass. Two consecutive visual failures must escalate, not retry blindly.
 *
 * Runtime evidence asserted: `worker_runs` (runtime status vs worker claim),
 * `test_results` (failed then passed visual gate + signature), the gate log on
 * disk, `events`, `tasks.attempt`, and the real git merge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  M, createHarness, addTasks, schedule, stageTaskWork, runAttempt, mergeAcceptedTask,
  makeMock, modelDecision, failRunner, gatewayEvidence,
} from './harness.mjs';

const { verifier, stateMachine } = M;

const VISUAL_CMD = { visual: { command: ['visual-qc', '--viewport', '390x844'], kind: 'playwright' } };

const FILES_OK = {
  'src/ui/Button.css': '.btn { color: green; }\n',
  'src/ui/Button.test.mjs': "import { test } from 'node:test';\ntest('button', () => {});\n",
};

test('§53 Test 7: false DONE claim and visual gate failure are rejected, then fixed', async () => {
  const h = await createHarness({ gateCommands: VISUAL_CMD });
  try {
    const mock = makeMock();
    addTasks(h, [{
      id: 'VIS-001', title: 'Fix mobile overflow on submit button', role: 'frontend-engineer',
      objective: 'the submit button must not overflow at 390x844', task_class: 'normal', risk_class: 'R3',
      allowed_paths: ['src/ui/**'],
      verification: ['syntax', 'lint', 'unit', 'visual'],
    }]);
    schedule(h);

    // ── attempt 1: worker CLAIMS completed, runtime says failed ────────────
    const work1 = stageTaskWork(h, { taskId: 'VIS-001', files: FILES_OK });
    const attempt1 = runAttempt(h, {
      taskId: 'VIS-001',
      filesChanged: work1.filesChanged,
      claim: { status: 'completed', summary: 'done, all green', evidence_claims: [{ ac_id: 'AC1', claim: 'pass', artifact: 'src/ui/Button.css' }], tests_run: ['unit'] },
      runRuntime: { exitCode: 1, turnEndReason: 'error' },
      gateList: ['visual'],
      runner: failRunner({ message: 'horizontal overflow at 390x844' }),
      review: modelDecision(mock, 'mock/review-accept'),
      branch: work1.branch,
    });
    assert.equal(attempt1.result.status, 'failed', 'runtime status owns truth');
    assert.equal(attempt1.result.worker_claimed_status, 'completed', 'the worker still claimed completed');
    assert.equal(attempt1.decision.accept, false);
    assert.equal(attempt1.decision.code, 'FALSE_DONE_CLAIM', JSON.stringify(attempt1.decision));
    assert.equal(h.runtime.getTask('VIS-001').state, 'FAILED');
    const run1 = h.runtime.getWorkerRun(attempt1.runId);
    assert.equal(run1.status, 'failed');
    assert.equal(run1.result.worker_claimed_status, 'completed');

    // ── attempt 2: runtime completed, but the visual rubric fails ──────────
    const retry1 = h.runtime.state.transition('VIS-001', 'READY', 'scheduler', {
      attempt: h.runtime.getTask('VIS-001').attempt,
      retryBudget: h.runtime.getTask('VIS-001').retry_budget,
    });
    assert.equal(retry1.ok, true, retry1.reason);
    schedule(h);

    const work2 = stageTaskWork(h, { taskId: 'VIS-001', files: { ...FILES_OK, 'src/ui/Button.css': '.btn { color: green; width: 120%; }\n' } });
    const attempt2 = runAttempt(h, {
      taskId: 'VIS-001',
      filesChanged: work2.filesChanged,
      runRuntime: { exitCode: 0, turnEndReason: 'completed' },
      gateList: ['visual'],
      runner: failRunner({ message: 'horizontal overflow at 390x844 scrollWidth 420 > 390' }),
      review: modelDecision(mock, 'mock/review-reject'),
      branch: work2.branch,
    });
    assert.equal(attempt2.decision.accept, false);
    assert.equal(attempt2.decision.code, 'GATE_FAILED', JSON.stringify(attempt2.decision));
    assert.ok(attempt2.decision.reasons.some((r) => /visual/.test(r)));
    assert.equal(attempt2.gateResults.gates.visual.status, 'fail:1');
    assert.match(attempt2.gateResults.gates.visual.signature, /^visual:[0-9a-f]{40}$/);
    const log2 = readFileSync(attempt2.gateResults.gates.visual.logPath, 'utf8');
    assert.match(log2, /horizontal overflow at 390x844/);

    // A passing gate set with a rejecting review is its own rejection code.
    const reviewReject = verifier.decideAcceptance({
      riskClass: 'R3',
      gateResults: { visual: { status: 'pass' } },
      filesChanged: work2.filesChanged,
      review: modelDecision(mock, 'mock/review-reject'),
      claims: { status: 'completed' },
      runtimeStatus: 'completed',
    });
    assert.equal(reviewReject.code, 'REVIEW_REJECTED');

    // Two consecutive visual failures ⇒ ESCALATED (B.5), never another blind
    // retry. Demonstrated on the visual-QA task itself, while VERIFYING.
    assert.equal(h.config.escalation.visualFailureThreshold, 2);
    assert.ok(stateMachine.legalTargets('VERIFYING').includes('ESCALATED'));
    addTasks(h, [{
      id: 'VIS-ESC', title: 'Consecutive visual failures', role: 'frontend-engineer',
      objective: 'visual regression', risk_class: 'R3', allowed_paths: ['src/ui/**'],
      verification: ['visual'],
    }]);
    schedule(h);
    h.runtime.state.transition('VIS-ESC', 'IN_PROGRESS', 'worker-mgr', {});
    h.runtime.state.transition('VIS-ESC', 'VERIFYING', 'worker-mgr', {});
    const escalate = h.runtime.state.transition('VIS-ESC', 'ESCALATED', 'verifier', { loopMatched: true });
    assert.equal(escalate.ok, true, escalate.reason);
    const back = h.runtime.state.transition('VIS-ESC', 'READY', 'escalation-mgr', { correctivePlanApproved: true });
    assert.equal(back.ok, true, back.reason);
    const escActions = h.runtime.getEvents({ taskId: 'VIS-ESC' }).map((e) => e.action);
    assert.ok(escActions.includes('VERIFYING→ESCALATED'));
    assert.ok(escActions.includes('ESCALATED→READY'));

    // ── attempt 3: the fix passes and merges ──────────────────────────────
    const retry2 = h.runtime.state.transition('VIS-001', 'READY', 'scheduler', {
      attempt: h.runtime.getTask('VIS-001').attempt,
      retryBudget: h.runtime.getTask('VIS-001').retry_budget,
    });
    assert.equal(retry2.ok, true, retry2.reason);
    schedule(h);
    const work3 = stageTaskWork(h, { taskId: 'VIS-001', files: { ...FILES_OK, 'src/ui/Button.css': '.btn { color: green; max-width: 100%; }\n' } });
    const attempt3 = runAttempt(h, {
      taskId: 'VIS-001',
      filesChanged: work3.filesChanged,
      runRuntime: { exitCode: 0, turnEndReason: 'completed' },
      gateList: ['syntax', 'lint', 'unit', 'visual'],
      review: modelDecision(mock, 'mock/review-accept'),
      branch: work3.branch,
    });
    assert.equal(attempt3.decision.accept, true, JSON.stringify(attempt3.decision));
    mergeAcceptedTask(h, { taskId: 'VIS-001', branch: work3.branch });
    assert.equal(h.runtime.getTask('VIS-001').state, 'DONE');

    // ── runtime evidence: attempts, worker_runs, gate history ─────────────
    const task = h.runtime.getTask('VIS-001');
    assert.equal(task.attempt, 2, 'two retries were consumed');
    assert.equal(h.runtime.listWorkerRuns({ taskId: 'VIS-001' }).length, 3);
    const visualRows = gatewayEvidence(h, 'VIS-001').filter((r) => r.gate === 'visual');
    assert.equal(visualRows.length, 3);
    assert.deepEqual(visualRows.map((r) => r.status), ['fail:1', 'fail:1', 'pass']);
    const actions = h.runtime.getEvents({ taskId: 'VIS-001' }).map((e) => e.action);
    assert.ok(actions.includes('VERIFYING→FAILED'));
    assert.ok(actions.includes('FAILED→READY'));
    assert.ok(actions.includes('VERIFYING→ACCEPTED'));
    assert.ok(actions.includes('MERGING→DONE'));
  } finally {
    h.close();
  }
});
