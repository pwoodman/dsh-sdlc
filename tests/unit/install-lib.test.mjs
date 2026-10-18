/**
 * tests/unit/install-lib.test.mjs — pnpm `minimumReleaseAgeExclude` repair.
 *
 * The Desktop profile carried
 *   - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.19 || 0.4.0-beta.20'
 * pnpm treats that as one invalid pattern and ignores it, so a fresh beta
 * resolved to the previous one. The installer must split it, keep the package
 * name on a bare version, and stay idempotent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReleaseAgeExcludes } from '../../packages/sdlc-orchestrator/src/install-lib.mjs';

const SPEC = '@patwoodman/dsh-sdlc-flow@0.4.0-beta.21';

test('splits a malformed pkg@old || pkg@new entry into valid list items', () => {
  const input = `packages:\n  - .\nminimumReleaseAgeExclude:\n  - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.19 || @patwoodman/dsh-sdlc-flow@0.4.0-beta.20'\n`;
  const out = normalizeReleaseAgeExcludes(input, [SPEC]);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.19'$/m);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.20'$/m);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.21'$/m);
  assert.doesNotMatch(out, /\|\|/, 'no invalid OR pattern survives');
});

test('carries the package name onto a bare version after ||', () => {
  const input = `minimumReleaseAgeExclude:\n  - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.19 || 0.4.0-beta.20'\n`;
  const out = normalizeReleaseAgeExcludes(input, []);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.19'$/m);
  assert.match(out, /^  - '@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.20'$/m);
});

test('preserves every unrelated setting in pnpm-workspace.yaml', () => {
  const input = `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\nminimumReleaseAgeExclude:\n  - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.20'\n`;
  const out = normalizeReleaseAgeExcludes(input, [SPEC]);
  assert.match(out, /^packages:$/m);
  assert.match(out, /^  - \.$/m);
  assert.match(out, /^nodeLinker: hoisted$/m);
  assert.match(out, /^autoInstallPeers: false$/m);
  assert.match(out, /^minimumReleaseAgeExclude:$/m);
});

test('adds the block when the profile has none', () => {
  const out = normalizeReleaseAgeExcludes('packages:\n  - .\n', [SPEC]);
  assert.equal(out, `packages:\n  - .\n\nminimumReleaseAgeExclude:\n  - '${SPEC}'\n`);
});

test('is idempotent, deduplicating and sorting entries', () => {
  const input = `minimumReleaseAgeExclude:\n  - 'z@2.0.0'\n  - 'a@1.0.0'\n`;
  const once = normalizeReleaseAgeExcludes(input, [SPEC, 'a@1.0.0']);
  const twice = normalizeReleaseAgeExcludes(once, [SPEC]);
  assert.equal(twice, once);
  const entries = [...once.matchAll(/^  - '(.+)'$/gm)].map((m) => m[1]);
  assert.deepEqual(entries, [...entries].sort());
  assert.equal(entries.filter((e) => e === 'a@1.0.0').length, 1);
  assert.ok(entries.includes(SPEC));
});

test('an existing non-empty block is rewritten in place, not appended twice', () => {
  const input = `minimumReleaseAgeExclude:\n  - 'old@1.0.0'\n\nnodeLinker: hoisted\n`;
  const out = normalizeReleaseAgeExcludes(input, [SPEC]);
  assert.equal((out.match(/minimumReleaseAgeExclude:/g) ?? []).length, 1);
  assert.match(out, /^nodeLinker: hoisted$/m);
  assert.match(out, /^  - 'old@1\.0\.0'$/m, 'unrelated exemptions are preserved');
  assert.match(out, new RegExp(`^  - '${SPEC.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'$`, 'm'));
});
