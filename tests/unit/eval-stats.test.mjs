/**
 * tests/unit/eval-stats.test.mjs — the A/B evaluation statistics (eval/lib/stats.mjs).
 *
 * These are the numbers the whole evaluation rests on, so each is pinned against
 * a closed-form or textbook value rather than "it ran".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, median, stdev, quantile, erf, normalCdf, normalQuantile,
  bootstrapCI, cohensDz, pairedDominance, wilcoxonSignedRank, holmBonferroni, pairedSampleSize, mulberry32,
} from '../../eval/lib/stats.mjs';

test('descriptive statistics match closed-form values', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(stdev([1, 2, 3]), 1);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  assert.ok(Number.isNaN(mean([])));
});

test('normal helpers match known values', () => {
  assert.equal(normalCdf(0), 0.5);
  assert.ok(Math.abs(normalCdf(1.959963985) - 0.975) < 1e-6);
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959963985) < 1e-6);
  assert.ok(Math.abs(normalQuantile(0.8) - 0.8416212336) < 1e-6);
  assert.equal(normalQuantile(0.5), 0);
  assert.ok(Math.abs(erf(1) - 0.8427007929) < 1e-6);
  assert.throws(() => normalQuantile(0), /p must be in/);
});

test('pairedSampleSize matches the closed form and shrinks with larger effects', () => {
  // ((1.959964 + 0.841621)^2) / 0.25 = 31.40 → 32
  assert.equal(pairedSampleSize(0.5), 32);
  assert.equal(pairedSampleSize(1), 8);
  assert.ok(pairedSampleSize(0.8) > pairedSampleSize(0.9));
  assert.equal(pairedSampleSize(0), Number.POSITIVE_INFINITY);
});

test('cohensDz and paired dominance', () => {
  assert.equal(cohensDz([1, 2, 3]), 2);
  assert.equal(cohensDz([0, 0, 0]), 0);
  assert.equal(pairedDominance([1, -1, 2, 0]), 0.25);
  assert.equal(pairedDominance([1, 1, 1]), 1);
});

test('bootstrap CI is reproducible, bracketed and degenerate-safe', () => {
  const a = bootstrapCI([5, 5, 5, 5], { seed: 7 });
  assert.deepEqual({ lo: a.lo, hi: a.hi, statistic: a.statistic }, { lo: 5, hi: 5, statistic: 5 });
  const diffs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b1 = bootstrapCI(diffs, { seed: 42, B: 2000 });
  const b2 = bootstrapCI(diffs, { seed: 42, B: 2000 });
  assert.deepEqual(b1, b2, 'same seed ⇒ identical CI');
  assert.ok(b1.lo <= b1.statistic && b1.statistic <= b1.hi);
  assert.equal(b1.B, 2000);
});

test('wilcoxon exact p-value for all-positive differences', () => {
  // n=5, W+=15, only the all-negative sign vector gives W+<=0 ⇒ p = 2/32.
  const five = wilcoxonSignedRank([1, 2, 3, 4, 5]);
  assert.equal(five.exact, true);
  assert.equal(five.wPlus, 15);
  assert.equal(five.wMinus, 0);
  assert.equal(five.p, 2 / 32);

  const four = wilcoxonSignedRank([1, 2, 3, 4]);
  assert.equal(four.p, 2 / 16);
});

test('wilcoxon discards zeros and is symmetric under sign flip', () => {
  const a = wilcoxonSignedRank([1, 2, 3, 4, 0]);
  assert.equal(a.n, 4);
  const b = wilcoxonSignedRank([-1, -2, -3, -4]);
  assert.equal(Math.abs(a.p - b.p) < 1e-12, true);
  assert.equal(wilcoxonSignedRank([0, 0]).p, 1);
});

test('wilcoxon falls back to the tie-corrected normal approximation with ties', () => {
  const d = [1, 1, 2, 2, 3, 3, 4, 5, 6, 7];
  const res = wilcoxonSignedRank(d);
  assert.equal(res.exact, false);
  assert.equal(res.method, 'normal-approx-tie-corrected');
  assert.ok(res.p > 0 && res.p <= 1);
  assert.ok(Number.isFinite(res.z));
});

test('holmBonferroni is a step-down procedure that stops at the first failure', () => {
  const out = holmBonferroni([
    { label: 'a', p: 0.01 }, { label: 'b', p: 0.02 },
    { label: 'c', p: 0.03 }, { label: 'd', p: 0.04 },
  ], 0.05);
  assert.deepEqual(out.map((o) => o.label), ['a', 'b', 'c', 'd']);
  assert.deepEqual(out.map((o) => o.rejected), [true, false, false, false]);
  assert.ok(Math.abs(out[0].threshold - 0.0125) < 1e-12);
  assert.ok(Math.abs(out[3].threshold - 0.05) < 1e-12);
});

test('the seeded PRNG is deterministic and in [0,1)', () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  const xs = Array.from({ length: 5 }, () => a());
  const ys = Array.from({ length: 5 }, () => b());
  assert.deepEqual(xs, ys);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});
