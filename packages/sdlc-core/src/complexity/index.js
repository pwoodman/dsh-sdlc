/**
 * packages/sdlc-core/src/complexity/index.js — complexity engine v2 (spec v3 B.1).
 *
 * Pure arithmetic: every feature has a deterministic extraction rule and is
 * normalized to [0,1] before weighting; the weights sum to exactly 1.0, so
 * `score ∈ [0,1]` by construction. LLM involvement is limited to producing the
 * structured estimate (the integers/booleans below) — never the score.
 *
 * Determinism contract: same repo state + same requirement ⇒ same score.
 *
 * NOTE ON SPEC G.2.1: the illustrative unit test in Part G asserts
 * `normalizeFeature('files', 1) < 0.1`. The normative formula in B.1 is
 * `min(ln(1+F)/ln(201), 1)`, which yields ≈0.131 for F=1. Part B is normative,
 * so the formula is implemented as written and the test asserts the real value
 * (see SDLC_IMPLEMENTATION_NOTES.md, discrepancy D1).
 */

/** Feature weights — must sum to exactly 1.0 (asserted in unit tests). */
export const WEIGHTS = Object.freeze({
  d: 0.15,
  f: 0.10,
  i: 0.15,
  db: 0.10,
  sec: 0.10,
  ui: 0.10,
  e: 0.10,
  dep: 0.10,
  t: 0.10,
});

export const FILE_SCALE_LN = Math.log(201);

export const BANDS = Object.freeze([
  { name: 'Tiny', lo: 0.0, hi: 0.25 },
  { name: 'Small', lo: 0.25, hi: 0.45 },
  { name: 'Medium', lo: 0.45, hi: 0.65 },
  { name: 'Large', lo: 0.65, hi: 0.8 },
  { name: 'Enterprise', lo: 0.8, hi: 1.0 },
]);

function clamp01(n) {
  if (Number.isNaN(n) || n == null) return 0;
  return Math.min(1, Math.max(0, n));
}

function intIn(value, lo, hi, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function bool01(value) {
  return value ? 1 : 0;
}

/**
 * Normalize a single feature. Exported because Part K.3 property-tests each
 * normalization for monotonicity and range.
 */
export function normalizeFeature(name, value) {
  switch (name) {
    case 'domains': return clamp01(intIn(value, 0, 1000, 0) / 5);
    case 'files': {
      const f = intIn(value, 0, 1000, 0);
      return clamp01(Math.log(1 + f) / FILE_SCALE_LN);
    }
    case 'integrations': return clamp01(intIn(value, 0, 1000, 0) / 5);
    case 'external_deps': return clamp01(intIn(value, 0, 1000, 0) / 10);
    case 'testing': {
      const t = Number(value);
      if (t >= 1) return 1;
      if (t >= 0.5) return 0.5;
      return 0;
    }
    case 'db': case 'sec': case 'ui': case 'dep': return bool01(value);
    default: throw new Error(`unknown feature: ${name}`);
  }
}

/** Band lookup; half-open `[lo, hi)` except the last band, which is closed. */
export function bandFor(score, bands = BANDS) {
  const s = clamp01(score);
  for (let i = 0; i < bands.length; i += 1) {
    const b = bands[i];
    const isLast = i === bands.length - 1;
    if (s >= b.lo && (isLast ? s <= b.hi : s < b.hi)) return b.name;
  }
  return bands[bands.length - 1].name;
}

/**
 * Security classifier for the `sec` feature (B.1): a security-sensitive
 * `allowed_paths` glob OR a requirement mentioning auth/authz/payments/PII.
 */
export const SECURITY_PATH_PATTERNS = [
  '**/auth*', '**/*auth*', '**/*token*', '**/*secret*', '**/*credential*',
  '**/crypto*', '**/*permission*', '**/*session*', '**/*cors*', '**/*csrf*',
];
export const SECURITY_REQUIREMENT_TERMS = [
  'auth', 'authz', 'authorization', 'authentication', 'payment', 'pii',
  'password', 'credential', 'secret', 'token', 'permission', 'encrypt',
  'oauth', 'sso', 'login',
];

/**
 * Compute the complexity score.
 * @param {object} input structured estimate (validated integers/booleans)
 * @returns {{score:number, band:string, normalized:object, weights:object}}
 */
export function computeComplexity(input = {}) {
  const normalized = {
    d: normalizeFeature('domains', input.domains),
    f: normalizeFeature('files', input.files),
    i: normalizeFeature('integrations', input.integrations),
    db: normalizeFeature('db', input.db),
    sec: normalizeFeature('sec', input.sec),
    ui: normalizeFeature('ui', input.ui),
    e: normalizeFeature('external_deps', input.external_deps),
    dep: normalizeFeature('dep', input.dep),
    t: normalizeFeature('testing', input.testing),
  };
  const score = clamp01(
    WEIGHTS.d * normalized.d +
    WEIGHTS.f * normalized.f +
    WEIGHTS.i * normalized.i +
    WEIGHTS.db * normalized.db +
    WEIGHTS.sec * normalized.sec +
    WEIGHTS.ui * normalized.ui +
    WEIGHTS.e * normalized.e +
    WEIGHTS.dep * normalized.dep +
    WEIGHTS.t * normalized.t,
  );
  return { score, band: bandFor(score), normalized, weights: WEIGHTS };
}

/** Detect the project's impure `sec` flag from repo/requirement context (B.1). */
export function deriveSec({ allowedPaths = [], requirement = '' } = {}) {
  for (const p of allowedPaths) {
    if (/(^|[\/_.-])(auth|token|secret|credential|crypto|permission|session|cors|csrf)/i.test(String(p))) return true;
  }
  const text = String(requirement).toLowerCase();
  return SECURITY_REQUIREMENT_TERMS.some((t) => text.includes(t));
}

/**
 * task_class (B.8): trivial = single-file/mechanical, architectural =
 * contracts/schemas/cross-cutting, normal = everything else.
 */
export function classifyTask({ estimate = {}, domains = [], objective = '' } = {}) {
  const files = Number(estimate.files ?? 0);
  const text = String(objective).toLowerCase();
  const architectural = domains.some((d) =>
    ['architecture', 'database', 'data-pipeline', 'integration', 'security'].includes(d),
  ) || /schema|migration|contract|interface|architecture|refactor|cross-cutting/.test(text);
  if (architectural) return 'architectural';
  if (files <= 1 && domains.length <= 1) return 'trivial';
  return 'normal';
}

export default { computeComplexity, normalizeFeature, bandFor, WEIGHTS, BANDS, classifyTask };
