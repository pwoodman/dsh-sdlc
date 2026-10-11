#!/usr/bin/env node
/**
 * scripts/validate-m2.mjs — M2 gate: execute (spec v3 D.0).
 *
 * Worktree lifecycle (create → bootstrap → dispose) in a REAL repository;
 * parallel independent tasks; resource-locked serialization; out-of-scope write
 * auto-fail; orphan salvage on restart; and the OS-level instance lock that
 * makes "two orchestrators, one .sdlc/" impossible.
 *
 *   node scripts/validate-m2.mjs [--json <path>] [--fail-fast]
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSuite, EXIT } from './lib/harness.mjs';
import { git, makeRepo, testConfig, openRuntime, importPkg, withDir } from './lib/gate-helpers.mjs';

const workerResult = await importPkg('packages/sdlc-core/src/worker-result.js');
const verifier = await importPkg('packages/sdlc-core/src/verifier.js');
const scheduler = await importPkg('packages/sdlc-core/src/scheduler.js');
const recovery = await importPkg('packages/sdlc-core/src/recovery.js');
const { InstanceLock, InstanceLockedError } = await importPkg('packages/sdlc-core/src/instance-lock.js');
const { Runtime } = await importPkg('packages/sdlc-core/src/runtime.js');

const INDEPENDENT = [
  { id: 'A-001', title: 'left', role: 'backend-engineer', allowed_paths: ['src/left/**'], verification: ['unit'] },
  { id: 'B-001', title: 'right', role: 'backend-engineer', allowed_paths: ['src/right/**'], verification: ['unit'] },
];
const LOCKED = [
  { id: 'C-001', title: 'lock one', role: 'backend-engineer', allowed_paths: ['src/c/**'], resources: ['package.json'], verification: ['unit'] },
  { id: 'D-001', title: 'lock two', role: 'backend-engineer', allowed_paths: ['src/d/**'], resources: ['package.json'], verification: ['unit'] },
];

function seedRepoWorktree(repo, taskId) {
  const wt = join(repo, '.sdlc', 'worktrees', taskId);
  git(['worktree', 'add', '-q', wt, '-b', `sdlc/task-${taskId}`, 'main'], repo);
  mkdirSync(join(wt, '.sdlc'), { recursive: true });
  // NOTE (spec E7 nuance): in a LINKED worktree `.git` is a gitfile, not a
  // directory, so `<worktree>/.git/info/exclude` does not exist. Resolve the
  // real exclude path with git and append there — still never the repository
  // .gitignore.
  const excludePath = git(['rev-parse', '--git-path', 'info/exclude'], wt);
  mkdirSync(dirname(excludePath), { recursive: true });
  appendFileSync(excludePath, '.sdlc/\n');
  writeFileSync(join(wt, '.sdlc', 'task-contract.json'), JSON.stringify({ task: { id: taskId, allowed_paths: ['src/**'] } }));
  return wt;
}

const checks = [
  {
    id: 'M2-01-worktree-lifecycle',
    title: 'git worktree create → bootstrap → dispose in a real repository',
    fn() {
      const repo = makeRepo({ 'package.json': '{"name":"x"}\n' });
      try {
        const wt = seedRepoWorktree(repo, 'T-1');
        if (!existsSync(join(wt, 'package.json'))) throw new Error('worktree has no checkout');
        if (!existsSync(join(wt, '.sdlc', 'task-contract.json'))) throw new Error('contract not materialized');
        if (!git(['branch', '--list', 'sdlc/task-T-1'], repo).includes('sdlc/task-T-1')) throw new Error('task branch missing');
        git(['worktree', 'remove', '--force', wt], repo);
        if (existsSync(wt)) throw new Error('worktree was not disposed');
        return { detail: 'created from main, contract materialized, disposed cleanly' };
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  },
  {
    id: 'M2-02-orchestrator-paths-excluded',
    title: '.git/info/exclude carries .sdlc/ and the outbox is never a scope violation (E7)',
    fn() {
      const repo = makeRepo({ 'src/a.js': 'x\n' });
      try {
        const wt = seedRepoWorktree(repo, 'T-2');
        writeFileSync(join(wt, '.sdlc', 'task-outbox.json'), '{}');
        writeFileSync(join(wt, 'src', 'a.js'), 'changed\n');
        const status = git(['status', '--porcelain'], wt);
        if (status.includes('.sdlc/')) throw new Error('.sdlc/ appears in git status — exclude not honoured');
        const scoped = workerResult.excludeOrchestratorPaths(['src/a.js', '.sdlc/task-outbox.json']);
        if (scoped.length !== 1 || scoped[0] !== 'src/a.js') throw new Error('outbox not excluded from the diff');
        if (workerResult.outOfScope(scoped, ['src/**'], []).length !== 0) throw new Error('in-scope file flagged');
        return { detail: 'excluded from git status AND from the diff-derived scope' };
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  },
  {
    id: 'M2-03-parallel-independent',
    title: 'independent tasks are dispatched in parallel up to the cap',
    fn() {
      const tasks = INDEPENDENT.map((t) => ({ ...t, state: 'READY', depends_on: [], resources: [] }));
      const step = scheduler.planStep({ tasks }, { maxParallelWorkers: 4 });
      const assigned = step.filter((t) => t.to === 'ASSIGNED').map((t) => t.taskId);
      if (assigned.length !== 2) throw new Error(`expected 2 parallel assignments, got ${JSON.stringify(assigned)}`);
      if (scheduler.checkNoOverlap(tasks.map((t) => ({ ...t, state: 'ASSIGNED' }))).length) throw new Error('independent tasks overlap');
      return { detail: 'both independent tasks assigned; no overlap' };
    },
  },
  {
    id: 'M2-04-resource-serialization',
    title: 'tasks sharing task_resources serialize (spec Test 6)',
    fn() {
      const tasks = LOCKED.map((t) => ({ ...t, state: 'READY', depends_on: [] }));
      const step = scheduler.planStep({ tasks }, { maxParallelWorkers: 8 });
      const assigned = step.filter((t) => t.to === 'ASSIGNED');
      if (assigned.length !== 1) throw new Error(`expected exactly 1 holder of package.json, got ${assigned.length}`);
      const violations = scheduler.checkNoOverlap(tasks.map((t) => ({ ...t, state: 'ASSIGNED' })), { maxSharedResourceTasks: 1 });
      if (!violations.some((v) => v.kind === 'resource-collision')) throw new Error('negative control failed: the invariant did not detect a forced collision');
      return { detail: 'one holder at a time; forced collision detected by the invariant' };
    },
  },
  {
    id: 'M2-05-scope-violation-autofail',
    title: 'an out-of-scope write auto-fails the attempt with SCOPE_VIOLATION',
    fn() {
      const result = workerResult.deriveWorkerResult({
        filesChanged: ['src/a.ts', 'src/auth/login.ts'],
        contract: { allowed_paths: ['src/**'], forbidden_paths: ['src/auth/**'] },
        claims: { status: 'completed', summary: 'sneaky' },
        runtime: { exitCode: 0 },
      });
      const scope = workerResult.scopeVerdict(result);
      if (scope.code !== 'SCOPE_VIOLATION') throw new Error(`expected SCOPE_VIOLATION, got ${scope.code}`);
      const decision = verifier.decideAcceptance({
        riskClass: 'R2',
        scope,
        gateResults: { syntax: { status: 'pass' }, lint: { status: 'pass' }, unit: { status: 'pass' }, integration: { status: 'pass' } },
        review: { verdict: 'accept' },
        filesChanged: ['src/a.ts', 'src/auth/login.ts'],
        claims: { status: 'completed' },
        runtimeStatus: 'completed',
      });
      if (decision.accept) throw new Error('the verifier accepted an out-of-scope attempt');
      if (decision.code !== 'SCOPE_VIOLATION') throw new Error(`wrong code ${decision.code}`);
      // Negative control: the same attempt in scope is accepted.
      const clean = workerResult.scopeVerdict(workerResult.deriveWorkerResult({
        filesChanged: ['src/a.ts'], contract: { allowed_paths: ['src/**'] }, runtime: { exitCode: 0 },
      }));
      if (clean.code !== 'IN_SCOPE') throw new Error('in-scope attempt misclassified');
      return { detail: 'out-of-scope ⇒ SCOPE_VIOLATION ⇒ FAILED; in-scope ⇒ IN_SCOPE' };
    },
  },
  {
    id: 'M2-06-orphan-salvage',
    title: 'orphan salvage on restart: snapshot, mark, FAIL→READY',
    fn() {
      const runs = [{ id: 'RUN-1', task_id: 'T-1', attempt: 1, pid: 999999, worktree_path: '/w', finished_at: null, status: 'running' }];
      const orphans = recovery.findOrphans({ runs, isAlive: () => false });
      if (orphans.length !== 1) throw new Error('orphan not detected');
      const plan = recovery.salvagePlan(orphans[0]);
      if (!plan.snapshotDir.includes('RUN-1')) throw new Error('snapshot path wrong');
      if (plan.transition.to !== 'FAILED') throw new Error('orphan must fail the attempt');
      if (!plan.markOrphaned) throw new Error('orphan not marked');
      if (recovery.findOrphans({ runs, isAlive: () => true }).length !== 0) throw new Error('a live worker was treated as an orphan');
      return { detail: 'dead-pid run salvaged with snapshot; live run kept' };
    },
  },
  {
    id: 'M2-07-instance-lock',
    title: 'two orchestrators cannot share one .sdlc/ (B.2.4/T5)',
    fn() {
      return withDir((dir) => {
        const a = new InstanceLock(join(dir, 'sdlc.lock'), { pid: 111, isAlive: () => true, host: 'h' });
        a.acquire();
        const b = new InstanceLock(join(dir, 'sdlc.lock'), { pid: 222, isAlive: () => true, host: 'h' });
        let blocked = false;
        try { b.acquire(); } catch (err) { blocked = err instanceof InstanceLockedError || err.code === 'INSTANCE_LOCKED'; }
        if (!blocked) throw new Error('the second orchestrator acquired the lock');
        a.release();
        const c = new InstanceLock(join(dir, 'sdlc.lock'), { pid: 333, isAlive: () => true, host: 'h' });
        if (!c.acquire().acquired) throw new Error('lock not reclaimable after a clean release');
        return { detail: 'second acquire refused; reclaimable after release' };
      }, 'sdlc-m2-lock-');
    },
  },
  {
    id: 'M2-08-runtime-two-writers',
    title: 'a second Runtime on the same .sdlc/ is refused while the first holds the lock',
    fn() {
      return withDir(async (dir) => {
        const config = testConfig({ safety: { instanceLock: true } });
        const first = await openRuntime(dir, { useLock: true, config });
        try {
          let refused = false;
          try {
            const second = new Runtime({ projectRoot: dir, config, useLock: true });
            second.open();
            second.close();
          } catch (err) {
            refused = err.code === 'INSTANCE_LOCKED' || /INSTANCE_LOCKED/.test(String(err.message));
          }
          if (!refused) throw new Error('a second Runtime opened the same project');
          return { detail: 'the second writer is refused' };
        } finally { first.close({ releaseLock: false }); }
      }, 'sdlc-m2-runtime-');
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M2 execution gate', version: '1.0.0', checks }));
