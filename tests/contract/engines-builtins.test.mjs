/**
 * tests/contract/engines-builtins.test.mjs — the Node floor must admit the
 * built-ins the code imports.
 *
 * `sdlc-core` imports `node:sqlite`, which stayed behind `--experimental-sqlite`
 * until Node v22.13.0 (Node docs, SQLite History). The manifests said >=22.5.0,
 * so 22.5–22.12 installed successfully and crashed at first boot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ROOT } from '../lib/helpers.mjs';
import { parse, compare } from '../../scripts/lib/semver-lite.mjs';

function manifests() {
  const out = [{ at: ROOT, pkg: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) }];
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const path = join(ROOT, 'packages', dir, 'package.json');
    if (existsSync(path)) out.push({ at: join(ROOT, 'packages', dir), pkg: JSON.parse(readFileSync(path, 'utf8')) });
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

function floorOf(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(range ?? ''));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

test('a package importing node:sqlite declares a Node floor of at least 22.13.0', () => {
  const failures = [];
  for (const { at, pkg } of manifests()) {
    if (pkg.private) continue;
    const libDir = join(at, 'lib');
    const usesSqlite = walk(libDir).some((rel) => /node:sqlite/.test(readFileSync(join(libDir, rel), 'utf8')));
    if (!usesSqlite) continue;
    const floor = floorOf(pkg.engines?.node);
    if (floor === null || compare(floor, '22.13.0') < 0) {
      failures.push(`${pkg.name}: imports node:sqlite but engines.node is ${pkg.engines?.node ?? '(missing)'}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the root engine floor is at least 22.13.0', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const floor = floorOf(root.engines?.node);
  assert.ok(floor !== null, 'root declares engines.node');
  assert.ok(compare(floor, '22.13.0') >= 0, `root engines.node is ${root.engines.node}`);
});
