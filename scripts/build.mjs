#!/usr/bin/env node
/**
 * scripts/build.mjs — zero-dependency build for the SDLC orchestrator packages.
 *
 * WHY THIS EXISTS (documented deviation from spec v3 C.8.2):
 *   The spec assumes a TypeScript monorepo built with `pnpm -r build`. The
 *   reference environment for this implementation has no pnpm and no network,
 *   so a TypeScript toolchain cannot be installed. The packages are therefore
 *   written as plain ESM JavaScript with JSDoc types and this script performs
 *   the `src/ → lib/` artifact step that the DSH loader and the validation
 *   harnesses consume (`packages/<pkg>/lib/index.js`, `.../lib/schema.js`, …).
 *
 *   The observable contract is unchanged: `package.json#main` points at
 *   `lib/`, DSH loads `lib/` at profile composition time, and
 *   `scripts/validate-m0.mjs` imports the same `lib/` paths it always did.
 *   When a TypeScript toolchain is available, replacing this script with
 *   `tsc`/`tsup` is a one-file change.
 *
 *   node scripts/build.mjs [--check]
 *     --check   verify lib/ is up to date without writing (exit 1 if stale)
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PKG_ROOT = join(ROOT, 'packages');
const CHECK = process.argv.includes('--check');

/** Every package directory that declares a `dsh` bundle or a `src/` tree. */
function packageDirs() {
  if (!existsSync(PKG_ROOT)) return [];
  return readdirSync(PKG_ROOT)
    .map((name) => join(PKG_ROOT, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'package.json')));
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}


/**
 * Rewrite cross-package relative imports to bare npm specifiers.
 *
 * `src/` uses relative imports (`../../sdlc-guard/src/index.js`) so the monorepo
 * tests see one module instance. `lib/` must use bare specifiers
 * (`@patwoodman/dsh-sdlc-flow-guard`) so a published package resolves through
 * `node_modules`. This transform bridges the two.
 */
const DIR_TO_PKG = {};
const PKG_MAIN_STEMS = {};
for (const d of readdirSync(join(ROOT, 'packages'))) {
  const pj = join(ROOT, 'packages', d, 'package.json');
  if (!existsSync(pj)) continue;
  const m = JSON.parse(readFileSync(pj, 'utf8'));
  if (!m.name) continue;
  DIR_TO_PKG[d] = m.name;
  PKG_MAIN_STEMS[m.name] = (m.main ?? 'lib/index.js').split('/').pop().replace(/\.\w+$/, '');
}

function rewriteImports(text) {
  return text.replace(
    /from '((?:\.\.\/)+)sdlc-([a-z-]+)\/src\/([^']+?)\.(js|mjs)'/g,
    (_match, _dots, dir, file, _ext) => {
      const pkg = DIR_TO_PKG[`sdlc-${dir}`];
      if (!pkg) return _match;
      const stem = file.split('/').pop();
      if (stem === 'index' || stem === PKG_MAIN_STEMS[pkg]) return `from '${pkg}'`;
      return `from '${pkg}/${file}'`;
    },
  );
}

let failed = 0;
let built = 0;

// The UI bundle owns its own build (scripts/build-ui.mjs compiles JSX into
// the closure-factory client bundle); the generic src/ → lib/ mirror would
// clobber lib/client.js. Skip it here — build-ui.mjs mirrors + compiles.
const OWNED_BUILDS = new Set(['@patwoodman/dsh-sdlc-flow-ui']);

for (const dir of packageDirs()) {
  const src = join(dir, 'src');
  const lib = join(dir, 'lib');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const name = pkg.name;

  if (OWNED_BUILDS.has(name)) {
    process.stdout.write(`  ${name.padEnd(34)} owned build (scripts/build-ui.mjs) — skipped\n`);
    continue;
  }

  // Source-shipped bundles (files: src+bin, main: src/…): nothing to mirror;
  // the build only verifies the declared main resolves.
  const mainEntry = pkg.main ?? 'lib/index.js';
  if (!mainEntry.startsWith('lib/')) {
    if (!existsSync(join(dir, mainEntry))) {
      failed += 1;
      process.stdout.write(`  ${name.padEnd(34)} FAIL — main "${mainEntry}" missing\n`);
    } else if (CHECK) {
      process.stdout.write(`  ${name.padEnd(34)} source-shipped (${mainEntry})\n`);
    } else {
      built += 1;
      process.stdout.write(`  ${name.padEnd(34)} source-shipped, main ok (${mainEntry})\n`);
    }
    continue;
  }

  if (!existsSync(src)) {
    process.stdout.write(`  ${name.padEnd(34)} no src/ — skipped\n`);
    continue;
  }

  const files = walk(src);
  const stale = [];
  for (const rel of files) {
    const from = join(src, rel);
    const to = join(lib, rel);
    const srcText = rewriteImports(readFileSync(from, 'utf8'));
    if (!existsSync(to) || srcText !== readFileSync(to, 'utf8')) stale.push(rel);
  }

  if (CHECK) {
    if (stale.length) {
      failed += 1;
      process.stdout.write(`  ${name.padEnd(34)} STALE (${stale.length}): ${stale.slice(0, 5).join(', ')}\n`);
    } else {
      process.stdout.write(`  ${name.padEnd(34)} up to date (${files.length} files)\n`);
    }
    continue;
  }

  rmSync(lib, { recursive: true, force: true });
  mkdirSync(lib, { recursive: true });
  for (const rel of files) {
    const srcText = rewriteImports(readFileSync(join(src, rel), 'utf8'));
    const dest = join(lib, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, srcText);
  }

  // Keep the package entrypoint honest: lib/ main must resolve.
  const main = pkg.main ?? 'lib/index.js';
  if (!existsSync(join(dir, main))) {
    failed += 1;
    process.stdout.write(`  ${name.padEnd(34)} FAIL — main "${main}" missing after build\n`);
    continue;
  }
  built += 1;
  process.stdout.write(`  ${name.padEnd(34)} built ${files.length} files → lib/\n`);
}

if (!CHECK) {
  // Validate that every bundle patch file a package declares actually exists.
  for (const dir of packageDirs()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const patch = pkg.dsh?.bundle?.patch;
    for (const p of Array.isArray(patch) ? patch : patch ? [patch] : []) {
      if (!existsSync(join(dir, p))) {
        failed += 1;
        process.stdout.write(`  ${pkg.name.padEnd(34)} FAIL — declared patch ${p} missing\n`);
      }
    }
  }
  // `.validation/` is gitignored, so it does not exist on a fresh clone; the
  // build must create it before stamping. A bare writeFileSync died with ENOENT
  // here, which made `npm run build` — step one of the Quick Start and of
  // install-local.mjs — fail on every clean checkout.
  mkdirSync(join(ROOT, '.validation'), { recursive: true });
  writeFileSync(join(ROOT, '.validation', '.build-stamp'), new Date().toISOString() + '\n', { flag: 'w' });
}

process.stdout.write(`\n  ${CHECK ? 'checked' : `built ${built} packages`}${failed ? `, ${failed} FAILED` : ''}\n`);
process.exit(failed ? 1 : 0);
