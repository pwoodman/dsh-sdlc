#!/usr/bin/env node
/**
 * scripts/bump-version.mjs — move every package to one version.
 *
 * A release needs the root and all `packages/*` manifests on the SAME version:
 * the meta-bundle pins its members exactly, and
 * `tests/contract/publish-shape.test.mjs` fails if any of them drifts. `npm
 * version` cannot do this here — the workspace is a pnpm workspace, so npm does
 * not know the members exist.
 *
 *   node scripts/bump-version.mjs 0.4.0-beta.3
 *   node scripts/bump-version.mjs --check          # report drift only
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const version = argv.find((a) => !a.startsWith('-'));

const ROOT_MANIFEST = join(ROOT, 'package.json');
const root = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8'));

if (CHECK) {
  const drift = [];
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const path = join(ROOT, 'packages', dir, 'package.json');
    if (!statSync(path).isFile()) continue;
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    if (pkg.version !== root.version) drift.push(`${pkg.name}: ${pkg.version} != ${root.version}`);
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (range !== root.version) drift.push(`${pkg.name} depends on ${name}@${range} != ${root.version}`);
    }
  }
  if (drift.length) {
    process.stderr.write(`bump-version: ${drift.length} drift(s) from ${root.version}:\n  ${drift.join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`bump-version: every manifest is at ${root.version}\n`);
  process.exit(0);
}

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write('usage: node scripts/bump-version.mjs <semver> [--check]\n');
  process.exit(2);
}

const write = (path, doc) => writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
root.version = version;
write(ROOT_MANIFEST, root);
process.stdout.write(`  ${root.name} → ${version}\n`);

for (const dir of readdirSync(join(ROOT, 'packages'))) {
  const path = join(ROOT, 'packages', dir, 'package.json');
  if (!statSync(path).isFile()) continue;
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const before = pkg.version;
  pkg.version = version;
  // The meta-bundle pins its members exactly (saveExact); keep the pins aligned.
  for (const name of Object.keys(pkg.dependencies ?? {})) pkg.dependencies[name] = version;
  write(path, pkg);
  process.stdout.write(`  ${pkg.name} → ${version}${before === version ? ' (unchanged)' : ''}\n`);
}

process.stdout.write(
  `\nbump-version: now run the release:\n` +
  `  node scripts/build-release.mjs\n` +
  `  git tag v${version} && git push origin v${version}\n`,
);
