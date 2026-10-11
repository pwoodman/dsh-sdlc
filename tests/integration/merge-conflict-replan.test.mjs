/**
 * tests/integration/merge-conflict-replan.test.mjs — spec v3 G.3.1, B.9 (L4).
 *
 * Real git: two branches editing the same file. `git merge-tree` output feeds
 * `parseMergeTreeConflicts` and `preMergeCheck`:
 *   - in-scope conflict  ⇒ action `replan` (new attempt on a rebased branch);
 *   - conflict outside `allowed_paths` ⇒ task-boundary replan (`replan_tasks`).
 * `postMergeOutcome` reverts a merge with `-m 1` when post-merge gates fail,
 * verified against a real merge commit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { core, makeRepo, addCommit, git, run, cleanup } from '../lib/helpers.mjs';

test('merge-conflict-replan: in-scope conflict ⇒ replan; out-of-scope ⇒ replan_tasks', async () => {
  const { parseMergeTreeConflicts, preMergeCheck, integrationSteps } = await core.integration();
  const repo = makeRepo({
    'src/api/x.ts': 'export const a = 1;\n',
    'src/db/y.ts': 'export const b = 1;\n',
  });
  try {
    git(['checkout', '-q', '-b', 'sdlc/task-API-001'], repo);
    addCommit(repo, { 'src/api/x.ts': 'export const a = 2; // task branch\n' }, 'task change');
    git(['checkout', '-q', 'main'], repo);
    addCommit(repo, { 'src/api/x.ts': 'export const a = 3; // integration moved\n' }, 'integration change');

    // `git merge-tree` exits 1 on conflict, so use the non-throwing runner.
    const tree = run('git', ['merge-tree', 'main', 'sdlc/task-API-001'], { cwd: repo });
    assert.notEqual(tree.status, 0, 'a conflict must make merge-tree fail');
    const conflicts = parseMergeTreeConflicts(tree.stdout);
    assert.deepEqual(conflicts, ['src/api/x.ts']);

    const inScope = preMergeCheck({ conflictFiles: conflicts, allowedPaths: ['src/api/**'] });
    assert.equal(inScope.conflict, true);
    assert.equal(inScope.withinScope, true);
    assert.equal(inScope.action, 'replan');
    assert.deepEqual(inScope.outsideScopeFiles, []);
    assert.match(inScope.reason, /rebased onto integration/);

    const outOfScope = preMergeCheck({ conflictFiles: conflicts, allowedPaths: ['src/db/**'] });
    assert.equal(outOfScope.withinScope, false);
    assert.equal(outOfScope.action, 'replan_tasks');
    assert.deepEqual(outOfScope.outsideScopeFiles, ['src/api/x.ts']);
    assert.match(outOfScope.reason, /task boundaries are wrong/);

    // The pipeline step list performs the pre-merge check before the merge.
    const steps = integrationSteps({ id: 'API-001', title: 'api', branch: 'sdlc/task-API-001' });
    assert.deepEqual(steps.map((s) => s.step), [
      'checkout-integration', 'premerge-check', 'merge', 'postmerge-gates', 'tag',
    ]);
    assert.deepEqual(steps.find((s) => s.step === 'merge').argv.slice(0, 4), ['git', 'merge', '--no-ff', 'sdlc/task-API-001']);
    assert.deepEqual(steps.find((s) => s.step === 'premerge-check').argv.slice(0, 2), ['git', 'merge-tree']);

    // NEGATIVE CONTROL: no conflict ⇒ merge.
    assert.deepEqual(preMergeCheck({ conflictFiles: [], allowedPaths: ['src/api/**'] }), {
      conflict: false, files: [], withinScope: true, action: 'merge',
    });
  } finally {
    cleanup(repo);
  }
});

test('merge-conflict-replan: postMergeOutcome reverts with `-m 1` on gate failure', async () => {
  const { postMergeOutcome } = await core.integration();
  const repo = makeRepo({ 'f.txt': 'base\n' });
  try {
    git(['checkout', '-q', '-b', 'sdlc/task-T-1'], repo);
    addCommit(repo, { 'f.txt': 'task\n' }, 'task');
    git(['checkout', '-q', 'main'], repo);
    addCommit(repo, { 'other.txt': 'integration\n' }, 'integration');

    git(['merge', '--no-ff', 'sdlc/task-T-1', '-m', 'sdlc: accept T-1 (task)'], repo);
    assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'task\n');

    // Post-merge gates fail ⇒ revert the merge commit with `-m 1`.
    const outcome = postMergeOutcome({ gatesPass: false, mergeCommit: 'HEAD', failedTasks: ['T-1'] });
    assert.equal(outcome.action, 'revert');
    assert.equal(outcome.reason, 'POST_MERGE_GATE_FAILURE');
    assert.deepEqual(outcome.argv, ['git', 'revert', '-m', '1', 'HEAD']);
    assert.deepEqual(outcome.failedTasks, ['T-1']);

    git(outcome.argv.slice(1), repo);
    assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'base\n', 'the merge was reverted');

    // NEGATIVE CONTROL: green gates ⇒ done (no revert).
    assert.deepEqual(postMergeOutcome({ gatesPass: true, mergeCommit: 'HEAD' }), { action: 'done', tag: true });
  } finally {
    cleanup(repo);
  }
});
