/**
 * packages/sdlc-cli/build.cjs — standalone build for publishing.
 *
 * The CLI is source-shipped (plain ESM, zero dependencies), so there is
 * nothing to compile: the "build" only proves the declared entry points exist,
 * which is what `prepack`/`prepare` need to fail on if a file was renamed.
 */

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');

const DIR = __dirname;
const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));

const required = [pkg.main ?? 'src/cli.mjs', ...Object.values(pkg.bin ?? {})];
const missing = required.filter((rel) => !existsSync(join(DIR, rel)));
if (missing.length) {
  console.error(`  ${pkg.name} FAIL — missing ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`  ${pkg.name} source-shipped, ${required.length} entries ok`);
