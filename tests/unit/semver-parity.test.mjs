/**
 * tests/unit/semver-parity.test.mjs — the two semver implementations agree (C19).
 *
 * `scripts/lib/semver-lite.mjs` (the version-check copy) and
 * `packages/sdlc-orchestrator/src/install-lib.mjs` (the authority: the update
 * channel + install ordering read it) implement the same frozen subset:
 * parse (optional leading `v`, build metadata ignored for precedence) and
 * full §11 precedence comparison. This test pins the parity on shared
 * vectors — including prerelease, build metadata and the 0.x edge — so a
 * fix in one copy cannot silently diverge from the other.
 *
 * Divergence policy (per the track): fix semver-lite, not install-lib,
 * unless install-lib is wrong — then fix both + document. The two fixes
 * applied here (build-metadata acceptance, `v`-prefix acceptance) touched
 * semver-lite only; install-lib was already right on both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as lite from '../../scripts/lib/semver-lite.mjs';
import * as auth from '../../packages/sdlc-orchestrator/src/install-lib.mjs';

/** versions where parse must agree (null = both reject). */
const PARSE_VECTORS = [
  '1.1.1',
  '0.0.0',
  '0.0.1',
  '10.20.30',
  '0.2.0-rc.2', // peer-range lower bound
  '0.3.0-0', // peer-range upper bound (prerelease of the excluded line)
  '0.3.0',
  'v1.2.3', // leading v (dsh --version prints one; doctor strips it, both accept it)
  '1.2.3+build', // build metadata ignored for precedence (§10)
  '1.2.3-alpha+build',
  '  2.0.0  ', // surrounding whitespace
  '0.0.0-0',
  '1.0.0-alpha.1',
  '1.0.0-alpha.beta',
  '1.0.0-x.7.z.92',
  '1.0.0-01',
  '1.0.0-0.3.7',
  '1.0',
  '',
];

/** [left, right, expectedSign] comparison vectors (§11 precedence). */
const COMPARE_VECTORS = [
  ['1.0.0', '2.0.0', -1],
  ['2.0.0', '1.0.0', 1],
  ['1.0.0', '1.0.0', 0],
  ['0.0.0', '0.0.1', -1], // 0.x edge: patch still orders
  ['0.1.0', '0.0.9', 1],
  ['1.0.0-alpha', '1.0.0', -1], // prerelease < release (§11.3)
  ['1.0.0', '1.0.0-alpha', 1],
  ['1.0.0-alpha', '1.0.0-alpha.1', -1], // fewer fields = lower
  ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1], // numeric < alphanumeric
  ['1.0.0-1', '1.0.0-alpha', -1],
  ['1.0.0-beta.2', '1.0.0-beta.11', -1], // numeric compare, not lexicographic
  ['1.0.0-x.7.z.92', '1.0.0-x.7.z.93', -1],
  ['1.0.0-alpha+001', '1.0.0-alpha', 0], // build metadata ignored (§10)
  ['1.0.0+build', '1.0.0', 0],
  ['1.0.0-a+b.c', '1.0.0-a', 0],
  ['0.3.0-0', '0.3.0', -1],
  ['0.2.0-rc.2', '0.2.0', -1],
  ['0.2.0-rc.2', '0.3.0-0', -1],
];

const normLite = (p) => (p === null ? null : [p.major, p.minor, p.patch, (p.pre ?? []).map(String)]);
const normAuth = (p) => (p === null ? null : [p.major, p.minor, p.patch, p.prerelease.map(String)]);

test('parse agrees on shared vectors (prerelease + build metadata + 0.x edge)', () => {
  for (const v of PARSE_VECTORS) {
    assert.deepEqual(
      normLite(lite.parse(v)),
      normAuth(auth.parseVersion(v)),
      `parse diverged for ${JSON.stringify(v)}`,
    );
  }
});

test('compare agrees on shared vectors (full §11 precedence)', () => {
  for (const [left, right, expected] of COMPARE_VECTORS) {
    const liteSign = Math.sign(lite.compare(left, right));
    const authSign = auth.compareVersions(left, right);
    assert.equal(liteSign, authSign, `implementations disagree on ${left} vs ${right}`);
    assert.equal(liteSign, expected, `wrong precedence for ${left} vs ${right}`);
  }
});

test('both reject the same non-versions', () => {
  for (const v of ['nope', '1.0', '1.0.0-', 'a.b.c']) {
    assert.equal(lite.parse(v), null, `semver-lite accepts ${JSON.stringify(v)}`);
    assert.equal(auth.parseVersion(v), null, `install-lib accepts ${JSON.stringify(v)}`);
    assert.throws(() => lite.compare(v, '1.0.0'));
    assert.throws(() => auth.compareVersions(v, '1.0.0'));
  }
});

test('peer-range gating agrees on the boundary versions', () => {
  const range = '>=0.2.0-rc.2 <0.3.0-0';
  const probe = (v) => {
    const okLite = lite.parse(v) !== null && lite.satisfies(v, range);
    const okAuth =
      auth.parseVersion(v) !== null &&
      auth.compareVersions(v, '0.2.0-rc.2') >= 0 &&
      auth.compareVersions(v, '0.3.0-0') < 0;
    return [okLite, okAuth];
  };
  for (const v of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2', '0.3.0-0', '0.3.0', '1.1.1']) {
    assert.deepEqual(probe(v)[0], probe(v)[1], `peer-range gate diverged for ${v}`);
  }
  assert.equal(lite.satisfies('0.2.0-rc.2', range), true);
  assert.equal(lite.satisfies('0.3.0-0', range), false);
});
