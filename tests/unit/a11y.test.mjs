/**
 * tests/unit/a11y.test.mjs — the always-on accessibility floor (spec v3 B.5).
 *
 * `packages/sdlc-core/src/a11y.js` had no unit coverage before this file; the
 * colour maths especially deserves direct assertions rather than only the M6
 * gate's smoke checks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const a11y = await core.a11y();

test('relative luminance matches the WCAG reference values', () => {
  assert.equal(a11y.relativeLuminance('#000000'), 0);
  assert.equal(a11y.relativeLuminance('#ffffff'), 1);
  // Shorthand hex is expanded, and the value is per the WCAG 2.x formula.
  assert.equal(a11y.relativeLuminance('#fff'), 1);
  assert.ok(Math.abs(a11y.relativeLuminance('#808080') - 0.2158) < 0.001);
  assert.throws(() => a11y.relativeLuminance('#zzz'), /invalid colour/);
  assert.throws(() => a11y.relativeLuminance('red'), /invalid colour/);
});

test('contrastRatio is symmetric and bounded 1..21', () => {
  assert.equal(Number(a11y.contrastRatio('#000000', '#ffffff').toFixed(2)), 21);
  assert.equal(Number(a11y.contrastRatio('#ffffff', '#ffffff').toFixed(2)), 1);
  assert.equal(a11y.contrastRatio('#123456', '#abcdef'), a11y.contrastRatio('#abcdef', '#123456'));
});

test('AA and AAA thresholds differ for normal and large text', () => {
  // #767676 on white is the canonical AA boundary (~4.54:1).
  const aa = a11y.meetsContrast('#767676', '#ffffff');
  assert.equal(aa.pass, true);
  assert.ok(aa.ratio >= 4.5);
  // #999999 on white is ~2.85:1 — large-text AA (3:1) fails, but barely.
  const large = a11y.meetsContrast('#999999', '#ffffff', { large: true });
  assert.equal(large.threshold, 3);
  const normal = a11y.meetsContrast('#999999', '#ffffff');
  assert.equal(normal.threshold, 4.5);
  assert.equal(normal.pass, false);
  // AAA raises both thresholds.
  assert.equal(a11y.meetsContrast('#767676', '#ffffff', { level: 'AAA' }).threshold, 7);
  assert.equal(a11y.meetsContrast('#000000', '#ffffff', { level: 'AAA' }).pass, true);
});

test('checkAltText requires alt on meaningful images and exempts decorative ones', () => {
  const violations = a11y.checkAltText([
    { selector: 'img.hero', alt: 'A hero image' },
    { selector: 'img.logo', alt: '   ' },
    { selector: 'img.spacer' },
    { selector: 'img.decor', decorative: true },
  ]);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.element), ['img.logo', 'img.spacer']);
  assert.equal(violations[0].check, 'alt-text');
});

test('checkLabels accepts for/id, aria-label and aria-labelledby', () => {
  const violations = a11y.checkLabels([
    { selector: '#email', label: 'Email' },
    { selector: '#search', 'aria-label': 'Search' },
    { selector: '#q', 'aria-labelledby': 'q-label' },
    { selector: '#password' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].element, '#password');
  assert.equal(violations[0].check, 'label-association');
});

test('checkFocusVisible only inspects interactive elements', () => {
  const violations = a11y.checkFocusVisible([
    { selector: 'button.ok', interactive: true, focusVisible: true },
    { selector: 'a.cta', interactive: true, focusVisible: false },
    { selector: 'div.static', interactive: false, focusVisible: false },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].element, 'a.cta');
});

test('runA11yFloor: a clean UI passes and reports every check', () => {
  const result = a11y.runA11yFloor({
    images: [{ alt: 'x' }],
    controls: [{ label: 'x' }],
    interactive: [{ interactive: true, focusVisible: true }],
    textSamples: [{ color: '#000000', background: '#ffffff' }],
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.checks.map((c) => c.check), a11y.A11Y_FLOOR_CHECKS);
  assert.ok(result.checks.every((c) => c.status === 'pass'));
});

test('runA11yFloor: every violation kind is detected independently', () => {
  const cases = [
    [{ images: [{ alt: '' }] }, 'alt-text'],
    [{ controls: [{}] }, 'label-association'],
    [{ interactive: [{ interactive: true, focusVisible: false }] }, 'focus-visible'],
    [{ textSamples: [{ color: '#eeeeee', background: '#ffffff' }] }, 'contrast'],
  ];
  for (const [input, expected] of cases) {
    const result = a11y.runA11yFloor(input);
    assert.equal(result.pass, false, `${expected} should fail the floor`);
    assert.ok(result.violations.some((v) => v.check === expected), `missing ${expected}`);
  }
});

test('runA11yFloor: unavailable measurements SKIP, never pass, and can be disabled', () => {
  const skipped = a11y.runA11yFloor({});
  assert.equal(skipped.pass, true, 'no violations were observed');
  assert.ok(skipped.checks.every((c) => c.status === 'skipped:no-measurement'));
  assert.equal(skipped.violations.length, 0);

  const disabled = a11y.runA11yFloor({ enabled: false });
  assert.deepEqual(disabled.checks, [{ check: 'a11y-floor', status: 'skipped:disabled' }]);
});
