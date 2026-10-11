/**
 * tests/unit/integration.test.mjs — merge pipeline decisions (spec v3 B.9, G.2.5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const it = await core.integration();

test('merge conflict output is parsed from real git merge-tree wording', () => {
  const output = [
    'CONFLICT (content): Merge conflict in src/api/users.ts',
    'CONFLICT (content): Merge conflict in package.json',
    'Auto-merging src/other.ts',
  ].join('\n');
  assert.deepEqual(it.parseMergeTreeConflicts(output), ['package.json', 'src/api/users.ts']);
});

test('an in-scope conflict re-runs as a new attempt on a rebased branch', () => {
  const check = it.preMergeCheck({ conflictFiles: ['src/api/users.ts'], allowedPaths: ['src/api/**'] });
  assert.equal(check.conflict, true);
  assert.equal(check.withinScope, true);
  assert.equal(check.action, 'replan');
  assert.match(check.reason, /rebased onto integration/);
});

test('a conflict outside allowed_paths means the task boundaries are wrong', () => {
  const check = it.preMergeCheck({ conflictFiles: ['src/api/users.ts', 'src/db/schema.ts'], allowedPaths: ['src/api/**'] });
  assert.equal(check.withinScope, false);
  assert.deepEqual(check.outsideScopeFiles, ['src/db/schema.ts']);
  assert.equal(check.action, 'replan_tasks');
});

test('no conflict ⇒ merge', () => {
  assert.deepEqual(it.preMergeCheck({ conflictFiles: [], allowedPaths: ['src/**'] }).action, 'merge');
});

test('the merge commit message and pipeline steps follow B.9', () => {
  assert.equal(it.mergeCommitMessage({ id: 'API-1', title: 'list' }), 'sdlc: accept API-1 (list)');
  const steps = it.integrationSteps({ id: 'API-1', title: 'list', branch: 'sdlc/task-API-1' });
  assert.deepEqual(steps.map((s) => s.step), ['checkout-integration', 'premerge-check', 'merge', 'postmerge-gates', 'tag']);
  const merge = steps.find((s) => s.step === 'merge');
  assert.ok(merge.argv.includes('--no-ff'), 'history stays linear with --no-ff merges');
});

test('a post-merge gate failure reverts with -m 1 (B.9 step 5)', () => {
  const outcome = it.postMergeOutcome({ gatesPass: false, mergeCommit: 'abc123', failedTasks: ['API-1'] });
  assert.equal(outcome.action, 'revert');
  assert.deepEqual(outcome.argv, ['git', 'revert', '-m', '1', 'abc123']);
  assert.equal(outcome.reason, 'POST_MERGE_GATE_FAILURE');
  assert.equal(it.postMergeOutcome({ gatesPass: true }).action, 'done');
});

test('a single merge slot is the single-writer invariant', () => {
  assert.equal(it.mergeSlotFree({ merging: [] }), true);
  assert.equal(it.mergeSlotFree({ merging: ['T1'] }), false);
});

test('the release plan runs the full gate set and requires approval when production-impacting', () => {
  const plan = it.releasePlan({ productionImpacting: true, version: '1.2.3' });
  assert.equal(plan.requiresApproval, true);
  assert.equal(plan.tag, 'release/1.2.3');
  assert.deepEqual(plan.gates, ['syntax', 'types', 'lint', 'unit', 'integration', 'api', 'e2e', 'visual', 'security', 'perf', 'build']);
  assert.equal(it.releasePlan({ productionImpacting: false }).requiresApproval, false);
});
