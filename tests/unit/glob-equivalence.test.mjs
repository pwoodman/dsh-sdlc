/**
 * tests/unit/glob-equivalence.test.mjs — cross-package dialect equivalence.
 *
 * `sdlc-core/src/glob-lite.js` and `sdlc-guard/src/glob.js` are deliberate,
 * documented copies of the same frozen dialect (errata E6 keeps the packages
 * independently installable). This test is the guard against silent drift: it
 * property-tests both implementations against each other over generated inputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, mulberry32, pick } from '../lib/helpers.mjs';

const coreGlob = await load('packages/sdlc-core/src/glob-lite.js');
const guardGlob = await load('packages/sdlc-guard/src/glob.js');

const DIALECT_VERSION = '1.0.0';

const SEGMENTS = ['src', 'api', 'auth', 'deep', 'nested', 'tests', 'docs', 'a.ts', 'b.js', 'index.html', 'x'];
const PATTERNS = [
  'src/**', 'src/*', 'src/**/*.ts', '**/*.ts', '**', 'src/auth/**', 'tests/**', '*.ts',
  'src/**/nested/**', 'a.ts', './src/**', 'src/?pi/**', 'src/[x]/**',
];

test('both copies declare the same dialect version', () => {
  assert.equal(coreGlob.GLOB_DIALECT_VERSION, DIALECT_VERSION);
  assert.equal(guardGlob.GLOB_DIALECT_VERSION, DIALECT_VERSION);
});

test('normalizePath agrees exactly on generated paths (including hostile ones)', () => {
  const rng = mulberry32(31337);
  const hostile = ['../escape', '/abs', '~/home', 'a\0b', 'C:/x', 'src/../..', '.', '..', '', '．/．'];
  for (let i = 0; i < 2000; i += 1) {
    const depth = 1 + Math.floor(rng() * 4);
    const parts = [];
    for (let d = 0; d < depth; d += 1) parts.push(pick(rng, SEGMENTS));
    const candidate = rng() > 0.85 ? pick(rng, hostile) : parts.join('/');
    const a = coreGlob.normalizePath(candidate);
    const b = guardGlob.normalizePath(candidate);
    assert.deepEqual(a, b, `normalizePath diverged for ${JSON.stringify(candidate)}`);
  }
});

test('matchGlob agrees exactly on generated patterns × paths', () => {
  const rng = mulberry32(90210);
  for (let i = 0; i < 4000; i += 1) {
    const pattern = pick(rng, PATTERNS);
    const depth = 1 + Math.floor(rng() * 4);
    const parts = [];
    for (let d = 0; d < depth; d += 1) parts.push(pick(rng, SEGMENTS));
    const path = parts.join('/');
    const a = coreGlob.matchGlob(pattern, path);
    const b = guardGlob.matchGlob(pattern, path);
    assert.equal(a, b, `matchGlob diverged for ${pattern} vs ${path}`);
  }
});

test('documented dialect behaviour (the contract both copies implement)', () => {
  for (const mod of [coreGlob, guardGlob]) {
    assert.equal(mod.matchGlob('src/**', 'src/deep/nested/a.ts'), true);
    assert.equal(mod.matchGlob('src/*', 'src/deep/nested/a.ts'), false);
    assert.equal(mod.matchGlob('**/*.ts', 'a.ts'), true);
    assert.equal(mod.matchGlob('./src/**', 'src/a.ts'), true);
    assert.equal(mod.matchGlob('src/**', '../src/a.ts'), false, 'traversal never matches');
    assert.equal(mod.normalizePath('/etc/passwd').ok, false);
    assert.equal(mod.normalizePath('a/../b').ok, false);
  }
});

test('the published JSON Schema and both implementations agree on version', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('../lib/helpers.mjs');
  const schema = JSON.parse(readFileSync(join(ROOT, 'packages/sdlc-guard/schema/path-policy.schema.json'), 'utf8'));
  assert.equal(schema['x-dialect-version'], DIALECT_VERSION);
});
