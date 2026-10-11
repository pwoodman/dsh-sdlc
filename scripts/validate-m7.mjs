#!/usr/bin/env node
/**
 * scripts/validate-m7.mjs — M7 gate: integrate (spec v3 D.0, B.9, B.12).
 *
 * Integration merge is `--no-ff`; a conflict triggers a replan (never a silent
 * resolution); a post-merge gate failure reverts the merge; resume after a kill
 * recovers state; `events` integrity holds.
 *
 *   node scripts/validate-m7.mjs [--json <path>] [--fail-fast]
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSuite, run, EXIT } from './lib/harness.mjs';
import { git, makeRepo, importPkg, withDir, testConfig, openRuntime } from './lib/gate-helpers.mjs';

const integration = await importPkg('packages/sdlc-core/src/integration.js');
const recovery = await importPkg('packages/sdlc-core/src/recovery.js');
const { Runtime } = await importPkg('packages/sdlc-core/src/runtime.js');

function prepareIntegration(repo) {
  git(['branch', 'sdlc/integration', 'main'], repo);
  git(['checkout', '-q', 'sdlc/integration'], repo);
  git(['checkout', '-q', 'main'], repo);
}

const checks = [
  {
    id: 'M7-01-no-ff-merge',
    title: 'the integration merge is --no-ff and produces one merge commit per task',
    fn() {
      const repo = makeRepo({ 'src/a.js': 'v1\n' });
      try {
        prepareIntegration(repo);
        git(['checkout', '-q', '-b', 'sdlc/task-T-1', 'main'], repo);
        writeFileSync(join(repo, 'src', 'a.js'), 'v2\n');
        git(['add', '-A'], repo);
        git(['commit', '-q', '-m', 'task work'], repo);
        git(['checkout', '-q', 'sdlc/integration'], repo);
        const steps = integration.integrationSteps({ id: 'T-1', title: 'change a', branch: 'sdlc/task-T-1' });
        const merge = steps.find((s) => s.step === 'merge');
        if (!merge.argv.includes('--no-ff')) throw new Error('the merge step is not --no-ff');
        git(['merge', '--no-ff', 'sdlc/task-T-1', '-m', integration.mergeCommitMessage({ id: 'T-1', title: 'change a' })], repo);
        const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD'], repo).split(' ');
        if (parents.length !== 3) throw new Error(`expected a merge commit with 2 parents, got ${parents.length - 1}`);
        const subject = git(['log', '-1', '--pretty=%s'], repo);
        if (subject !== 'sdlc: accept T-1 (change a)') throw new Error(`unexpected merge subject: ${subject}`);
        return { detail: 'merge commit has 2 parents and the documented subject' };
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  },
  {
    id: 'M7-02-conflict-triggers-replan',
    title: 'a merge conflict triggers a replan, never a silent resolution',
    fn() {
      const repo = makeRepo({ 'src/a.js': 'base\n' });
      try {
        prepareIntegration(repo);
        git(['checkout', '-q', '-b', 'sdlc/task-T-2', 'main'], repo);
        writeFileSync(join(repo, 'src', 'a.js'), 'task version\n');
        git(['add', '-A'], repo);
        git(['commit', '-q', '-m', 'task'], repo);
        git(['checkout', '-q', 'sdlc/integration'], repo);
        writeFileSync(join(repo, 'src', 'a.js'), 'integration version\n');
        git(['add', '-A'], repo);
        git(['commit', '-q', '-m', 'integration change'], repo);
        const dry = run('git', ['merge-tree', '--write-tree', 'HEAD', 'sdlc/task-T-2'], { cwd: repo });
        const conflicted = dry.status !== 0 || /CONFLICT|conflict/i.test(dry.stdout);
        if (!conflicted) {
          // Older git: fall back to a real merge attempt with --no-commit.
          const attempt = run('git', ['merge', '--no-commit', '--no-ff', 'sdlc/task-T-2'], { cwd: repo });
          if (attempt.status === 0) throw new Error('the conflicting merge unexpectedly succeeded');
        }
        const parsed = integration.parseMergeTreeConflicts('CONFLICT (content): Merge conflict in src/a.js');
        const check = integration.preMergeCheck({ conflictFiles: parsed, allowedPaths: ['src/**'] });
        if (!check.conflict || check.action !== 'replan') throw new Error(`conflict not replanned: ${JSON.stringify(check)}`);
        const outside = integration.preMergeCheck({ conflictFiles: ['src/a.js', 'src/db/schema.js'], allowedPaths: ['src/a/**'] });
        if (outside.withinScope) throw new Error('an out-of-scope conflict was treated as in-scope');
        // Clean up any half-merge so rmSync is safe.
        run('git', ['merge', '--abort'], { cwd: repo });
        return { detail: 'conflict detected; in-scope ⇒ replan; out-of-scope ⇒ re-plan tasks' };
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  },
  {
    id: 'M7-03-post-merge-gate-reverts',
    title: 'a post-merge gate failure reverts the merge with -m 1',
    fn() {
      const repo = makeRepo({ 'src/a.js': 'v1\n' });
      try {
        prepareIntegration(repo);
        git(['checkout', '-q', '-b', 'sdlc/task-T-3', 'main'], repo);
        writeFileSync(join(repo, 'src', 'a.js'), 'broken\n');
        git(['add', '-A'], repo);
        git(['commit', '-q', '-m', 'task'], repo);
        git(['checkout', '-q', 'sdlc/integration'], repo);
        git(['merge', '--no-ff', 'sdlc/task-T-3', '-m', 'sdlc: accept T-3'], repo);
        const mergeCommit = git(['rev-parse', 'HEAD'], repo);
        const outcome = integration.postMergeOutcome({ gatesPass: false, mergeCommit, failedTasks: ['T-3'] });
        if (outcome.action !== 'revert') throw new Error('a gate failure did not revert');
        git(outcome.argv.slice(1).map(String), repo); // git revert -m 1 <sha>
        const content = git(['show', 'HEAD:src/a.js'], repo).trim();
        if (content !== 'v1') throw new Error(`revert did not restore the pre-merge content: ${content}`);
        const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD'], repo).split(' ').length - 1;
        if (parents !== 1) throw new Error('the revert commit should have one parent');
        return { detail: 'merge reverted with -m 1; pre-merge content restored' };
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  },
  {
    id: 'M7-04-resume-after-kill',
    title: 'resume after a kill recovers state from the durable DB, not memory',
    fn() {
      return withDir(async (dir) => {
        const config = testConfig();
        const first = await openRuntime(dir, {
          config,
          tasks: [{ id: 'T-1', title: 'a', role: 'backend-engineer', allowed_paths: ['src/a/**'] }],
        });
        first.transition('T-1', 'READY', 'scheduler', { depStates: {} });
        first.transition('T-1', 'ASSIGNED', 'scheduler', { available: true });
        first.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {});
        const runId = first.startWorkerRun({ taskId: 'T-1', attempt: 0, pid: 999999, worktreePath: join(dir, '.sdlc', 'worktrees', 'T-1') });
        first.close({ releaseLock: false }); // simulated hard kill: no clean release

        const second = new Runtime({ projectRoot: dir, config: testConfig({ safety: { instanceLock: true } }), useLock: true });
        second.open();
        try {
          const plan = recovery.resumePlan({
            tasks: second.listTasks().map((t) => ({ id: t.id, state: t.state, worktree_path: t.worktree_path, branch: t.branch })),
            runs: second.listWorkerRuns(),
            isAlive: () => false,
            worktreeExists: () => false,
          });
          if (!plan.transitions.some((t) => t.taskId === 'T-1')) throw new Error('resume found no discrepancy to reconcile');
          if (second.getTask('T-1').state !== 'IN_PROGRESS') throw new Error('state was not durable across the kill');
          if (!second.getWorkerRun(runId)) throw new Error('the worker run was not durable');
          if (!second.getEvents({ taskId: 'T-1' }).some((e) => String(e.action).endsWith('→IN_PROGRESS'))) throw new Error('events were not durable');

          // Apply the reconciliation and assert the reachable state.
          const applied = second.state.transition('T-1', 'FAILED', 'recovery', { hardFailure: true });
          if (!applied.ok) throw new Error(`reconciliation failed: ${applied.reason}`);
          const retried = second.state.transition('T-1', 'READY', 'scheduler', { attempt: 0, retryBudget: 3 });
          if (!retried.ok) throw new Error(`FAILED→READY failed: ${retried.reason}`);
          return { detail: 'state, run and events durable; orphan reconciled FAILED→READY' };
        } finally { second.close({ releaseLock: false }); }
      }, 'sdlc-m7-resume-');
    },
  },
  {
    id: 'M7-05-events-integrity',
    title: 'the events log is append-only and passes the integrity check',
    fn() {
      return withDir(async (dir) => {
        const runtime = await openRuntime(dir, { config: testConfig(), tasks: [{ id: 'T-1', title: 'a', role: 'backend-engineer', allowed_paths: ['src/a/**'] }] });
        try {
          runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} });
          let mutated = false;
          try { runtime.db.prepare('DELETE FROM events').run(); mutated = true; } catch { /* expected */ }
          if (mutated) throw new Error('events are not append-only');
          const status = runtime.assertIntegrity();
          if (status !== 'ok') throw new Error(`integrity check returned ${status}`);
          const exported = runtime.getEvents();
          if (exported.length < 2) throw new Error('expected at least the project-created and transition events');
          return { detail: `${exported.length} events; append-only enforced; quick_check ok` };
        } finally { runtime.close({ releaseLock: false }); }
      }, 'sdlc-m7-integrity-');
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M7 integration gate', version: '1.0.0', checks }));
