/**
 * tests/unit/verifier.test.mjs — acceptance decisions (spec v3 B.3.2, B.4, L.1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const v = await core.verifier();
const risk = await core.risk();

const ACCEPT_REVIEW = { verdict: 'accept', reviewer: 'code-reviewer' };

function base(overrides = {}) {
  return {
    riskClass: 'R2',
    gateResults: { syntax: { status: 'pass' }, lint: { status: 'pass' }, unit: { status: 'pass' }, integration: { status: 'pass' } },
    scope: { ok: true, code: 'IN_SCOPE' },
    review: ACCEPT_REVIEW,
    filesChanged: ['src/a.ts', 'tests/a.test.ts'],
    claims: { status: 'completed' },
    runtimeStatus: 'completed',
    ...overrides,
  };
}

test('a clean, evidenced task is accepted', () => {
  const decision = v.decideAcceptance(base());
  assert.equal(decision.accept, true);
  assert.equal(decision.status, 'ACCEPTED');
});

test('scope violation pre-empts everything else', () => {
  const decision = v.decideAcceptance(base({ scope: { ok: false, code: 'SCOPE_VIOLATION', files: ['other/x.ts'] } }));
  assert.equal(decision.accept, false);
  assert.equal(decision.code, 'SCOPE_VIOLATION');
  assert.equal(decision.status, 'FAILED');
});

test('a malformed or suspect result is rejected (one outcome, not either/or)', () => {
  assert.equal(v.decideAcceptance(base({ claims: { __malformed: true } })).code, 'RESULT_MALFORMED');
  assert.equal(v.decideAcceptance(base({ claims: { __suspect: true } })).code, 'RESULT_MALFORMED');
});

test('a false DONE claim is rejected with runtime evidence (Test 7)', () => {
  const decision = v.decideAcceptance(base({ claims: { status: 'completed' }, runtimeStatus: 'failed' }));
  assert.equal(decision.accept, false);
  assert.equal(decision.code, 'FALSE_DONE_CLAIM');
  assert.match(decision.reasons[0], /runtime status is failed/);
});

test('behavioural test rule: production change without a test is rejected', () => {
  const decision = v.decideAcceptance(base({ filesChanged: ['src/a.ts'] }));
  assert.equal(decision.code, 'NO_TEST_EVIDENCE');
});

test('an explicit required-gate set rejects missing or skipped gates (R4 fail-open)', () => {
  const required = risk.requiredGates('R4').filter((g) => g.required).map((g) => g.gate);
  const allPass = Object.fromEntries(required.map((g) => [g, { status: 'pass' }]));
  assert.equal(required.length, 6, required.join(','));
  assert.equal(v.decideAcceptance(base({ riskClass: 'R4', gateResults: allPass, requiredGates: required })).accept, true);

  // Only one gate: previously ACCEPTED because *some* evidence existed.
  const one = v.decideAcceptance(base({
    riskClass: 'R4', gateResults: { syntax: { status: 'pass' } }, requiredGates: required,
  }));
  assert.equal(one.accept, false);
  assert.equal(one.code, 'SKIPPED_GATE_NOT_PASSED');
  assert.match(one.reasons.join(' '), /lint: missing/);

  // A skipped required gate is not a pass.
  const skipped = v.decideAcceptance(base({
    riskClass: 'R4', gateResults: { ...allPass, unit: { status: 'skipped:policy' } }, requiredGates: required,
  }));
  assert.equal(skipped.accept, false);
  assert.equal(skipped.code, 'SKIPPED_GATE_NOT_PASSED');
  assert.match(skipped.reasons.join(' '), /unit: skipped:policy/);
});

test('a gate set explicitly reduced for appearance-only work can omit integration/e2e', () => {
  const required = risk.requiredGates('R3', { uiChange: true, appearanceOnly: true })
    .filter((g) => g.required).map((g) => g.gate);
  assert.ok(required.includes('visual'));
  assert.ok(!required.includes('integration'));
  const gates = Object.fromEntries(required.map((g) => [g, { status: 'pass' }]));
  const decision = v.decideAcceptance(base({
    riskClass: 'R3', gateResults: gates, requiredGates: required, filesChanged: ['src/app.css', 'tests/visual/base.png'],
  }));
  assert.equal(decision.accept, true, JSON.stringify(decision));
});

test('a skipped visual/e2e gate for R3+ UI BLOCKS rather than auto-accepts (L.5)', () => {
  const decision = v.decideAcceptance(base({ riskClass: 'R3', blockedBySkippedGate: true }));
  assert.equal(decision.accept, false);
  assert.equal(decision.status, 'BLOCKED');
  assert.equal(decision.code, 'SKIPPED_GATE_NOT_PASSED');
});

test('any failing gate rejects with GATE_FAILED and the gate names', () => {
  const decision = v.decideAcceptance(base({ gateResults: { syntax: { status: 'pass' }, unit: { status: 'fail:1' } } }));
  assert.equal(decision.code, 'GATE_FAILED');
  assert.match(decision.reasons[0], /unit: fail:1/);
});

test('missing gate evidence above R1 is a rejection, not a pass', () => {
  assert.equal(v.decideAcceptance(base({ gateResults: {} })).code, 'GATE_FAILED');
  assert.equal(v.decideAcceptance(base({ riskClass: 'R1', gateResults: {}, review: null })).accept, true);
});

test('independent review is mandatory above R1', () => {
  assert.equal(v.decideAcceptance(base({ review: null })).code, 'REVIEW_REJECTED');
  assert.equal(v.decideAcceptance(base({ review: { verdict: 'reject', reason: 'overflow' } })).code, 'REVIEW_REJECTED');
  assert.match(v.decideAcceptance(base({ review: { verdict: 'reject', reason: 'overflow' } })).reasons[0], /overflow/);
});

test('parseReviewVerdict validates the shape', () => {
  assert.equal(v.parseReviewVerdict(JSON.stringify(ACCEPT_REVIEW)).ok, true);
  assert.equal(v.parseReviewVerdict('nonsense').ok, false);
  assert.equal(v.parseReviewVerdict(JSON.stringify({ verdict: 'maybe' })).ok, false);
});
