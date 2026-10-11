/**
 * packages/sdlc-core/src/risk.js — risk classes and verification gates (spec v3 B.4).
 *
 * Risk class comes from the complexity FEATURES, not the score alone
 * (B.4: "Match top-down; first row whose condition holds wins"). R4 is tested
 * first so security or shared-resource risk can never be downgraded.
 */

export const GATE_ORDER = ['syntax', 'types', 'lint', 'unit', 'integration', 'api', 'e2e', 'visual', 'security', 'perf', 'build'];

export const RISK_ORDER = ['R1', 'R2', 'R3', 'R4'];

/**
 * @param {{sec?:boolean, ui?:boolean, score?:number, resources?:string[]}} features
 * @returns {'R1'|'R2'|'R3'|'R4'}
 */
export function riskClass({ sec = false, ui = false, score = 0, resources = [] } = {}) {
  if (sec || (resources?.length ?? 0) > 0 || score >= 0.65) return 'R4';
  if (ui || score >= 0.45) return 'R3';
  if (score >= 0.25) return 'R2';
  return 'R1';
}

/** Appearance-only classifier (acceptance Test 1). */
export const APPEARANCE_PATTERNS = [
  /\.css$/i, /\.scss$/i, /\.less$/i, /\.sass$/i, /\.styl$/i,
  /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i, /\.(woff2?|ttf|otf)$/i,
];
export const APPEARANCE_TEMPLATE = [/(^|\/)templates?\//i, /\.(html|hbs|ejs|pug|njk)$/i];
export const LOGIC_PATTERNS = [
  /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|rb|java|kt|cs|php)$/i,
  /(^|\/)(routing|routes?|state|store|reducers?)\//i,
  /tailwind\.config\./i,
];

/** True when a diff changes appearance only (no logic, routing or state). */
export function isAppearanceOnly(filesChanged = []) {
  if (filesChanged.length === 0) return false;
  let appearance = 0;
  for (const f of filesChanged) {
    if (LOGIC_PATTERNS.some((re) => re.test(f))) return false;
    if (APPEARANCE_PATTERNS.some((re) => re.test(f)) || APPEARANCE_TEMPLATE.some((re) => re.test(f))) appearance += 1;
  }
  return appearance === filesChanged.length;
}

/** UI classifier used by both the B.4 gates and the B.5 visual trigger. */
export const UI_PATTERNS = [
  /\.(css|scss|less|html|jsx|tsx|vue|svelte)$/i,
  /(^|\/)templates?\//i,
  /tailwind\.config\./i,
  /(^|\/)(routing|layout)\//i,
];

export function isUiChange(filesChanged = []) {
  return filesChanged.some((f) => UI_PATTERNS.some((re) => re.test(f)));
}

/** Responsive markers decide full viewport matrix vs desktop only (B.5). */
export const RESPONSIVE_PATTERNS = [/@media/i, /breakpoint/i, /tailwind\.config\./i, /(^|\/)(grid|flex)\b/i];

export function needsFullViewportMatrix({ filesChanged = [], contents = [] } = {}) {
  const haystack = contents.join('\n');
  return RESPONSIVE_PATTERNS.some((re) => re.test(haystack))
    || filesChanged.some((f) => /tailwind\.config\./.test(f));
}

/**
 * The gates a task must pass, in fixed fail-fast order (B.4.1).
 * Skipped gates are recorded as `skipped:<reason>` — evidence is explicit.
 * @returns {Array<{gate:string, required:boolean, skipped?:string}>}
 */
export function requiredGates(risk, {
  domains = [],
  uiChange = false,
  appearanceOnly = false,
  visualTrigger = false,
  hasBrowserStack = true,
  perfTrigger = false,
  gateCommands = {},
} = {}) {
  let gates;
  switch (risk) {
    case 'R4':
      gates = ['syntax', 'types', 'lint', 'unit', 'integration', 'security'];
      if (domains.includes('api')) gates.push('api');
      if (uiChange) gates.push('e2e', 'visual');
      break;
    case 'R3':
      gates = ['syntax', 'lint', 'unit', 'integration'];
      if (domains.includes('api')) gates.push('api');
      if (uiChange) gates.push('e2e');
      if (visualTrigger || uiChange) gates.push('visual');
      break;
    case 'R2':
      gates = ['syntax', 'lint', 'unit', 'integration'];
      // §53 Test 2 ("New API": unit+integration+api) with B.4's R2 minimum: the
      // api gate is added whenever the api domain is implicated.
      if (domains.includes('api')) gates.push('api');
      break;
    default:
      gates = ['syntax', 'lint', 'unit'];
  }
  if (perfTrigger) gates.push('perf');

  // Appearance-vs-behaviour refinement (acceptance Test 1): a button-colour
  // change verifies visually, not through an end-to-end suite.
  if (appearanceOnly) {
    gates = gates.filter((g) => g !== 'integration' && g !== 'e2e');
    if (!gates.includes('visual')) gates.push('visual');
  }

  gates = [...new Set(gates)].sort((a, b) => GATE_ORDER.indexOf(a) - GATE_ORDER.indexOf(b));

  return gates.map((gate) => {
    const configured = gateCommands[gate];
    const disabled = configured === false || configured?.skip === true;
    const skip = disabled
      ? `skipped:${configured?.reason ?? 'not-configured'}`
      : (hasBrowserStack ? undefined : (gate === 'e2e' || gate === 'visual' ? 'skipped:no-browser-stack' : undefined));
    return { gate, required: !skip, skipped: skip };
  });
}

/**
 * R3+ tasks touching UI are BLOCKED, not auto-accepted, when no browser stack
 * exists (L.5 explicit policy choice: a skipped gate is not a passed gate).
 */
export function blockedBySkippedGate(risk, gates) {
  if (risk !== 'R3' && risk !== 'R4') return false;
  return gates.some((g) => g.skipped && (g.gate === 'visual' || g.gate === 'e2e'));
}

/**
 * Behavioural test rule (spec §24): production code changed and no test file
 * changed ⇒ auto-REJECT with NO_TEST_EVIDENCE.
 */
export const TEST_FILE_PATTERNS = [
  /(^|\/)tests?\//i, /(^|\/)__tests__\//i, /(^|\/)spec\//i,
  /\.(test|spec)\.[a-z0-9]+$/i, /(^|\/)test_[^/]+\.py$/i, /_test\.go$/i,
];
export const NON_PRODUCTION_PATTERNS = [
  /\.(md|mdx|txt|rst)$/i, /(^|\/)docs?\//i, /\.(json|ya?ml|toml|ini|env)$/i,
  /(^|\/)\.github\//i, /(^|\/)CHANGELOG/i, /(^|\/)LICENSE/i,
];

export function isTestFile(path) {
  return TEST_FILE_PATTERNS.some((re) => re.test(path));
}

export function isProductionCode(path) {
  if (isTestFile(path)) return false;
  return !NON_PRODUCTION_PATTERNS.some((re) => re.test(path));
}

export function violatesBehavioralTestRule(filesChanged = []) {
  // B.4 appearance-vs-behaviour refinement (acceptance Test 1): an
  // appearance-only diff verifies VISUALLY, so the "production code needs a
  // test change" rule does not apply to it. Without this, a button-colour
  // change would be rejected with NO_TEST_EVIDENCE.
  if (isAppearanceOnly(filesChanged)) return false;
  const production = filesChanged.filter(isProductionCode);
  if (production.length === 0) return false;
  return !filesChanged.some(isTestFile);
}

export default {
  riskClass, requiredGates, isAppearanceOnly, isUiChange, violatesBehavioralTestRule, GATE_ORDER,
};
