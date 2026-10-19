/**
 * tests/contract/packed-exports.test.mjs — every manifest target must exist and
 * be covered by the published `files` allowlist.
 *
 * The UI package advertised `lib/types/**` and `./src/*`, neither of which was
 * built or shipped. TypeScript resolution and Node subpath imports fail for
 * consumers even though every runtime test passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../lib/helpers.mjs';

function manifests() {
  const out = [];
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const path = join(ROOT, 'packages', dir, 'package.json');
    if (existsSync(path)) out.push({ dir, at: join(ROOT, 'packages', dir), pkg: JSON.parse(readFileSync(path, 'utf8')) });
  }
  return out;
}

function collectTargets(value, out = []) {
  if (typeof value === 'string') {
    if (!value.includes('*')) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectTargets(item, out);
  }
  return out;
}

function targetsOf(pkg) {
  const targets = new Set();
  for (const rel of collectTargets([pkg.main, pkg.types, pkg.bin, pkg.exports, pkg.icon])) {
    if (rel) targets.add(rel);
  }
  if (pkg.dsh?.bundle?.patch) {
    for (const rel of collectTargets(pkg.dsh.bundle.patch)) targets.add(rel);
  }
  return [...targets].map((rel) => rel.replace(/^\.\//, ''));
}

function globToRegExp(entry) {
  const escaped = entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function coveredByFiles(rel, files = []) {
  return files.some((entry) => {
    if (entry === rel) return true;
    if (entry.includes('*')) return globToRegExp(entry).test(rel);
    return rel.startsWith(`${entry}/`);
  });
}

test('every main/types/bin/exports/patch/icon target exists in the package', () => {
  const failures = [];
  for (const { dir, at, pkg } of manifests()) {
    if (pkg.private) continue;
    for (const rel of targetsOf(pkg)) {
      if (!existsSync(join(at, rel))) failures.push(`${pkg.name}: target ${rel} does not exist`);
    }
    for (const rel of targetsOf(pkg)) {
      // npm always includes package.json, README and LICENSE in the pack.
      if (['package.json', 'README.md', 'LICENSE'].includes(rel)) continue;
      if (!coveredByFiles(rel, pkg.files ?? [])) failures.push(`${pkg.name}: target ${rel} is not covered by files[]`);
    }
    // A `files` entry that names a non-existent path is also a packaging bug.
    for (const entry of pkg.files ?? []) {
      if (entry.includes('*')) continue;
      if (!existsSync(join(at, entry))) failures.push(`${pkg.name}: files[] entry ${entry} does not exist`);
    }
    // Sanity: the package directory itself must contain its manifest.
    assert.ok(statSync(join(at, 'package.json')).isFile(), `${dir}/package.json`);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});
