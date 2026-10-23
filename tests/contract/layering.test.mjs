/**
 * tests/contract/layering.test.mjs — the package layering gate (C16/C17).
 *
 * The single ALLOWED_EDGES table in scripts/lib/cross-package-imports.cjs is
 * the only place a cross-package `src/` import direction may be permitted.
 * This test fails the build on any new edge — layering drift (e.g. a worker
 * profile mounting host services) must be a deliberate, reviewed table edit,
 * never an accidental import.
 *
 * Partition behind the table (spec v3 E6): `sdlc-core` holds host services
 * (scheduler, DB writer) and must never be installed into a worker profile —
 * the worker gets guard + tools only. Documented edges:
 *   cli → core, client-ui → {core, cli}, core → guard, tools → core
 *   (worker-result.js ONLY — the B.3.2 derive/serialize half, no runtime).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { ROOT } from '../lib/helpers.mjs';

const require = createRequire(import.meta.url);
const shared = require(`${ROOT}/scripts/lib/cross-package-imports.cjs`);

test('layering: every cross-package src/ import is in ALLOWED_EDGES', () => {
  const { ok, violations } = shared.checkLayering({ root: ROOT });
  assert.equal(violations.length, 0, `layering violations:\n  ${violations.join('\n  ')}`);
  assert.equal(ok, true);
});

test('layering: the table pins the known edges (drift fails loud)', () => {
  const edges = Object.fromEntries(
    Object.entries(shared.ALLOWED_EDGES).map(([from, rule]) => [from, [...rule.targets].sort()]),
  );
  assert.deepEqual(edges, {
    'sdlc-cli': ['sdlc-core'],
    'sdlc-client-ui': ['sdlc-cli', 'sdlc-core', 'sdlc-guard'],
    'sdlc-core': ['sdlc-guard'],
    'sdlc-presets': ['sdlc-guard'],
    'sdlc-tools': ['sdlc-core', 'sdlc-guard'],
  });
  assert.deepEqual(shared.ALLOWED_EDGES['sdlc-tools'].files, { 'sdlc-core': ['worker-result.js'] });
});

test('layering: the tools→core edge carries only worker-result.js', () => {
  const imports = shared.listCrossPackageImports({ root: ROOT });
  const toolsToCore = imports.filter((e) => e.fromDir === 'sdlc-tools' && e.toDir === 'sdlc-core');
  assert.ok(toolsToCore.length > 0, 'expected at least the buildOutbox/OUTBOX_PATH import');
  for (const edge of toolsToCore) {
    assert.match(edge.toFile, /(^|\/)worker-result\.js$/, `${edge.fromFile} reaches past worker-result.js: ${edge.toFile}`);
  }
});

test('layering: the guard-ward pkgVersion edges carry only package-version.js', () => {
  const imports = shared.listCrossPackageImports({ root: ROOT });
  const toGuard = imports.filter(
    (e) => e.toDir === 'sdlc-guard' && e.toFile.endsWith('package-version.js'),
  );
  assert.ok(toGuard.length > 0, 'expected the shared pkgVersion reader imports');
  for (const edge of toGuard) {
    assert.match(edge.toFile, /(^|\/)package-version\.js$/, `${edge.fromFile} reaches past the helper: ${edge.toFile}`);
  }
  const guardImports = imports.filter((e) => e.toDir === 'sdlc-guard');
  for (const edge of guardImports) {
    if (edge.fromDir === 'sdlc-core') continue; // the GuardPlugin edge (C17)
    assert.match(edge.toFile, /(^|\/)package-version\.js$/, `${edge.fromFile} widens the guard edge: ${edge.toFile}`);
  }
});
