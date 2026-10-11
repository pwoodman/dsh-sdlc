/**
 * packages/sdlc-orchestrator/build.cjs — standalone build for publishing.
 *
 * The meta-bundle ships a trivial lib/index.js mirror (zero dependencies).
 */

const { cpSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const DIR = __dirname;
mkdirSync(join(DIR, 'lib'), { recursive: true });
cpSync(join(DIR, 'src', 'index.js'), join(DIR, 'lib', 'index.js'));
if (!existsSync(join(DIR, 'lib', 'index.js'))) {
  console.error('  @sdlc/orchestrator FAIL — lib/index.js missing after build');
  process.exit(1);
}
console.log('  @sdlc/orchestrator built → lib/');
