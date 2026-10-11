/**
 * tests/integration/resume-after-crash.test.mjs — spec v3 G.3.1, B.2.4, B.12 (L4).
 *
 * A Runtime is built, tasks/worker_runs are written, then it is closed WITHOUT
 * releasing the lock (a simulated crash). On reopen with `useLock: true`:
 *   - the stale lock is taken over (asserted by the lock file's holder);
 *   - state is reconstructed from the DB;
 *   - `recovery.resumePlan` reports the reconciliation transitions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

test('resume-after-crash: stale lock takeover + DB state reconstruction + resume plan', async () => {
  const { Runtime } = await core.runtime();
  const { readLock } = await core.instanceLock();
  const { resumePlan } = await core.recovery();

  const root = tempDir('sdlc-resume-');
  const lockPath = join(root, '.sdlc', 'sdlc.lock');
  let rt2 = null;
  try {
    // ── run 1: legitimate writes, then a crash (no lock release) ─────────
    const rt1 = new Runtime({ projectRoot: root, config: {}, useLock: true });
    rt1.open();
    rt1.createProject({ id: 'P1', name: 'resume' });
    rt1.addTask({ id: 'T-1', project_id: 'P1', title: 'in flight', risk_class: 'R2' });
    rt1.addTask({ id: 'T-2', project_id: 'P1', title: 'queued', risk_class: 'R2' });
    assert.equal(rt1.transition('T-1', 'READY', 'scheduler', { depStates: {} }).ok, true);
    assert.equal(rt1.transition('T-1', 'ASSIGNED', 'scheduler', { available: true }).ok, true);
    assert.equal(rt1.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {}).ok, true);
    rt1.startWorkerRun({ taskId: 'T-1', attempt: 0, pid: 999_999, worktreePath: '.sdlc/worktrees/T-1' });
    rt1.close({ releaseLock: false });

    const crashed = readLock(lockPath);
    assert.ok(crashed, 'the crash leaves a lock file behind');
    assert.equal(crashed.pid, process.pid, 'the crashed holder is this process');

    // The holder is now a DIFFERENT, dead process: simulate an old stale lock.
    const stale = {
      pid: 999_999,
      host: hostname(),
      bootId: 'dead-boot',
      startedAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
    };
    writeFileSync(lockPath, `${JSON.stringify(stale, null, 2)}\n`);

    // ── run 2: reopen with the lock ON ──────────────────────────────────
    rt2 = new Runtime({ projectRoot: root, config: {}, useLock: true });
    rt2.open();

    const takeover = readLock(lockPath);
    assert.equal(takeover.pid, process.pid, 'the lock was taken over by this process');
    assert.notEqual(takeover.bootId, 'dead-boot', 'takeover rewrites the holder record');
    assert.ok(Date.parse(takeover.startedAt) > Date.parse(stale.startedAt));

    // State is reconstructed from the DB, not from memory.
    assert.equal(rt2.getTask('T-1').state, 'IN_PROGRESS');
    assert.equal(rt2.getTask('T-2').state, 'BACKLOG');
    assert.equal(rt2.getProject('P1').name, 'resume');
    assert.equal(rt2.listWorkerRuns().length, 1);
    assert.equal(rt2.assertIntegrity(), 'ok');

    // resumePlan: the dead run reconciles to FAILED with orphan evidence.
    const plan = resumePlan({
      tasks: rt2.listTasks(),
      runs: rt2.listWorkerRuns(),
      isAlive: () => false,
      worktreeExists: () => true,
    });
    assert.equal(plan.step, 'reconcile');
    assert.equal(plan.reenterScheduler, true);
    assert.deepEqual(
      plan.transitions,
      [{ taskId: 'T-1', to: 'FAILED', actor: 'recovery', evidence: 'ORPHAN_SALVAGE' }],
    );
    assert.deepEqual(plan.discrepancies.map((d) => d.kind), ['dead-worker']);

    // ── negative control: a competing Runtime is refused while we hold it ─
    const rival = new Runtime({ projectRoot: root, config: {}, useLock: true });
    assert.throws(() => rival.open(), (err) => {
      assert.equal(err.code, 'INSTANCE_LOCKED');
      assert.equal(err.holder.pid, process.pid);
      return true;
    });
  } finally {
    if (rt2) rt2.close();
    cleanup(root);
  }
});
