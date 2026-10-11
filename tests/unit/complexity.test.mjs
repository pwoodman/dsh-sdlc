/**
 * tests/unit/complexity.test.mjs — complexity engine (spec v3 B.1, G.2.1, K.3).
 *
 * DISCREPANCY D1 (documented, not silently absorbed): the illustrative test in
 * Part G.2.1 asserts `normalizeFeature('files', 1) < 0.1`. The normative formula
 * in B.1 is `min(ln(1+F)/ln(201), 1)`, which gives ≈0.1307 for F=1. Part B is
 * normative, so the formula is implemented as written and asserted here; Part G
 * was the illustrative layer (Part K supersedes it).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, mulberry32, intBetween } from '../lib/helpers.mjs';

const { computeComplexity, normalizeFeature, bandFor, classifyTask, deriveSec, WEIGHTS, BANDS } = await core.complexity();

const ESTIMATE = {
  domains: 3, files: 12, integrations: 1, db: true, sec: false,
  ui: true, external_deps: 2, dep: false, testing: 0.5,
};

test('determinism: same input → same score (100 iterations)', () => {
  const scores = new Set();
  for (let i = 0; i < 100; i += 1) scores.add(computeComplexity(ESTIMATE).score);
  assert.equal(scores.size, 1, 'score must be deterministic');
});

test('weights sum to 1.0 (D3: to within binary-float precision)', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  // DISCREPANCY D3: the decimal weights sum to exactly 1.0, but summing their
  // binary approximations yields 0.9999999999999999. Assert both facts.
  assert.equal(Math.round(sum * 1000), 1000);
  assert.ok(Math.abs(sum - 1) < 1e-12, `weights must sum to 1.0 (got ${sum})`);
});

test('score is always in [0,1] (exhaustive over the documented ranges)', () => {
  const flags = [false, true];
  let n = 0;
  for (const db of flags) for (const sec of flags) for (const ui of flags) for (const dep of flags) {
    for (const testing of [0, 0.5, 1.0]) {
      for (const domains of [1, 3, 5, 10]) for (const files of [1, 10, 100, 1000]) {
        for (const integrations of [0, 3, 5, 10]) for (const external_deps of [0, 5, 10, 20]) {
          const { score } = computeComplexity({ domains, files, integrations, db, sec, ui, external_deps, dep, testing });
          assert.ok(score >= 0 && score <= 1, `score ${score} out of range`);
          n += 1;
        }
      }
    }
  }
  assert.equal(n, 2 ** 4 * 3 * 4 * 4 * 4 * 4);
});

test('score is monotone in every feature (K.3 property)', () => {
  const base = { domains: 2, files: 5, integrations: 1, db: false, sec: false, ui: false, external_deps: 1, dep: false, testing: 0 };
  const before = computeComplexity(base).score;
  for (const patch of [{ domains: 6 }, { files: 500 }, { integrations: 5 }, { db: true }, { sec: true }, { ui: true }, { external_deps: 9 }, { dep: true }, { testing: 1 }]) {
    const after = computeComplexity({ ...base, ...patch }).score;
    assert.ok(after >= before, `${JSON.stringify(patch)} must not lower the score`);
  }
});

test('band boundaries are half-open [lo,hi) except the last', () => {
  assert.equal(bandFor(0.0), 'Tiny');
  assert.equal(bandFor(0.249999), 'Tiny');
  assert.equal(bandFor(0.25), 'Small');
  assert.equal(bandFor(0.449999), 'Small');
  assert.equal(bandFor(0.45), 'Medium');
  assert.equal(bandFor(0.65), 'Large');
  assert.equal(bandFor(0.799999), 'Large');
  assert.equal(bandFor(0.8), 'Enterprise');
  assert.equal(bandFor(1.0), 'Enterprise');
  assert.equal(BANDS.length, 5);
});

test('normalization: logarithmic file scaling per B.1 (D1)', () => {
  const small = normalizeFeature('files', 1);
  const large = normalizeFeature('files', 1000);
  assert.equal(Number(small.toFixed(4)), 0.1307);
  assert.equal(large, 1.0, 'clamped at 1');
  assert.ok(large > small);
  // The B.1 formula, evaluated directly:
  assert.equal(small, Math.log(2) / Math.log(201));
});

test('normalization is clamped and total', () => {
  for (const [name, value] of [['domains', 999], ['files', 10_000], ['integrations', 999], ['external_deps', 999]]) {
    const v = normalizeFeature(name, value);
    assert.ok(v >= 0 && v <= 1, `${name} out of range: ${v}`);
  }
  assert.equal(normalizeFeature('testing', 7), 1);
  assert.equal(normalizeFeature('testing', 0.6), 0.5);
  assert.equal(normalizeFeature('testing', -1), 0);
  assert.equal(normalizeFeature('db', 'yes'), 1);
});

test('unknown feature name is rejected loudly', () => {
  assert.throws(() => normalizeFeature('nope', 1), /unknown feature/);
});

test('property: random estimates always stay in range and deterministic (seeded PRNG)', () => {
  const rng = mulberry32(20240517);
  for (let i = 0; i < 500; i += 1) {
    const input = {
      domains: intBetween(rng, 0, 40), files: intBetween(rng, 0, 5000),
      integrations: intBetween(rng, 0, 20), external_deps: intBetween(rng, 0, 50),
      db: rng() > 0.5, sec: rng() > 0.5, ui: rng() > 0.5, dep: rng() > 0.5,
      testing: [0, 0.5, 1][intBetween(rng, 0, 2)],
    };
    const a = computeComplexity(input).score;
    const b = computeComplexity(input).score;
    assert.equal(a, b);
    assert.ok(a >= 0 && a <= 1);
  }
});

test('deriveSec: security paths and requirement terms set the flag (B.1)', () => {
  assert.equal(deriveSec({ allowedPaths: ['src/auth/login.ts'] }), true);
  assert.equal(deriveSec({ allowedPaths: ['src/api/users.ts'] }), false);
  assert.equal(deriveSec({ requirement: 'add payment capture' }), true);
  assert.equal(deriveSec({ requirement: 'tidy the readme' }), false);
});

test('classifyTask: trivial / normal / architectural (B.8)', () => {
  assert.equal(classifyTask({ estimate: { files: 1 }, domains: ['frontend'], objective: 'change a colour' }), 'trivial');
  assert.equal(classifyTask({ estimate: { files: 8 }, domains: ['backend'], objective: 'add an endpoint' }), 'normal');
  assert.equal(classifyTask({ estimate: { files: 3 }, domains: ['database'], objective: 'add a table' }), 'architectural');
  assert.equal(classifyTask({ estimate: { files: 3 }, domains: ['backend'], objective: 'refactor the module boundaries' }), 'architectural');
});
