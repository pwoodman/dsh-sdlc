/**
 * packages/sdlc-core/src/verifier.js — acceptance decisions (spec v3 B.3.2, B.4, L.1).
 *
 * L.1 rule 3: EVIDENCE owns acceptance. A worker never accepts its own work.
 * This module is the pure decision table; the DSH service wires it to the DB.
 */

import { violatesBehavioralTestRule, requiredGates as riskRequiredGates } from './risk.js';

export const REJECTION_CODES = [
  'SCOPE_VIOLATION',
  'RESULT_MALFORMED',
  'FALSE_DONE_CLAIM',
  'NO_TEST_EVIDENCE',
  'GATE_FAILED',
  'REVIEW_REJECTED',
  'SKIPPED_GATE_NOT_PASSED',
  'NO_ELIGIBLE_MODEL',
];

/**
 * @param {object} input
 * @param {'R1'|'R2'|'R3'|'R4'} input.riskClass
 * @param {object} [input.gateResults]  from gates.runVerification
 * @param {{ok:boolean, code:string, files?:string[]}} [input.scope]
 * @param {{verdict:'accept'|'reject', reason?:string, reviewer?:string}} [input.review]
 * @param {string[]} [input.filesChanged]
 * @param {{status?:string, suspect?:boolean, evidence_claims?:Array}} [input.claims]
 * @param {string} [input.runtimeStatus]  runtime-derived status
 * @param {boolean} [input.blockedBySkippedGate]
 */
export function decideAcceptance({
  riskClass = 'R2',
  gateResults = {},
  scope = { ok: true, code: 'IN_SCOPE' },
  review = null,
  filesChanged = [],
  claims = null,
  runtimeStatus = 'completed',
  blockedBySkippedGate = false,
  requiredGates = null,
} = {}) {
  const reasons = [];

  // 1. The diff decides scope before anything else.
  if (scope && scope.ok === false) {
    return reject('FAILED', scope.code ?? 'SCOPE_VIOLATION', [`scope: ${scope.code}`, ...(scope.files ?? [])]);
  }

  // 2. A missing/malformed result is one outcome, not either/or.
  if (claims?.__malformed) return reject('FAILED', 'RESULT_MALFORMED', ['worker result missing or malformed']);
  if (claims?.__suspect) {
    reasons.push('result claims are suspect (outbox nonce/provenance mismatch) — cannot be accepted');
    return reject('FAILED', 'RESULT_MALFORMED', reasons);
  }

  // 3. A worker that claims `completed` while the runtime says otherwise is lying.
  if (claims?.status === 'completed' && runtimeStatus !== 'completed') {
    return reject('FAILED', 'FALSE_DONE_CLAIM', [`worker claimed completed; runtime status is ${runtimeStatus}`]);
  }

  // 4. Behavioural test rule (spec §24).
  if (violatesBehavioralTestRule(filesChanged)) {
    return reject('FAILED', 'NO_TEST_EVIDENCE', ['production code changed with no test change']);
  }

  // 5. A skipped gate is not a passed gate (L.5). R3+ UI work blocks instead.
  if (blockedBySkippedGate) {
    return reject('BLOCKED', 'SKIPPED_GATE_NOT_PASSED', ['a required visual/e2e gate was skipped for R3+ UI work']);
  }

  // 6. Gates.
  const failedGates = Object.entries(gateResults).filter(([, r]) => String(r.status).startsWith('fail'));
  if (failedGates.length) {
    return reject('FAILED', 'GATE_FAILED', failedGates.map(([g, r]) => `${g}: ${r.status}`));
  }
  // A required gate must be PRESENT and PASSING. The old check only required
  // *some* evidence, so an R4 task with `syntax: pass` (or a required gate
  // marked `skipped:*`) was accepted. Callers that know the risk-derived gate
  // set pass it explicitly; skipped-but-not-required gates are excluded by the
  // caller (requiredGates().filter(g => g.required)), preserving B.4/L.5.
  // Default to the risk-derived floor. A caller that needs a deliberately
  // reduced set (appearance-only, configured skips) passes it explicitly; R1
  // is the only class that may be accepted without gate evidence.
  const enforcedGates = Array.isArray(requiredGates)
    ? requiredGates
    : (riskClass === 'R1' ? [] : riskRequiredGates(riskClass).filter((g) => g.required).map((g) => g.gate));
  if (enforcedGates.length > 0) {
    const missing = enforcedGates.filter((gate) => {
      const result = gateResults[gate];
      return !result || !String(result.status).startsWith('pass');
    });
    if (missing.length) {
      if (Object.keys(gateResults).length === 0) {
        return reject('FAILED', 'GATE_FAILED', ['no gate evidence recorded']);
      }
      return reject('FAILED', 'SKIPPED_GATE_NOT_PASSED', missing.map((gate) => `${gate}: ${gateResults[gate]?.status ?? 'missing'}`));
    }
  }
  const requiredButMissing = Object.keys(gateResults).length === 0;
  if (requiredButMissing && riskClass !== 'R1') {
    return reject('FAILED', 'GATE_FAILED', ['no gate evidence recorded']);
  }

  // 7. Independent review is mandatory above R1.
  if (riskClass !== 'R1') {
    if (!review) return reject('FAILED', 'REVIEW_REJECTED', ['independent review verdict missing']);
    if (review.verdict !== 'accept') {
      return reject('FAILED', 'REVIEW_REJECTED', [`review verdict: ${review.verdict}${review.reason ? ` — ${review.reason}` : ''}`]);
    }
  }

  return { accept: true, status: 'ACCEPTED', code: 'IN_SCOPE', reasons: [] };
}

function reject(status, code, reasons) {
  return { accept: false, status, code, reasons };
}

/** Independent review verdict shape (B.4: "independent review"). */
export function parseReviewVerdict(raw) {
  let doc = raw;
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw); } catch { return { ok: false, error: 'REVIEW_MALFORMED' }; }
  }
  if (!doc || !['accept', 'reject'].includes(doc.verdict)) return { ok: false, error: 'REVIEW_MALFORMED' };
  return { ok: true, value: { verdict: doc.verdict, reason: doc.reason ?? null, reviewer: doc.reviewer ?? null } };
}

export default { decideAcceptance, parseReviewVerdict, REJECTION_CODES };
