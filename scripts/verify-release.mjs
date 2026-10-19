#!/usr/bin/env node
/**
 * scripts/verify-release.mjs — refuse a release that cannot actually publish.
 *
 * Checks, before the tag/build/publish path:
 *   - the version is ahead of every git tag and no tag already names it;
 *   - every package manifest is at that version;
 *   - the version is not already on npm (unless --allow-published, a resume);
 *   - CHANGELOG.md has a section for it and README does not call it unpublished;
 *   - the working tree is clean (unless --allow-dirty).
 *
 *   node scripts/verify-release.mjs [--json] [--offline] [--allow-dirty] [--allow-published]
 *
 * Exit 0 only when every check passes. The Release workflow runs this before
 * anything is published.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { evaluateRelease } from './lib/release-guard.mjs';

const ROOT = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const JSON_OUT = has('--json');
const OFFLINE = has('--offline');

function tags() {
  try {
    return execFileSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((tag) => tag.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function dirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
}

function manifests() {
  const versions = [];
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  versions.push(root.version);
  let meta = null;
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const path = join(ROOT, 'packages', dir, 'package.json');
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    versions.push(pkg.version);
    // The root package is private; the published meta-bundle is the registry
    // entry point (`@patwoodman/dsh-sdlc-flow`).
    if (dir === 'sdlc-orchestrator') meta = pkg;
  }
  if (meta === null) throw new Error('packages/sdlc-orchestrator/package.json not found');
  return { root, versions, meta };
}

async function registryVersions(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
  const packument = await response.json();
  return Object.keys(packument.versions ?? {});
}

const { root, versions, meta } = manifests();
let published = false;
let registryError = null;
if (!OFFLINE) {
  try {
    published = await registryVersions(meta.name);
  } catch (error) {
    registryError = error instanceof Error ? error.message : String(error);
  }
}

const report = evaluateRelease({
  version: root.version,
  tags: tags(),
  manifests: versions,
  published,
  changelog: readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'),
  readme: readFileSync(join(ROOT, 'README.md'), 'utf8'),
  dirty: has('--allow-dirty') ? false : dirty(),
  allowPublished: has('--allow-published'),
});

if (registryError) report.warnings.push(`could not read the npm registry (${registryError}); run without --offline to check`);

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ package: meta.name, version: root.version, ...report }, null, 2)}\n`);
} else {
  process.stdout.write(`\nrelease guard — ${meta.name}@${root.version}\n`);
  for (const warning of report.warnings) process.stdout.write(`  [warn] ${warning}\n`);
  for (const problem of report.problems) process.stdout.write(`  [FAIL] ${problem}\n`);
  process.stdout.write(report.ok ? '  [ok]   release version is unpublished and documented\n\n' : '\n  refusing to release\n\n');
}

process.exit(report.ok ? 0 : 1);
