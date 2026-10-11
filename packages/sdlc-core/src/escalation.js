/**
 * packages/sdlc-core/src/escalation.js — user escalation & decision blocks (spec v3 B.7).
 *
 * Platform constraint (P26): approvals are TURN-ENCLOSED and need a live agent.
 * Escalation is therefore: persist the decision block → set BLOCKED → queue a
 * round prompt to the Lead → the Lead calls ctx.approval.request() inside that
 * turn. No background timer ever prompts the user, and an unattached answerer
 * resolves `unavailable`, leaving the state BLOCKED (fail-closed).
 */

import { nextLadderStep } from './loop.js';

export const ESCALATION_TRIGGERS = [
  'ambiguous_architecture',
  'conflicting_requirements',
  'security_risk_r4',
  'loop_unresolved',
  'missing_credentials',
  'missing_external_dependency',
  'destructive_operation',
  'production_impacting',
  'budget_exhausted',
  'no_eligible_model',
];

/**
 * Build the decision block presented to the user (spec §45: options +
 * recommendation + rationale).
 */
export function buildDecisionBlock({
  id,
  trigger,
  question,
  options = [],
  recommendation = null,
  rationale = '',
  taskId = null,
  projectId = null,
  evidence = {},
} = {}) {
  if (!ESCALATION_TRIGGERS.includes(trigger)) {
    throw new Error(`unknown escalation trigger: ${trigger}`);
  }
  return {
    id,
    trigger,
    task_id: taskId,
    project_id: projectId,
    question,
    options: options.map((o) => ({ id: o.id, label: o.label, effect: o.effect ?? null })),
    recommendation,
    rationale,
    evidence,
    created_at: new Date().toISOString(),
  };
}

/** The escalation ladder position for a set of failed attempts (B.6/B.7). */
export function escalationLevel(attempts = [], { maxFailedAttempts = 3, loopThreshold = 2 } = {}) {
  const failed = attempts.filter((a) => a.status !== 'success').length;
  if (failed >= maxFailedAttempts) return 'ELEVATED';
  if (failed >= loopThreshold) return 'BASE';
  return 'CHEAP';
}

/** Cheapest→elevated→architecture→user progression, no repeats. */
export function advanceLevel(current, unresolved) {
  if (!unresolved) return current;
  return nextLadderStep(current);
}

/** Normalize an approval outcome. Anything but `allowed-once` is fail-closed. */
export function normalizeApprovalOutcome(outcome) {
  switch (outcome) {
    case 'allowed-once': return { allowed: true, resolution: 'approved' };
    case 'rejected': return { allowed: false, resolution: 'rejected' };
    case 'cancelled': return { allowed: false, resolution: 'cancelled' };
    case 'unavailable': return { allowed: false, resolution: 'unavailable', failClosed: true };
    default: return { allowed: false, resolution: 'unavailable', failClosed: true };
  }
}

/**
 * Delivery plan for an escalation. `mode` mirrors the C.2 deployment table:
 * only mode 1 (interactive lead) can grant authority.
 */
export function planEscalation(block, { mode = 'interactive' } = {}) {
  if (mode !== 'interactive') {
    return {
      deliver: false,
      reason: 'headless deployment cannot unblock itself (fail-closed, C.2/L.5)',
      state: 'BLOCKED',
      block,
    };
  }
  return {
    deliver: true,
    state: 'BLOCKED',
    roundPrompt: `SDLC escalation ${block.id}: ${block.question}\nRecommendation: ${block.recommendation ?? 'none'}\nAsk the user via ctx.approval.request() and record the outcome.`,
    block,
  };
}

/** Apply a decision to a blocked task/project. */
export function applyResolution({ resolution, optionId = null, decidedBy = null } = {}) {
  if (!['approved', 'rejected', 'cancelled', 'unavailable'].includes(resolution)) {
    throw new Error(`invalid resolution: ${resolution}`);
  }
  const unblock = resolution === 'approved';
  return {
    resolution,
    optionId,
    decidedBy,
    taskTo: unblock ? 'READY' : 'BLOCKED',
    projectTo: unblock ? null : 'BLOCKED',
  };
}

export default {
  buildDecisionBlock, escalationLevel, advanceLevel, normalizeApprovalOutcome, planEscalation, applyResolution,
  ESCALATION_TRIGGERS,
};
