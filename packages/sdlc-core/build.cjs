/**
 * packages/sdlc-core/build.cjs — standalone build for publishing.
 *
 * Copies src/ → lib/ with zero dependencies (the D0 offline build). Runs
 * from the package directory on `prepack` so the published tarball always
 * contains fresh lib/ artifacts, and standalone via `pnpm build`.
 */

const { cpSync, existsSync, mkdirSync, readdirSync, rmSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const DIR = __dirname;
const SRC = join(DIR, 'src');
const LIB = join(DIR, 'lib');

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stat = require('node:fs').statSync(full);
    if (stat.isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
if (!existsSync(SRC)) {
  console.log(`  ${pkg.name} no src/ — skipped`);
  process.exit(0);
}
rmSync(LIB, { recursive: true, force: true });
mkdirSync(LIB, { recursive: true });
for (const rel of walk(SRC)) cpSync(join(SRC, rel), join(LIB, rel));
const main = pkg.main ?? 'lib/index.js';
if (!existsSync(join(DIR, main))) {
  console.error(`  ${pkg.name} FAIL — main "${main}" missing after build`);
  process.exit(1);
}
console.log(`  ${pkg.name} built → lib/`);
