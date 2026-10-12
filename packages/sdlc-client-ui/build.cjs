/**
 * packages/sdlc-client-ui/build.cjs — standalone build for publishing.
 *
 * Delegates to the workspace builder when present (source checkout);
 * falls back to an inlined mirror (src/ → lib/) plus a prebuilt client
 * bundle check when packed standalone. The published tarball always ships
 * lib/ (host entry + client.js closure-factory bundle), so no build runs
 * on the consumer's machine.
 */

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { buildMap, rewriteImports } = require('../../scripts/lib/cross-package-imports.cjs');
const { execFileSync } = require('node:child_process');

const DIR = __dirname;
const WORKSPACE_BUILDER = join(DIR, '..', '..', 'scripts', 'build-ui.mjs');

if (existsSync(WORKSPACE_BUILDER)) {
  execFileSync(process.execPath, [WORKSPACE_BUILDER], { cwd: join(DIR, '..', '..'), stdio: 'inherit' });
} else {
  // Standalone pack: lib/ must already exist (built before pack).
  for (const f of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(join(DIR, f))) {
      console.error(`  @patwoodman/orchestrator-ui FAIL — ${f} missing (run the workspace build first)`);
      process.exit(1);
    }
  }
  console.log('  @patwoodman/orchestrator-ui lib/ verified');
}
