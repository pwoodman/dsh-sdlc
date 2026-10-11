/**
 * packages/sdlc-core/src/visual.js — visual QA pipeline (spec v3 B.5).
 *
 * Trigger: changed files match the UI classifier. Viewport matrix: the full
 * 1440x900 / 1024x768 / 390x844 matrix iff responsive markers are present,
 * otherwise desktop only. The AI rubric is a FIXED shape and `verdict=fail`
 * requires at least one defect of severity ≥ medium. Two consecutive visual
 * failures escalate rather than re-running blindly.
 */

import { RESPONSIVE_PATTERNS, UI_PATTERNS } from './risk.js';

export const VIEWPORTS = ['1440x900', '1024x768', '390x844'];
export const SEVERITIES = ['high', 'medium', 'low'];
export const CATEGORIES = [
  'overflow', 'clipping', 'overlap', 'alignment', 'spacing',
  'hierarchy', 'consistency', 'missing-control', 'unusable-state',
];

/** The B.5 automated checks, per viewport. */
export const AUTOMATED_CHECKS = [
  'no-horizontal-overflow',
  'no-clipped-or-overlapping-controls',
  'acceptance-elements-present',
  'console-errors-zero',
  'failed-requests-zero',
  'primary-text-contrast',
  'focus-visible',
  'images-have-alt-text',
  'controls-have-labels',
];

export function visualTriggered(filesChanged = []) {
  return filesChanged.some((f) => UI_PATTERNS.some((re) => re.test(f)));
}

/** Full matrix iff responsive markers are present, else desktop only. */
export function viewportMatrix({ filesChanged = [], contents = [], mode = 'auto', viewports = VIEWPORTS } = {}) {
  const responsive = mode === 'always'
    || (mode !== 'never' && (RESPONSIVE_PATTERNS.some((re) => re.test(contents.join('\n'))) || filesChanged.some((f) => /tailwind\.config\./.test(f))));
  return responsive ? [...viewports] : [viewports[0]];
}

/** Parse and validate the fixed AI visual rubric (B.5). */
export function parseVisualRubric(raw) {
  let doc = raw;
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw); } catch { return { ok: false, error: 'RUBRIC_MALFORMED' }; }
  }
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'RUBRIC_MALFORMED' };
  if (typeof doc.viewport !== 'string' || doc.viewport.length === 0) return { ok: false, error: 'RUBRIC_MALFORMED: viewport' };
  if (!['pass', 'fail'].includes(doc.verdict)) return { ok: false, error: 'RUBRIC_MALFORMED: verdict' };
  const defects = Array.isArray(doc.defects) ? doc.defects : null;
  if (!defects) return { ok: false, error: 'RUBRIC_MALFORMED: defects' };
  for (const d of defects) {
    if (!SEVERITIES.includes(d.severity)) return { ok: false, error: `RUBRIC_MALFORMED: severity ${d.severity}` };
    if (!CATEGORIES.includes(d.category)) return { ok: false, error: `RUBRIC_MALFORMED: category ${d.category}` };
    if (typeof d.description !== 'string' || d.description.length === 0) return { ok: false, error: 'RUBRIC_MALFORMED: description' };
  }
  // A `fail` verdict must be justified by a defect of severity >= medium.
  if (doc.verdict === 'fail' && !defects.some((d) => d.severity === 'high' || d.severity === 'medium')) {
    return { ok: false, error: 'RUBRIC_INCONSISTENT: fail verdict without a medium+ defect' };
  }
  return { ok: true, value: { viewport: doc.viewport, verdict: doc.verdict, defects } };
}

/** Automated per-viewport measurements → pass/fail, with skips never green. */
export function evaluateVisualChecks(measurements = {}) {
  const results = {};
  const map = [
    ['no-horizontal-overflow', (m) => m.scrollWidth == null || m.innerWidth == null ? null : m.scrollWidth <= m.innerWidth],
    ['no-clipped-or-overlapping-controls', (m) => m.clippedOrOverlapping == null ? null : m.clippedOrOverlapping === 0],
    ['acceptance-elements-present', (m) => m.missingAcceptanceElements == null ? null : m.missingAcceptanceElements.length === 0],
    ['console-errors-zero', (m) => m.consoleErrors == null ? null : m.consoleErrors === 0],
    ['failed-requests-zero', (m) => m.failedRequests == null ? null : m.failedRequests === 0],
    ['primary-text-contrast', (m) => m.contrastOk == null ? null : m.contrastOk === true],
    ['focus-visible', (m) => m.focusVisibleOk == null ? null : m.focusVisibleOk === true],
    ['images-have-alt-text', (m) => m.imagesMissingAlt == null ? null : m.imagesMissingAlt === 0],
    ['controls-have-labels', (m) => m.controlsMissingLabel == null ? null : m.controlsMissingLabel === 0],
  ];
  for (const [name, fn] of map) {
    const value = fn(measurements);
    results[name] = value == null ? 'skipped:no-measurement' : (value ? 'pass' : 'fail');
  }
  return results;
}

/** Two consecutive visual failures on the same task ⇒ ESCALATED (B.5). */
export function visualFailureEscalates(attempts = [], { threshold = 2, gate = 'visual' } = {}) {
  let consecutive = 0;
  for (const attempt of attempts) {
    const failed = (attempt.gates ?? {})[gate];
    if (failed && String(failed).startsWith('fail')) consecutive += 1;
    else if (failed) consecutive = 0;
  }
  return { escalate: consecutive >= threshold, consecutive };
}

export default {
  VIEWPORTS, AUTOMATED_CHECKS, visualTriggered, viewportMatrix, parseVisualRubric,
  evaluateVisualChecks, visualFailureEscalates,
};
