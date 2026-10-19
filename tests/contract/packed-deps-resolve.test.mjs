/**
 * tests/contract/packed-deps-resolve.test.mjs — every bare suite import in a
 * shipped `lib/` must be a declared dependency.
 *
 * The build rewrites relative cross-package imports to bare package subpaths.
 * The CLI imported eight `@patwoodman/dsh-sdlc-flow-core/*` subpaths but its
 * manifest had no `dependencies`, so `npm i @patwoodman/dsh-sdlc-flow-cli`
 * installed a package that died with ERR_MODULE_NOT_FOUND.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ROOT } from '../lib/helpers.mjs';

function manifests() {
  const out = [];
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const path = join(ROOT, 'packages', dir, 'package.json');
    if (existsSync(path)) out.push({ dir, path, pkg: JSON.parse(readFileSync(path, 'utf8')) });
  }
  return out;
}

function walk(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(relative(base, path).split('\\').join('/'));
  }
  return out;
}

/** Bare `@patwoodman/...` specifiers in one file, deduplicated. */
function suiteImports(text) {
  const found = new Set();
  const patterns = [
    /(?:from|import)\s*['"](@patwoodman\/[^'"]+)['"]/g,
    /require\(\s*['"](@patwoodman\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) found.add(match[1]);
  }
  return [...found];
}

function packageOf(specifier) {
  const parts = specifier.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
}

test('every bare @patwoodman import in a shipped lib/ is a declared dependency', () => {
  const all = manifests();
  const byName = new Map(all.map((entry) => [entry.pkg.name, entry]));
  const failures = [];

  for (const { dir, pkg } of all) {
    if (pkg.private) continue;
    const libDir = join(ROOT, 'packages', dir, 'lib');
    for (const rel of walk(libDir)) {
      // Folded copies inside the meta bundle are addressed through the meta
      // package's flat exports; they are not separately installed.
      if (rel.startsWith('rows/')) continue;
      const text = readFileSync(join(libDir, rel), 'utf8');
      for (const specifier of suiteImports(text)) {
        const dependency = packageOf(specifier);
        if (dependency === pkg.name) continue;
        if (!byName.has(dependency)) {
          failures.push(`${pkg.name}/${rel}: imports unknown suite package ${dependency}`);
          continue;
        }
        const declared = pkg.dependencies?.[dependency] ?? pkg.peerDependencies?.[dependency];
        if (!declared) {
          failures.push(`${pkg.name}/${rel}: imports ${specifier} but ${dependency} is not a declared dependency`);
        }
      }
    }
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('intra-suite dependency pins match the release version', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const all = manifests();
  const byName = new Map(all.map((entry) => [entry.pkg.name, entry]));
  for (const { pkg } of all) {
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!byName.has(name)) continue;
      assert.equal(range, root.version, `${pkg.name} must pin ${name}@${root.version}, found ${range}`);
    }
  }
});
