/**
 * packages/sdlc-cli/build.cjs — standalone build for publishing.
 *
 * Copies src/ -> lib/ with cross-package import rewriting (the shared
 * transform from scripts/lib/cross-package-imports.cjs). The source tree keeps
 * relative imports so tests see one module instance; the published lib/ uses
 * bare npm specifiers so a registry install resolves through node_modules.
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
const main = pkg.main ?? 'lib/cli.mjs';
if (!existsSync(join(DIR, main))) {
  console.error(`  ${pkg.name} FAIL — main "${main}" missing after build`);
  process.exit(1);
}
console.log(`  ${pkg.name} built ${walk(SRC).length} files -> lib/`);
