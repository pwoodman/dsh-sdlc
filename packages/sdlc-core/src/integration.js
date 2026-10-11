/**
 * packages/sdlc-core/src/integration.js — integration pipeline (spec v3 B.9).
 *
 * Invariants: exactly ONE writer to the integration branch (the orchestrator's
 * integration manager); nothing merges without ACCEPTED; history is linear
 * (`--no-ff` merge commits, one per task). Conflicts are never resolved
 * silently — the task fails and re-runs as a new attempt on a rebased branch.
 */

import { matchAny } from './glob-lite.js';

/** Parse `git merge-tree` / `git merge --no-commit` conflict output. */
export function parseMergeTreeConflicts(output) {
  const files = new Set();
  for (const line of String(output ?? '').split('\n')) {
    let m = line.match(/^CONFLICT \([^)]*\): .* in (.+)$/);
    if (m) { files.add(m[1].trim()); continue; }
    m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m && /<<<<<<<|>>>>>>>/.test(output)) { files.add(m[1].trim()); continue; }
    m = line.match(/^diff --cc (.+)$/);
    if (m) files.add(m[1].trim());
  }
  return [...files].sort();
}

export function mergeCommitMessage(task) {
  return `sdlc: accept ${task.id} (${task.title ?? task.id})`;
}

/**
 * Pre-merge check. A conflict inside `allowed_paths` is the task owner's work
 * (a new attempt on a rebased branch); a conflict OUTSIDE them means the task
 * boundaries are wrong and the planner must split/rewrite the task.
 */
export function preMergeCheck({ conflictFiles = [], allowedPaths = [] } = {}) {
  if (conflictFiles.length === 0) return { conflict: false, files: [], withinScope: true, action: 'merge' };
  const outside = conflictFiles.filter((f) => matchAny(allowedPaths, f) === null);
  return {
    conflict: true,
    files: conflictFiles,
    withinScope: outside.length === 0,
    outsideScopeFiles: outside,
    action: outside.length === 0 ? 'replan' : 'replan_tasks',
    reason: outside.length === 0
      ? 'CONFLICT: re-run as a new attempt on a branch rebased onto integration'
      : 'CONFLICT outside allowed_paths: task boundaries are wrong — re-plan',
  };
}

/** Full per-task pipeline as an ordered, executable step list. */
export function integrationSteps(task, { mergeBase = null } = {}) {
  return [
    { step: 'checkout-integration', argv: ['git', 'checkout', 'sdlc/integration'] },
    { step: 'premerge-check', argv: ['git', 'merge-tree', mergeBase ?? 'sdlc/integration', task.branch] },
    { step: 'merge', argv: ['git', 'merge', '--no-ff', task.branch, '-m', mergeCommitMessage(task)] },
    { step: 'postmerge-gates', argv: null },
    { step: 'tag', argv: ['git', 'tag', `sdlc/accepted/${task.id}`] },
  ];
}

/**
 * Post-merge outcome. A gate failure REVERTS the merge with `-m 1` and fails
 * the involved tasks with the gate evidence (B.9 step 5).
 */
export function postMergeOutcome({ gatesPass, mergeCommit, failedTasks = [] } = {}) {
  if (gatesPass) return { action: 'done', tag: true };
  return {
    action: 'revert',
    argv: ['git', 'revert', '-m', '1', mergeCommit ?? 'HEAD'],
    failedTasks,
    reason: 'POST_MERGE_GATE_FAILURE',
  };
}

/** Only one merge at a time (single writer). */
export function mergeSlotFree({ merging = [] } = {}) {
  return merging.length === 0;
}

/** Release pipeline (B.9 Release): full gate set + build; approval when production-impacting. */
export function releasePlan({ productionImpacting = false, version = '0.0.0' } = {}) {
  return {
    gates: ['syntax', 'types', 'lint', 'unit', 'integration', 'api', 'e2e', 'visual', 'security', 'perf', 'build'],
    requiresApproval: productionImpacting,
    tag: `release/${version}`,
    argv: ['git', 'tag', `release/${version}`],
  };
}

export default { preMergeCheck, parseMergeTreeConflicts, integrationSteps, postMergeOutcome, releasePlan };
