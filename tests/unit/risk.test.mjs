/**
 * tests/unit/risk.test.mjs — risk classes and gate selection (spec v3 B.4, acceptance Test 1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const risk = await core.risk();

test('risk class matches top-down with R4 first (sec/resources/score ≥ 0.65)', () => {
  assert.equal(risk.riskClass({ sec: true, score: 0.1 }), 'R4');
  assert.equal(risk.riskClass({ resources: ['package.json'], score: 0.1 }), 'R4');
  assert.equal(risk.riskClass({ score: 0.65 }), 'R4');
  assert.equal(risk.riskClass({ ui: true, score: 0.1 }), 'R3');
  assert.equal(risk.riskClass({ score: 0.45 }), 'R3');
  assert.equal(risk.riskClass({ score: 0.25 }), 'R2');
  assert.equal(risk.riskClass({ score: 0.24 }), 'R1');
  // Security can never be downgraded even when the score is trivial.
  assert.equal(risk.riskClass({ sec: true, ui: false, score: 0 }), 'R4');
});

test('gate sets per risk class, in fixed fail-fast order', () => {
  const names = (r, opts) => risk.requiredGates(r, opts).map((g) => g.gate);
  assert.deepEqual(names('R1'), ['syntax', 'lint', 'unit']);
  assert.deepEqual(names('R2'), ['syntax', 'lint', 'unit', 'integration']);
  assert.deepEqual(names('R3', { uiChange: true }), ['syntax', 'lint', 'unit', 'integration', 'e2e', 'visual']);
  assert.deepEqual(names('R3', { domains: ['api'] }), ['syntax', 'lint', 'unit', 'integration', 'api']);
  assert.deepEqual(names('R4', { domains: ['api'], uiChange: true }), ['syntax', 'types', 'lint', 'unit', 'integration', 'api', 'e2e', 'visual', 'security']);
});

test('appearance-only refinement replaces integration/e2e with visual (Test 1)', () => {
  const gates = risk.requiredGates('R3', { uiChange: true, appearanceOnly: true });
  const names = gates.map((g) => g.gate);
  assert.equal(names.includes('visual'), true);
  assert.equal(names.includes('e2e'), false, 'a colour change must not run an e2e suite');
  assert.equal(names.includes('integration'), false);
});

test('isAppearanceOnly: CSS/assets/templates without logic', () => {
  assert.equal(risk.isAppearanceOnly(['src/app.css']), true);
  assert.equal(risk.isAppearanceOnly(['src/app.css', 'src/logo.svg']), true);
  assert.equal(risk.isAppearanceOnly(['src/app.css', 'src/app.ts']), false);
  assert.equal(risk.isAppearanceOnly(['src/routing/index.ts']), false);
  assert.equal(risk.isAppearanceOnly([]), false);
});

test('isUiChange and viewport matrix (B.5)', () => {
  assert.equal(risk.isUiChange(['src/Button.tsx']), true);
  assert.equal(risk.isUiChange(['src/server.ts']), false);
  assert.equal(risk.needsFullViewportMatrix({ contents: ['@media (max-width: 600px) { }'] }), true);
  assert.equal(risk.needsFullViewportMatrix({ filesChanged: ['tailwind.config.js'] }), true);
  assert.equal(risk.needsFullViewportMatrix({ contents: ['body { color: red }'] }), false);
});

test('behavioural test rule: production code without a test change is a rejection (spec §24)', () => {
  assert.equal(risk.violatesBehavioralTestRule(['src/api/users.ts']), true);
  assert.equal(risk.violatesBehavioralTestRule(['src/api/users.ts', 'tests/api/users.test.ts']), false);
  assert.equal(risk.violatesBehavioralTestRule(['README.md']), false, 'docs-only changes are exempt');
  assert.equal(risk.violatesBehavioralTestRule(['package.json']), false, 'config-only changes are exempt');
  assert.equal(risk.violatesBehavioralTestRule(['docs/guide.md', 'src/a.py']), true);
});

test('skipped gates are explicit evidence, and a skipped UI gate blocks R3+ (L.5)', () => {
  const gates = risk.requiredGates('R3', { uiChange: true, hasBrowserStack: false });
  const visual = gates.find((g) => g.gate === 'visual');
  assert.equal(visual.skipped, 'skipped:no-browser-stack');
  assert.equal(risk.blockedBySkippedGate('R3', gates), true);
  const r2 = risk.requiredGates('R2', { hasBrowserStack: false });
  assert.equal(risk.blockedBySkippedGate('R2', r2), false, 'R2 has no browser gate to skip');
});

test('a gate can be disabled by config with an explicit reason', () => {
  const gates = risk.requiredGates('R2', { gateCommands: { integration: { skip: true, reason: 'no-suite' } } });
  const integration = gates.find((g) => g.gate === 'integration');
  assert.equal(integration.skipped, 'skipped:no-suite');
  assert.equal(integration.required, false);
});

test('GATE_ORDER is the documented B.4.1 order', () => {
  assert.deepEqual(risk.GATE_ORDER, ['syntax', 'types', 'lint', 'unit', 'integration', 'api', 'e2e', 'visual', 'security', 'perf', 'build']);
});
