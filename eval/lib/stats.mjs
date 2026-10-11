/**
 * eval/lib/stats.mjs — paired statistics for the A/B evaluation (zero dependencies).
 *
 * The evaluation is a PAIRED design: every task is run in both arms on the same
 * machine, with the same model and prompt. That pairing is what makes a small n
 * usable, so the functions here all take per-pair differences.
 *
 * Everything is deterministic: bootstrap resampling uses a seeded PRNG, and the
 * Wilcoxon test is EXACT (dynamic programming over the subset-sum distribution)
 * whenever the sample is small and tie-free, falling back to the tie-corrected
 * normal approximation otherwise. `exact` is reported so a reader always knows
 * which one produced the p-value.
 */

/** Seeded PRNG (mulberry32) so a bootstrap CI is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs) {
  if (!xs.length) return Number.NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs) {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sample standard deviation (ddof = 1). */
export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Linear-interpolation quantile (matches numpy's default). */
export function quantile(xs, p) {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// ── normal distribution helpers ─────────────────────────────────────────────

/** erf via Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x) {
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.15e-9). */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error(`normalQuantile: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const pu = 1 - pl;
  let q;
  let r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pu) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ── effect + interval estimation ────────────────────────────────────────────

/**
 * Paired bootstrap CI for a location statistic of the differences.
 * @param {number[]} diffs  per-pair (treatment − control)
 * @returns {{statistic:number, lo:number, hi:number, level:number, B:number, seed:number}}
 */
export function bootstrapCI(diffs, { statistic = 'median', B = 10000, alpha = 0.05, seed = 0xC0FFEE } = {}) {
  const fn = statistic === 'mean' ? mean : median;
  const point = fn(diffs);
  if (diffs.length === 0) return { statistic: point, lo: Number.NaN, hi: Number.NaN, level: 1 - alpha, B: 0, seed };
  const rng = mulberry32(seed);
  const reps = new Array(B);
  for (let i = 0; i < B; i += 1) {
    const sample = new Array(diffs.length);
    for (let j = 0; j < diffs.length; j += 1) sample[j] = diffs[Math.floor(rng() * diffs.length)];
    reps[i] = fn(sample);
  }
  return {
    statistic: point,
    lo: quantile(reps, alpha / 2),
    hi: quantile(reps, 1 - alpha / 2),
    level: 1 - alpha,
    B,
    seed,
  };
}

/** Cohen's dz for paired data = mean(diff) / sd(diff). */
export function cohensDz(diffs) {
  const sd = stdev(diffs);
  return sd === 0 ? 0 : mean(diffs) / sd;
}

/**
 * Paired dominance (a paired analogue of Cliff's delta): the probability that
 * the treatment is higher than the control minus the reverse, over all pairs.
 * Range [-1, 1]; 0 = no consistent direction.
 */
export function pairedDominance(diffs) {
  if (!diffs.length) return Number.NaN;
  let pos = 0;
  let neg = 0;
  for (const d of diffs) {
    if (d > 0) pos += 1;
    else if (d < 0) neg += 1;
  }
  return (pos - neg) / diffs.length;
}

// ── hypothesis test ─────────────────────────────────────────────────────────

/** Two-sided exact W+ distribution via subset-sum DP over ranks 1..n. */
function exactWPlusPValue(wPlus, n) {
  const maxW = (n * (n + 1)) / 2;
  const dp = new Array(maxW + 1).fill(0);
  dp[0] = 1;
  for (let r = 1; r <= n; r += 1) {
    for (let k = maxW; k >= r; k -= 1) dp[k] += dp[k - r];
  }
  const total = 2 ** n;
  const cdf = (x) => {
    const hi = Math.min(Math.floor(x), maxW);
    if (hi < 0) return 0;
    let sum = 0;
    for (let k = 0; k <= hi; k += 1) sum += dp[k];
    return sum / total;
  };
  const pLow = cdf(wPlus);
  const pHigh = 1 - cdf(wPlus - 1);
  return Math.min(1, 2 * Math.min(pLow, pHigh));
}

/**
 * Two-sided Wilcoxon signed-rank test on per-pair differences.
 *
 * Exact (tie-free, n ≤ 20) or tie-corrected normal approximation otherwise.
 * Zero differences are discarded, as the test requires.
 *
 * @returns {{n:number, wPlus:number, wMinus:number, p:number, exact:boolean, method:string, z:number|null}}
 */
export function wilcoxonSignedRank(diffs) {
  const d = diffs.filter((x) => x !== 0 && Number.isFinite(x));
  const n = d.length;
  if (n === 0) return { n: 0, wPlus: 0, wMinus: 0, p: 1, exact: true, method: 'degenerate-no-nonzero-differences', z: null };

  const abs = d.map(Math.abs);
  const sorted = [...abs].sort((a, b) => a - b);
  // Average ranks for ties.
  const ranks = abs.map((v) => {
    const first = sorted.indexOf(v);
    const last = sorted.lastIndexOf(v);
    return (first + last) / 2 + 1;
  });
  let wPlus = 0;
  let wMinus = 0;
  d.forEach((x, i) => { if (x > 0) wPlus += ranks[i]; else wMinus += ranks[i]; });

  const tieGroups = new Map();
  for (const v of abs) tieGroups.set(v, (tieGroups.get(v) ?? 0) + 1);
  const hasTies = [...tieGroups.values()].some((t) => t > 1);

  if (!hasTies && n <= 20) {
    return { n, wPlus, wMinus, p: exactWPlusPValue(wPlus, n), exact: true, method: 'exact-two-sided', z: null };
  }

  const mu = (n * (n + 1)) / 4;
  const tieSum = [...tieGroups.values()].reduce((s, t) => s + (t ** 3 - t), 0);
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieSum / 48;
  if (variance <= 0) return { n, wPlus, wMinus, p: 1, exact: false, method: 'degenerate-zero-variance', z: 0 };
  const sd = Math.sqrt(variance);
  // Continuity correction toward the mean.
  const cc = wPlus === mu ? 0 : 0.5 * Math.sign(wPlus - mu);
  const z = (wPlus - mu - cc) / sd;
  const p = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  return { n, wPlus, wMinus, p, exact: false, method: hasTies ? 'normal-approx-tie-corrected' : 'normal-approx', z };
}

/**
 * Holm–Bonferroni step-down correction over a family of p-values.
 * @param {Array<{label:string, p:number}>} items
 */
export function holmBonferroni(items, alpha = 0.05) {
  const sorted = [...items].sort((a, b) => a.p - b.p);
  const m = sorted.length;
  const out = [];
  let rejecting = true;
  sorted.forEach((item, i) => {
    const threshold = alpha / (m - i);
    const reject = rejecting && item.p <= threshold;
    if (!reject) rejecting = false;
    out.push({ label: item.label, p: item.p, threshold, rejected: reject });
  });
  return out;
}

/**
 * Required number of PAIRS for a paired design to detect a given effect.
 * n = ceil((z_{1-α/2} + z_{power})² / dz²).
 */
export function pairedSampleSize(dz, { alpha = 0.05, power = 0.8 } = {}) {
  if (!(dz > 0)) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.max(2, Math.ceil((z * z) / (dz * dz)));
}

export default {
  mulberry32, mean, median, stdev, quantile, erf, normalCdf, normalQuantile,
  bootstrapCI, cohensDz, pairedDominance, wilcoxonSignedRank, holmBonferroni, pairedSampleSize,
};
