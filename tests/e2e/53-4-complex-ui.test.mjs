/**
 * tests/e2e/53-4-complex-ui.test.mjs — §53 Test 4, Complex UI (spec v3 K.8, D.1).
 *
 * A responsive UI change needs the full role set (UX/UI/Frontend/E2E/Visual QA
 * and the **Accessibility Engineer** added by §53 Test 4), the B.5 viewport
 * matrix decision, and the always-on a11y floor checks (contrast, alt text,
 * labels, focus visibility).
 *
 * Runtime evidence asserted: role registry rows, `test_results` for the e2e and
 * visual gates, gate logs on disk, and the documented skip/block policy when no
 * browser stack exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  M, createHarness, addTasks, schedule, stageTaskWork, runAttempt, makeMock,
  modelDecision, gatewayEvidence,
} from './harness.mjs';

const { presets, risk, gates } = M;

const VISUAL_CMD = { visual: { command: ['visual-qc', '--viewport-matrix'], kind: 'playwright' } };

test('§53 Test 4: complex UI — role coverage, viewport matrix, a11y floor', async () => {
  const h = await createHarness({ gateCommands: VISUAL_CMD });
  try {
    // ── C.3 role registry incl. the §53 Test 4 Accessibility Engineer ─────
    const ids = presets.ROLES.map((r) => r.id);
    for (const required of ['ux-designer', 'ui-designer', 'frontend-engineer', 'e2e-engineer', 'visual-qa-engineer', 'accessibility-engineer']) {
      assert.ok(ids.includes(required), `role registry missing ${required}`);
    }

    const mapped = presets.rolesForDomains(['ux-ui', 'frontend', 'testing']);
    for (const required of ['ux-designer', 'ui-designer', 'frontend-engineer', 'e2e-engineer', 'visual-qa-engineer', 'accessibility-engineer']) {
      assert.ok(mapped.includes(required), `rolesForDomains must cover ${required}; got ${mapped}`);
    }

    const a11y = presets.ROLES.find((r) => r.id === 'accessibility-engineer');
    assert.match(a11y.owns, /WCAG/);
    assert.match(a11y.owns, /contrast/i);
    assert.match(a11y.owns, /alt text/i);
    assert.match(a11y.owns, /label/i);
    assert.match(a11y.owns, /focus visibility/i);

    // ── B.5 viewport matrix logic ─────────────────────────────────────────
    assert.equal(risk.isUiChange(['src/ui/Button.tsx']), true);
    assert.equal(risk.needsFullViewportMatrix({
      filesChanged: ['src/ui/Button.tsx'],
      contents: ['@media (max-width: 640px) { .btn { width: 100% } }'],
    }), true, 'responsive markers require the full matrix');
    assert.equal(risk.needsFullViewportMatrix({ filesChanged: ['tailwind.config.js'], contents: [] }), true);
    assert.equal(risk.needsFullViewportMatrix({
      filesChanged: ['src/ui/Button.css'], contents: ['.btn { color: green }'],
    }), false, 'non-responsive change is desktop-only');
    assert.deepEqual(h.config.verification.visualViewports, ['1440x900', '1024x768', '390x844']);
    assert.equal(h.config.verification.visualFullMatrix, 'auto');

    // ── a11y floor is a runtime policy flag, not prose ────────────────────
    assert.equal(h.config.verification.a11yFloor, true);

    // ── run the complex UI task with e2e + visual gates ───────────────────
    const mock = makeMock();
    addTasks(h, [{
      id: 'UI-100', title: 'Responsive navigation grid', role: 'frontend-engineer',
      objective: 'make the navigation responsive with a mobile drawer', task_class: 'normal',
      risk_class: 'R3',
      allowed_paths: ['src/ui/**'],
      verification: ['syntax', 'lint', 'unit', 'integration', 'e2e', 'visual'],
    }]);
    schedule(h);
    const gateList = risk.requiredGates('R3', { uiChange: true, gateCommands: h.gateCommands }).map((g) => g.gate);
    assert.deepEqual(gateList, ['syntax', 'lint', 'unit', 'integration', 'e2e', 'visual']);

    const work = stageTaskWork(h, {
      taskId: 'UI-100',
      files: {
        'src/ui/Button.css': '@media (max-width: 640px) { .btn { width: 100% } }\n',
        'src/ui/Button.test.mjs': "import { test } from 'node:test';\ntest('button', () => {});\n",
      },
    });
    const attempt = runAttempt(h, {
      taskId: 'UI-100',
      filesChanged: work.filesChanged,
      review: modelDecision(mock, 'mock/review-accept'),
      gateList,
      branch: work.branch,
    });
    assert.equal(attempt.decision.accept, true, JSON.stringify(attempt.decision));
    const byGate = Object.fromEntries(gatewayEvidence(h, 'UI-100').map((r) => [r.gate, r.status]));
    assert.equal(byGate.e2e, 'pass', 'e2e gate is required for an R3 UI change');
    assert.equal(byGate.visual, 'pass');
    assert.ok(existsSync(`${h.verificationDir}/UI-100/visual.log`), 'visual gate log on disk');

    // ── no browser stack: the gate is skipped WITH REASON and BLOCKS ──────
    // The Playwright browser binaries cannot be installed here, so the test
    // asserts the DOCUMENTED POLICY the runtime enforces rather than a fake
    // pass: a skipped vision gate blocks R3+ UI work instead of auto-accepting.
    assert.equal(gates.detectPlaywright({ devDependencies: { '@playwright/test': '^1.44' } }), true);
    assert.equal(gates.detectPlaywright({ dependencies: {} }), false);
    const noBrowser = risk.requiredGates('R3', { uiChange: true, hasBrowserStack: false });
    const visual = noBrowser.find((g) => g.gate === 'visual');
    assert.equal(visual.skipped, 'skipped:no-browser-stack');
    assert.equal(visual.required, false);
    assert.equal(risk.blockedBySkippedGate('R3', noBrowser), true);
    const decision = M.verifier.decideAcceptance({
      riskClass: 'R3',
      gateResults: { syntax: { status: 'skipped:policy' }, lint: { status: 'pass' }, unit: { status: 'pass' }, visual: { status: 'skipped:no-browser-stack' } },
      filesChanged: ['src/ui/Button.css', 'src/ui/Button.test.mjs'],
      review: { verdict: 'accept' },
      claims: { status: 'completed' },
      runtimeStatus: 'completed',
      blockedBySkippedGate: risk.blockedBySkippedGate('R3', noBrowser),
    });
    assert.equal(decision.accept, false, 'a skipped visual gate must never auto-accept R3+ UI work');
    assert.equal(decision.status, 'BLOCKED');
    assert.equal(decision.code, 'SKIPPED_GATE_NOT_PASSED');

    // LIMITATION (documented in code): B.2.1 has no `VERIFYING → BLOCKED`
    // transition, so the BLOCKED verdict is a decision-level outcome here; the
    // runtime cannot currently persist it as a task state. Faking a transition
    // would be a false pass, so the policy is asserted at the decision layer.
  } finally {
    h.close();
  }
});
