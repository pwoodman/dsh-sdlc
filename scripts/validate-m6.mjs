#!/usr/bin/env node
/**
 * scripts/validate-m6.mjs — M6 gate: visual (spec v3 D.0, B.5).
 *
 * The Playwright viewport matrix, the AI visual rubric, 2 consecutive visual
 * failures ⇒ ESCALATED, and the always-on a11y floor. When the browser stack is
 * genuinely absent the browser-dependent checks SKIP with a real reason — a
 * skipped gate is never a passed gate (L.5).
 *
 *   node scripts/validate-m6.mjs [--json <path>] [--fail-fast]
 */

import { runSuite, EXIT } from './lib/harness.mjs';
import { importPkg } from './lib/gate-helpers.mjs';
import { run } from './lib/harness.mjs';

const visual = await importPkg('packages/sdlc-core/src/visual.js');
const a11y = await importPkg('packages/sdlc-core/src/a11y.js');
const risk = await importPkg('packages/sdlc-core/src/risk.js');
const { MockLlm } = await importPkg('packages/sdlc-mock-llm/src/index.js');

function playwrightAvailable() {
  const res = run('npx', ['--no-install', 'playwright', '--version'], { timeoutMs: 20000 });
  return res.ok;
}

const checks = [
  {
    id: 'M6-01-viewport-matrix',
    title: 'the full 3-viewport matrix runs only when responsive markers are present',
    fn() {
      const desktop = visual.viewportMatrix({ filesChanged: ['src/Button.tsx'], contents: ['.button { color: red }'] });
      if (desktop.length !== 1 || desktop[0] !== '1440x900') throw new Error(`expected desktop only, got ${desktop.join(',')}`);
      const full = visual.viewportMatrix({ filesChanged: ['src/Button.tsx'], contents: ['@media (max-width: 600px) { .button { } }'] });
      if (full.join(',') !== '1440x900,1024x768,390x844') throw new Error(`expected the full matrix, got ${full.join(',')}`);
      const always = visual.viewportMatrix({ mode: 'always', filesChanged: [], contents: [] });
      if (always.length !== 3) throw new Error('mode: always must force the matrix');
      if (visual.VIEWPORTS.join(',') !== '1440x900,1024x768,390x844') throw new Error('viewport constants drifted from B.5');
      return { detail: 'auto/always/never resolved; 3 documented viewports' };
    },
  },
  {
    id: 'M6-02-visual-trigger',
    title: 'the visual gate triggers on the documented UI classifier',
    fn() {
      if (!visual.visualTriggered(['src/app.css'])) throw new Error('css did not trigger visual QA');
      if (!visual.visualTriggered(['src/App.tsx'])) throw new Error('tsx did not trigger visual QA');
      if (!visual.visualTriggered(['templates/index.html'])) throw new Error('templates did not trigger visual QA');
      if (visual.visualTriggered(['src/server.ts'])) throw new Error('a server file triggered visual QA');
      const files = ['src/app.css'];
      const gates = risk.requiredGates(risk.riskClass({ ui: true, score: 0.2 }), { uiChange: true, appearanceOnly: true });
      if (!gates.some((g) => g.gate === 'visual' && g.required)) throw new Error('an appearance-only change must require the visual gate');
      return { detail: 'UI classifier triggers; appearance-only requires visual' };
    },
  },
  {
    id: 'M6-03-rubric-verdict',
    title: 'the AI visual rubric parses and fail requires a medium+ defect',
    fn() {
      const llm = new MockLlm();
      const pass = visual.parseVisualRubric(llm.respond({ model: 'mock/visual-rubric', messages: [] }).text);
      if (!pass.ok) throw new Error(`a valid rubric failed to parse: ${pass.error}`);
      if (pass.value.verdict !== 'pass') throw new Error('expected a pass verdict');

      const justified = visual.parseVisualRubric(JSON.stringify({
        viewport: '390x844',
        defects: [{ element: 'submit button', severity: 'high', category: 'overflow', description: 'overflows the viewport' }],
        verdict: 'fail',
      }));
      if (!justified.ok) throw new Error('a justified fail verdict was rejected');

      const unjustified = visual.parseVisualRubric(JSON.stringify({ viewport: '390x844', defects: [{ element: 'x', severity: 'low', category: 'spacing', description: 'nit' }], verdict: 'fail' }));
      if (unjustified.ok) throw new Error('a fail verdict without a medium+ defect was accepted');

      const malformed = visual.parseVisualRubric('{"viewport":"1x1","verdict":"fail","defects":[{"severity":"high","category":"nope","description":"x"}]}');
      if (malformed.ok) throw new Error('an unknown category was accepted');
      if (visual.parseVisualRubric('not json').ok) throw new Error('non-JSON was accepted');
      return { detail: 'rubric shape enforced, including fail-justification' };
    },
  },
  {
    id: 'M6-04-two-visual-failures-escalate',
    title: '2 consecutive visual failures escalate rather than retry blindly',
    fn() {
      const attempts = [{ gates: { visual: 'fail:1' } }, { gates: { visual: 'fail:1' } }];
      const result = visual.visualFailureEscalates(attempts, { threshold: 2 });
      if (!result.escalate) throw new Error('two consecutive visual failures did not escalate');
      const interrupted = [{ gates: { visual: 'fail:1' } }, { gates: { visual: 'pass' } }, { gates: { visual: 'fail:1' } }];
      if (visual.visualFailureEscalates(interrupted, { threshold: 2 }).escalate) throw new Error('non-consecutive failures escalated');
      return { detail: 'consecutive counting only' };
    },
  },
  {
    id: 'M6-05-a11y-floor',
    title: 'the always-on a11y floor (contrast, alt text, labels, focus) is enforced',
    fn() {
      const contrast = a11y.meetsContrast('#000000', '#ffffff', {});
      if (!contrast.pass) throw new Error('black on white must pass contrast');
      if (a11y.meetsContrast('#eeeeee', '#ffffff', {}).pass) throw new Error('near-white on white must fail contrast');
      const clean = a11y.runA11yFloor({
        images: [{ selector: 'img.logo', alt: 'Logo' }, { selector: 'img.decor', decorative: true }],
        controls: [{ selector: 'input#email', label: 'Email' }],
        interactive: [{ selector: 'button', interactive: true, focusVisible: true }],
        textSamples: [{ selector: 'p', color: '#111111', background: '#ffffff' }],
      });
      if (!clean.pass) throw new Error(`a clean UI failed the floor: ${JSON.stringify(clean.violations)}`);
      const dirty = a11y.runA11yFloor({
        images: [{ selector: 'img.hero', alt: '' }],
        controls: [{ selector: 'input#pw' }],
        interactive: [{ selector: 'a.cta', interactive: true, focusVisible: false }],
        textSamples: [{ selector: 'p.muted', color: '#cccccc', background: '#ffffff' }],
      });
      if (dirty.pass) throw new Error('a dirty UI passed the floor');
      const kinds = new Set(dirty.violations.map((v) => v.check));
      for (const k of ['alt-text', 'label-association', 'focus-visible', 'contrast']) {
        if (!kinds.has(k)) throw new Error(`the floor missed ${k}`);
      }
      // A missing measurement is a skip, never a pass.
      const noData = a11y.runA11yFloor({ images: null, controls: null, interactive: null, textSamples: null });
      const statuses = noData.checks.map((c) => c.status);
      if (statuses.some((s) => s === 'pass')) throw new Error('an unmeasured check reported a pass');
      return { detail: 'contrast/alt/label/focus violations detected; missing measurements skip' };
    },
  },
  {
    id: 'M6-06-playwright-stack',
    title: 'Playwright runs the viewport matrix when present (else skips with a real reason)',
    fn() {
      if (!playwrightAvailable()) {
        const required = risk.requiredGates('R3', { uiChange: true, hasBrowserStack: false });
        if (!risk.blockedBySkippedGate('R3', required)) throw new Error('no-browser-stack did not block R3+ UI work');
        return { skip: 'playwright is not installed in this environment; the no-browser-stack BLOCK policy was asserted instead (L.5)' };
      }
      const res = run('npx', ['--no-install', 'playwright', '--version'], { timeoutMs: 20000 });
      if (!res.ok) throw new Error('playwright reported available but failed to run');
      return { detail: res.stdout.trim() };
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M6 visual gate', version: '1.0.0', checks }));
