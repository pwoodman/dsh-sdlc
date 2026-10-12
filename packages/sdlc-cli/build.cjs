/**
 * packages/sdlc-cli/build.cjs — standalone build for publishing.
 *
 * Copies src/ -> lib/ with cross-package import rewriting (the shared
 * transform from scripts/lib/cross-package-imports.cjs). The source tree keeps
 * relative imports so tests see one module instance; the published lib/ uses
 * bare npm specifiers so a registry install resolves through node_modules.
 */

const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildMap, rewriteImports } = require('../../scripts/lib/cross-package-imports.cjs');

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
