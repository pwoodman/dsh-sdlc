/**
 * tests/fault/orphan-and-kill.test.mjs — L5 fault matrix rows: worker SIGKILL
 * mid-edit / orchestrator SIGKILL mid-dispatch (spec v3 B.12, K.5).
 *
 * `recovery.findOrphans` must mark a run whose pid is dead; `salvagePlan` must
 * snapshot the partial worktree into `.sdlc/recovery/<runId>` and drive the task
 * FAILED → READY with the snapshot as evidence. No merge may be attempted from
 * that path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  tempDir, cleanup, core, makeRepo, run,
  spawnSync, join, dirname, writeFileSync, readFileSync, mkdirSync,
} from '../lib/helpers.mjs';

const { findOrphans, salvagePlan, reconcile } = await core.recovery();
const { TaskStateService, isLegalTransition, legalTargets } = await core.stateMachine();

/** Execute the salvage plan's argv commands for real in the worktree. */
function executeSalvage(plan, cwd) {
  const runs = [];
  for (const c of plan.commands) {
    // run() widens PATH for bare commands (helpers.mjs CI-hardening), so the
    // salvage `git` invocations resolve under thin worker PATHs too.
    const res = run(c.argv[0], c.argv.slice(1), { cwd });
    if (c.capture) {
      mkdirSync(dirname(join(cwd, c.capture)), { recursive: true });
      writeFileSync(join(cwd, c.capture), res.stdout ?? '');
    }
    runs.push({ step: c.step, status: res.status });
  }
  return runs;
}

test('a killed worker run is snapshotted, FAILED → READY, and never merged', () => {
  const repo = makeRepo({ 'src/app.js': 'v1\n', 'README.md': 'x\n' });
  const svc = new TaskStateService(':memory:');
  try {
    // The worker was killed mid-edit: the worktree holds uncommitted partial work.
    writeFileSync(join(repo, 'src/app.js'), 'v2 partial edit by a killed worker\n');

    const orphans = findOrphans({
      runs: [
        { id: 'R1', task_id: 'T1', attempt: 0, pid: 999999, status: 'running', worktree_path: repo },
        { id: 'R2', task_id: 'T2', attempt: 0, pid: null, status: 'completed', finished_at: '2020-01-01T00:00:00.000Z', worktree_path: repo },
      ],
      isAlive: () => false,
      worktreeExists: () => true,
    });
    assert.equal(orphans.length, 1, 'only the dead, unfinished run is an orphan');
    assert.equal(orphans[0].runId, 'R1');
    assert.equal(orphans[0].taskId, 'T1');
    assert.equal(orphans[0].reason, 'dead-pid');
    assert.equal(orphans[0].worktreeMissing, false);

    const plan = salvagePlan(orphans[0]);
    assert.equal(plan.snapshotDir, '.sdlc/recovery/R1');
    assert.equal(plan.markOrphaned, true);
    assert.equal(plan.transition.to, 'FAILED');
    assert.equal(plan.transition.actor, 'recovery');
    assert.equal(plan.transition.reason, 'ORPHAN_SALVAGE');
    assert.ok(
      plan.commands.some((c) => c.capture === '.sdlc/recovery/R1/diff.patch'),
      'the plan must capture the worktree diff',
    );
    assert.ok(
      plan.commands.some((c) => c.capture === '.sdlc/recovery/R1/status.txt'),
      'the plan must capture the worktree status',
    );
    assert.ok(
      !plan.commands.some((c) => c.step === 'merge' || (c.argv ?? []).includes('merge')),
      'salvage must not attempt a merge',
    );

    // Execute the plan: the partial work is preserved as evidence.
    const ran = executeSalvage(plan, repo);
    assert.ok(ran.every((r) => r.status === 0), `salvage commands failed: ${JSON.stringify(ran)}`);
    const diffPath = join(repo, '.sdlc/recovery/R1/diff.patch');
    const statusPath = join(repo, '.sdlc/recovery/R1/status.txt');
    assert.ok(existsSync(diffPath));
    assert.ok(existsSync(statusPath));
    assert.match(readFileSync(diffPath, 'utf8'), /src\/app\.js/, 'snapshot captures the partial edit');

    // The task transitions FAILED → READY with the snapshot as evidence.
    svc._setState('T1', 'IN_PROGRESS');
    const failed = svc.transition('T1', 'FAILED', 'worker-mgr', {
      hardFailure: true,
      payload: { snapshotDir: plan.snapshotDir, orphanedRun: orphans[0].runId },
    });
    assert.equal(failed.ok, true, failed.reason);
    const ready = svc.transition('T1', 'READY', 'scheduler', {
      attempt: 0,
      retryBudget: 2,
      retryBudgetRemaining: true,
      payload: { snapshotDir: plan.snapshotDir, salvage: true },
    });
    assert.equal(ready.ok, true, ready.reason);
    assert.equal(svc.getState('T1'), 'READY');
    assert.equal(svc.getTask('T1').attempt, 1, 'the retry consumed one attempt');

    const events = svc.getEvents('T1');
    assert.deepEqual(events.map((e) => e.action), ['IN_PROGRESS→FAILED', 'FAILED→READY']);
    assert.ok(
      events.every((e) => JSON.parse(e.payload_json).snapshotDir === '.sdlc/recovery/R1'),
      'every recovery event carries the snapshot evidence',
    );

    // No merge was attempted anywhere on this path.
    assert.equal(isLegalTransition('FAILED', 'MERGING', 'integration-mgr'), false);
    assert.equal(isLegalTransition('READY', 'MERGING', 'integration-mgr'), false);
    assert.ok(!legalTargets('FAILED').includes('MERGING'));
    assert.ok(!legalTargets('READY').includes('MERGING'));
  } finally {
    svc.close();
    cleanup(repo);
  }
});

test('reconcile records a dead-worker discrepancy and routes it to FAILED with evidence', () => {
  const out = reconcile({
    tasks: [{ id: 'T1', state: 'IN_PROGRESS', branch: 'sdlc/T1', worktree_path: '/tmp/wt' }],
    runs: [{ id: 'R1', task_id: 'T1', pid: 999999, finished_at: null }],
    isAlive: () => false,
    worktreeExists: () => true,
    branchExists: () => true,
  });
  const dead = out.discrepancies.find((d) => d.kind === 'dead-worker');
  assert.ok(dead, 'dead worker discrepancy recorded');
  assert.equal(dead.taskId, 'T1');
  const t = out.transitions.find((x) => x.taskId === 'T1' && x.to === 'FAILED');
  assert.ok(t, 'recovery transitions the task to FAILED');
  assert.equal(t.evidence, 'ORPHAN_SALVAGE');
});
