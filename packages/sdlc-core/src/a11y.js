/**
 * packages/sdlc-core/src/a11y.js — the always-on accessibility floor (spec v3 B.5).
 *
 * B.5 names three checks that are ALWAYS on, owned by the Accessibility
 * Engineer: basic contrast on primary text, images have alt text, and form
 * controls have label associations — plus keyboard focus must be visible on
 * every interactive element. These are pure predicates over a DOM description
 * so they run in the gate suite without a browser; the Playwright layer feeds
 * them real measurements.
 */

/** WCAG relative luminance for a #rgb / #rrggbb colour. */
export function relativeLuminance(hex) {
  const value = String(hex).replace(/^#/, '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`invalid colour: ${hex}`);
  const channel = (c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(full.slice(0, 2));
  const g = channel(full.slice(2, 4));
  const b = channel(full.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(foreground, background) {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG 2.1 AA thresholds: 4.5:1 for normal text, 3:1 for large text (≥18.66px
 * bold or ≥24px) and for UI components.
 */
export function meetsContrast(foreground, background, { large = false, level = 'AA' } = {}) {
  const ratio = contrastRatio(foreground, background);
  const threshold = level === 'AAA' ? (large ? 4.5 : 7) : (large ? 3 : 4.5);
  return { pass: ratio >= threshold, ratio: Number(ratio.toFixed(2)), threshold };
}

/** Every meaningful image must carry a non-empty alt attribute. */
export function checkAltText(images = []) {
  const violations = [];
  for (const img of images) {
    if (img.decorative) continue; // role="presentation"/aria-hidden is legitimate
    if (!img.alt || String(img.alt).trim() === '') {
      violations.push({ check: 'alt-text', element: img.selector ?? img.src ?? '<img>', reason: 'missing alt text' });
    }
  }
  return violations;
}

/** Every form control must have a label association (for/id, aria-label or aria-labelledby). */
export function checkLabels(controls = []) {
  const violations = [];
  for (const control of controls) {
    const labelled = Boolean(control.label) || Boolean(control['aria-label']) || Boolean(control['aria-labelledby']);
    if (!labelled) {
      violations.push({ check: 'label-association', element: control.selector ?? control.name ?? '<control>', reason: 'no label association' });
    }
  }
  return violations;
}

/** Keyboard focus must be visible on every interactive element. */
export function checkFocusVisible(elements = []) {
  const violations = [];
  for (const element of elements) {
    if (!element.interactive) continue;
    if (element.focusVisible === false) {
      violations.push({ check: 'focus-visible', element: element.selector ?? '<element>', reason: 'no visible focus indicator' });
    }
  }
  return violations;
}

/**
 * Run the floor. `measurements` come from either the Playwright layer or a
 * fixture; absence of a measurement is a SKIP for that check, never a pass.
 */
export function runA11yFloor({ images = null, controls = null, interactive = null, textSamples = null, enabled = true } = {}) {
  if (!enabled) return { pass: true, checks: [{ check: 'a11y-floor', status: 'skipped:disabled' }] };
  const checks = [];
  const violations = [];

  const add = (name, data, fn) => {
    if (data == null) { checks.push({ check: name, status: 'skipped:no-measurement' }); return; }
    const found = fn(data);
    violations.push(...found);
    checks.push({ check: name, status: found.length ? 'fail' : 'pass', violations: found.length });
  };

  add('alt-text', images, checkAltText);
  add('label-association', controls, checkLabels);
  add('focus-visible', interactive, checkFocusVisible);

  if (textSamples == null) {
    checks.push({ check: 'contrast', status: 'skipped:no-measurement' });
  } else {
    const contrastViolations = [];
    for (const sample of textSamples) {
      const result = meetsContrast(sample.color, sample.background, { large: sample.large });
      if (!result.pass) {
        contrastViolations.push({ check: 'contrast', element: sample.selector ?? '<text>', reason: `ratio ${result.ratio} < ${result.threshold}` });
      }
    }
    violations.push(...contrastViolations);
    checks.push({ check: 'contrast', status: contrastViolations.length ? 'fail' : 'pass', violations: contrastViolations.length });
  }

  return {
    pass: violations.length === 0,
    // A stable, documented order (A11Y_FLOOR_CHECKS) so evidence bundles are
    // comparable across runs.
    checks: checks.sort((a, b) => A11Y_FLOOR_CHECKS.indexOf(a.check) - A11Y_FLOOR_CHECKS.indexOf(b.check)),
    violations,
  };
}

export const A11Y_FLOOR_CHECKS = ['contrast', 'alt-text', 'label-association', 'focus-visible'];

export default { contrastRatio, meetsContrast, checkAltText, checkLabels, checkFocusVisible, runA11yFloor, A11Y_FLOOR_CHECKS };
