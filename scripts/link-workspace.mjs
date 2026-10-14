#!/usr/bin/env node
/**
 * scripts/link-workspace.mjs — make `lib/`'s bare cross-package imports
 * resolvable on a fresh checkout.
 *
 * WHY THIS EXISTS. The build is zero-dependency (deviation D0): `lib/` mirrors
 * `src/` with cross-package relative imports rewritten to bare npm specifiers
 * (`@patwoodman/dsh-sdlc-flow-core`), which a PUBLISHED package resolves through
 * `node_modules`. Inside this workspace there is no lockfile and no install, so
 * a fresh clone (CI!) has no `node_modules` at all — and every test that imports
 * such a `lib/` file (the CLI suites, for one) fails with ERR_MODULE_NOT_FOUND
 * even though the same tree passes on a machine that once ran `pnpm install`.
 * That is exactly why CI's unit job failed on beta.6, beta.7 and beta.8 while
 * the same commits passed locally.
 *
 * The fix is the smallest possible workspace emulation: one symlink per
 * publishable package under `node_modules/@<scope>/`, pointing at `packages/*`.
 * No lockfile, no store, no network; idempotent; safe to run before any test.
 *
 *   node scripts/link-workspace.mjs          # create/refresh the links
 *   node scripts/link-workspace.mjs --check  # exit 1 if any link is missing
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PKG_ROOT = join(ROOT, 'packages');
const NODE_MODULES = join(ROOT, 'node_modules');
const CHECK = process.argv.includes('--check');

/** Packages that must resolve from lib/: every non-private workspace package. */
const packages = [];
for (const dir of readdirSync(PKG_ROOT).sort()) {
  const manifest = join(PKG_ROOT, dir, 'package.json');
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!pkg.name || pkg.private) continue;
  const slash = pkg.name.indexOf('/');
  packages.push({ name: pkg.name, scope: pkg.name.slice(0, slash), local: pkg.name.slice(slash + 1), dir: join(PKG_ROOT, dir) });
}

if (packages.length === 0) {
  console.error('link-workspace: no publishable package under packages/ — nothing to link');
  process.exit(1);
}

let missing = 0;
for (const { name, scope, local, dir } of packages) {
  const link = join(NODE_MODULES, scope, local);
  const ok = existsSync(link) && statSync(link).isSymbolicLink() && existsSync(join(link, 'package.json'));
  if (CHECK) {
    if (!ok) {
      missing += 1;
      console.error(`link-workspace: ${name} is not linked (${link} missing or stale)`);
    }
    continue;
  }
  if (ok) continue;
  rmSync(link, { force: true }); // a stale file/non-link entry must not block the symlink
  mkdirSync(join(NODE_MODULES, scope), { recursive: true });
  symlinkSync(dir, link, 'dir');
  console.log(`link-workspace: ${name} → ${link}`);
}

if (CHECK) {
  if (missing) process.exit(1);
  console.log(`link-workspace: all ${packages.length} packages linked`);
} else {
  console.log(`link-workspace: ${packages.length} packages resolvable from node_modules/`);
}
