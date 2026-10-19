/**
 * tests/adversarial/gate-evidence-forgery.test.mjs — acceptance requires the
 * risk-derived gate set, not merely *some* green evidence.
 *
 * Regression (PROOF_REPORT §7.1): `decideAcceptance` only rejected when no gate
 * results existed, so an R4 task with `syntax: pass` — or with required gates
 * marked `skipped:*` — was ACCEPTED. The verifier now takes an explicit
 * `requiredGates` set; this test fuzzes every subset and every skipped variant.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const verifier = await core.verifier();
const risk = await core.risk();

const REQUIRED = risk.requiredGates('R4').filter((g) => g.required).map((g) => g.gate);

function decision(gates, overrides = {}) {
  return verifier.decideAcceptance({
    riskClass: 'R4',
    gateResults: gates,
    requiredGates: REQUIRED,
    review: { verdict: 'accept' },
    filesChanged: ['src/api/a.ts', 'tests/a.test.ts'],
    claims: { status: 'completed' },
    runtimeStatus: 'completed',
    ...overrides,
  });
}

function allPass() {
  return Object.fromEntries(REQUIRED.map((g) => [g, { status: 'pass' }]));
}

test('the full required set is accepted', () => {
  const result = decision(allPass());
  assert.equal(result.accept, true, JSON.stringify(result));
});

test('no proper subset of required gates is ever accepted', () => {
  for (let mask = 1; mask < (1 << REQUIRED.length) - 1; mask += 1) {
    const subset = {};
    REQUIRED.forEach((gate, index) => {
      if (mask & (1 << index)) subset[gate] = { status: 'pass' };
    });
    const result = decision(subset);
    assert.equal(result.accept, false, `subset ${Object.keys(subset).join(',')} was accepted`);
    assert.equal(result.code, 'SKIPPED_GATE_NOT_PASSED');
  }
});

test('no evidence at all is GATE_FAILED, not a silent acceptance', () => {
  const result = decision({});
  assert.equal(result.accept, false);
  assert.equal(result.code, 'GATE_FAILED');
});

test('a skipped required gate is never treated as a pass', () => {
  for (const gate of REQUIRED) {
    for (const status of ['skipped:policy', 'skipped:not-configured', 'skipped:no-changed-files']) {
      const result = decision({ ...allPass(), [gate]: { status } });
      assert.equal(result.accept, false, `${gate}=${status} was accepted`);
      assert.match(result.reasons.join(' '), new RegExp(`${gate}: ${status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  }
});

test('a failing required gate reports GATE_FAILED, not a silent acceptance', () => {
  const result = decision({ ...allPass(), security: { status: 'fail:1' } });
  assert.equal(result.accept, false);
  assert.equal(result.code, 'GATE_FAILED');
  assert.match(result.reasons.join(' '), /security: fail:1/);
});

test('an explicitly reduced set preserves the appearance-only skip policy', () => {
  const reduced = risk.requiredGates('R3', { uiChange: true, appearanceOnly: true })
    .filter((g) => g.required).map((g) => g.gate);
  const gates = Object.fromEntries(reduced.map((g) => [g, { status: 'pass' }]));
  const result = verifier.decideAcceptance({
    riskClass: 'R3',
    gateResults: gates,
    requiredGates: reduced,
    review: { verdict: 'accept' },
    filesChanged: ['src/app.css', 'tests/visual/base.png'],
  });
  assert.equal(result.accept, true, JSON.stringify(result));
});
