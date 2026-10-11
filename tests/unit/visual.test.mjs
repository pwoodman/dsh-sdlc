/**
 * tests/unit/visual.test.mjs — visual QA pipeline (spec v3 B.5, K.8 layer L7/M6).
 *
 * Until this file existed, `packages/sdlc-core/src/visual.js` was exercised only
 * through the M6 gate script, so it had no unit coverage at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const visual = await core.visual();

test('the documented constants are stable', () => {
  assert.deepEqual(visual.VIEWPORTS, ['1440x900', '1024x768', '390x844']);
  assert.deepEqual(visual.SEVERITIES, ['high', 'medium', 'low']);
  assert.ok(visual.CATEGORIES.includes('overflow'));
  assert.ok(visual.CATEGORIES.includes('unusable-state'));
  assert.equal(visual.AUTOMATED_CHECKS.length, 9);
});

test('visualTriggered uses the B.5 UI classifier', () => {
  assert.equal(visual.visualTriggered(['src/app.css']), true);
  assert.equal(visual.visualTriggered(['src/App.tsx']), true);
  assert.equal(visual.visualTriggered(['src/App.vue']), true);
  assert.equal(visual.visualTriggered(['templates/index.html']), true);
  assert.equal(visual.visualTriggered(['tailwind.config.js']), true);
  assert.equal(visual.visualTriggered(['src/routing/index.ts']), true);
  assert.equal(visual.visualTriggered(['src/server.ts']), false);
  assert.equal(visual.visualTriggered([]), false);
});

test('viewportMatrix: desktop only, or the full matrix when responsive', () => {
  assert.deepEqual(visual.viewportMatrix({ contents: ['.a{color:red}'] }), ['1440x900']);
  assert.deepEqual(visual.viewportMatrix({ contents: ['@media (max-width:600px){}'] }), ['1440x900', '1024x768', '390x844']);
  assert.deepEqual(visual.viewportMatrix({ filesChanged: ['tailwind.config.js'] }), ['1440x900', '1024x768', '390x844']);
  assert.deepEqual(visual.viewportMatrix({ mode: 'always', contents: [] }), ['1440x900', '1024x768', '390x844']);
  assert.deepEqual(visual.viewportMatrix({ mode: 'never', contents: ['@media all{}'] }), ['1440x900']);
  // A custom viewport list is honoured.
  assert.deepEqual(visual.viewportMatrix({ mode: 'always', viewports: ['800x600', '400x300'] }), ['800x600', '400x300']);
});

test('a valid rubric parses, including a justified fail', () => {
  const pass = visual.parseVisualRubric(JSON.stringify({ viewport: '1440x900', defects: [], verdict: 'pass' }));
  assert.equal(pass.ok, true);
  assert.equal(pass.value.verdict, 'pass');

  const fail = visual.parseVisualRubric(JSON.stringify({
    viewport: '390x844',
    defects: [
      { element: 'submit', severity: 'high', category: 'overflow', description: 'overflows' },
      { element: 'label', severity: 'low', category: 'spacing', description: 'tight' },
    ],
    verdict: 'fail',
  }));
  assert.equal(fail.ok, true);
  assert.equal(fail.value.defects.length, 2);
});

test('the rubric rejects every documented malformation', () => {
  const bad = [
    ['not json', /RUBRIC_MALFORMED/],
    [JSON.stringify({ defects: [], verdict: 'pass' }), /viewport/],
    [JSON.stringify({ viewport: '1x1', defects: [] }), /verdict/],
    [JSON.stringify({ viewport: '1x1', verdict: 'maybe', defects: [] }), /verdict/],
    [JSON.stringify({ viewport: '1x1', verdict: 'pass' }), /defects/],
    [JSON.stringify({ viewport: '1x1', verdict: 'pass', defects: [{ severity: 'nope', category: 'overflow', description: 'x' }] }), /severity/],
    [JSON.stringify({ viewport: '1x1', verdict: 'pass', defects: [{ severity: 'low', category: 'nope', description: 'x' }] }), /category/],
    [JSON.stringify({ viewport: '1x1', verdict: 'pass', defects: [{ severity: 'low', category: 'overflow', description: '' }] }), /description/],
  ];
  for (const [input, pattern] of bad) {
    const result = visual.parseVisualRubric(input);
    assert.equal(result.ok, false, `should reject ${input}`);
    assert.match(result.error, pattern);
  }
});

test('a fail verdict without a medium+ defect is inconsistent and rejected', () => {
  const result = visual.parseVisualRubric(JSON.stringify({
    viewport: '390x844',
    defects: [{ element: 'x', severity: 'low', category: 'spacing', description: 'nit' }],
    verdict: 'fail',
  }));
  assert.equal(result.ok, false);
  assert.match(result.error, /RUBRIC_INCONSISTENT/);
});

test('evaluateVisualChecks maps measurements to pass/fail/skip', () => {
  const results = visual.evaluateVisualChecks({
    scrollWidth: 400, innerWidth: 390,
    clippedOrOverlapping: 0,
    missingAcceptanceElements: [],
    consoleErrors: 2,
    failedRequests: 0,
    contrastOk: true,
    focusVisibleOk: false,
    imagesMissingAlt: 1,
    controlsMissingLabel: 0,
  });
  assert.equal(results['no-horizontal-overflow'], 'fail');
  assert.equal(results['no-clipped-or-overlapping-controls'], 'pass');
  assert.equal(results['acceptance-elements-present'], 'pass');
  assert.equal(results['console-errors-zero'], 'fail');
  assert.equal(results['focus-visible'], 'fail');
  assert.equal(results['images-have-alt-text'], 'fail');
  assert.equal(results['controls-have-labels'], 'pass');
  // A missing measurement is a SKIP, never a silent pass.
  const empty = visual.evaluateVisualChecks({});
  for (const status of Object.values(empty)) assert.equal(status, 'skipped:no-measurement');
});

test('visual failure escalation counts only consecutive failures (B.5)', () => {
  assert.equal(visual.visualFailureEscalates([{ gates: { visual: 'fail:1' } }, { gates: { visual: 'fail:1' } }]).escalate, true);
  assert.equal(visual.visualFailureEscalates([{ gates: { visual: 'fail:1' } }]).escalate, false);
  const interrupted = [{ gates: { visual: 'fail:1' } }, { gates: { visual: 'pass' } }, { gates: { visual: 'fail:1' } }];
  assert.equal(visual.visualFailureEscalates(interrupted).escalate, false);
  const custom = [{ gates: { e2e: 'fail:1' } }, { gates: { e2e: 'fail:1' } }];
  assert.equal(visual.visualFailureEscalates(custom, { gate: 'e2e', threshold: 2 }).escalate, true);
  assert.equal(visual.visualFailureEscalates(custom, { gate: 'visual' }).escalate, false);
});
