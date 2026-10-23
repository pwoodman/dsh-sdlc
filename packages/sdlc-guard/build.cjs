/**
 * packages/sdlc-core/build.cjs — standalone build for publishing.
 *
 * Copies src/ → lib/ with zero dependencies (the D0 offline build). Runs
 * from the package directory on `prepack` so the published tarball always
 * contains fresh lib/ artifacts, and standalone via `pnpm build`.
 */

const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
// walk + the cross-package src/ -> lib/ import transform are the ONE shared
// implementation in scripts/lib/cross-package-imports.cjs (C16).
const { buildMap, rewriteImports, walk } = require('../../scripts/lib/cross-package-imports.cjs');

const DIR = __dirname;
const SRC = join(DIR, 'src');
const LIB = join(DIR, 'lib');

const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
if (!existsSync(SRC)) {
  console.log(`  ${pkg.name} no src/ — skipped`);
  process.exit(0);
}
rmSync(LIB, { recursive: true, force: true });
mkdirSync(LIB, { recursive: true });
const importMap = buildMap(join(DIR, '..'));
for (const rel of walk(SRC)) {
  const srcText = rewriteImports(readFileSync(join(SRC, rel), 'utf8'), importMap);
  const dest = join(LIB, rel);
  mkdirSync(join(dest, '..'), { recursive: true });
  writeFileSync(dest, srcText);
}
const main = pkg.main ?? 'lib/index.js';
if (!existsSync(join(DIR, main))) {
  console.error(`  ${pkg.name} FAIL — main "${main}" missing after build`);
  process.exit(1);
}
console.log(`  ${pkg.name} built → lib/`);
