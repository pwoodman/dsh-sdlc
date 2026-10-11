/**
 * scripts/lib/semver-lite.mjs — the one piece of semver the version checks need.
 *
 * Zero dependencies (deviation D0). Supports exactly the two operations the
 * plugin's compatibility checks use:
 *   - compare(a, b): full semver precedence, including prerelease rules
 *   - satisfies(v, ">=A <B"): the AND of lower/upper bounds (inclusive >=, exclusive <)
 *
 * The plugin's DSH peer range is `>=0.2.0-rc.2 <0.3.0-0`:
 *   - inclusive lower bound: the version the ground truth was verified against
 *   - exclusive upper bound `0.3.0-0`: every 0.2.x (including prereleases such
 *     as 0.2.1-alpha.2), excluding 0.3.0 itself AND its prereleases — the 0.3
 *     line may change the plugin contract, so it is out of range by design.
 */

const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+(?:\.[0-9A-Za-z.-]+)*))?$/;

/** Parse a version or return null. */
export function parse(version) {
  if (typeof version !== 'string') return null;
  const m = RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? null : m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
  };
}

function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Identifier precedence per semver §11: numeric < alphanumeric, numeric numerically, alpha ASCII. */
function cmpPreId(a, b) {
  const aNum = typeof a === 'number';
  const bNum = typeof b === 'number';
  if (aNum && bNum) return cmpNum(a, b);
  if (aNum) return -1; // numeric identifiers have lower precedence
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Full semver precedence comparison; negative/0/positive like Array.sort. */
export function compare(a, b) {
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) throw new Error(`semver-lite: invalid version ${!va ? a : b}`);
  const core = cmpNum(va.major, vb.major) || cmpNum(va.minor, vb.minor) || cmpNum(va.patch, vb.patch);
  if (core !== 0) return core;
  // No prerelease > any prerelease (semver §11.3).
  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  const len = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < len; i++) {
    if (i >= va.pre.length) return -1; // fewer fields = lower precedence
    if (i >= vb.pre.length) return 1;
    const c = cmpPreId(va.pre[i], vb.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Evaluate `>=A <B` (whitespace-separated bounds; `>=` inclusive, `<` exclusive).
 * Bounds must be full versions. Anything else throws — silently loosening a
 * compatibility check is worse than refusing to run.
 */
export function satisfies(version, range) {
  const bounds = String(range).trim().split(/\s+/);
  if (bounds.length === 0) throw new Error('semver-lite: empty range');
  for (const bound of bounds) {
    const ge = bound.startsWith('>=');
    const lt = bound.startsWith('<');
    if (!ge && !lt) throw new Error(`semver-lite: unsupported bound ${bound} (only >= and <)`);
    const v = bound.slice(ge ? 2 : 1);
    if (parse(v) === null) throw new Error(`semver-lite: invalid bound version ${v}`);
    const c = compare(version, v);
    if (ge && c < 0) return false;
    if (lt && c >= 0) return false;
  }
  return true;
}

/** The peer range every shippable package declares (P36, beta.2). */
export const DSH_PEER_RANGE = '>=0.2.0-rc.2 <0.3.0-0';

/** Whether a runtime version satisfies the plugin's declared DSH peer range. */
export function dshPeerSatisfied(runtimeVersion) {
  return parse(runtimeVersion) !== null && satisfies(runtimeVersion, DSH_PEER_RANGE);
}
