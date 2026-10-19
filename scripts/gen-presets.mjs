#!/usr/bin/env node
/**
 * scripts/gen-presets.mjs — generate sdlc-presets/cordis.patch.yml from roles.js.
 *
 * The patch file is a build artifact of the role registry: keeping it generated
 * (and checked in) means the roster has ONE source of truth while the DSH loader
 * still sees a static patch. `pnpm --filter @patwoodman/dsh-sdlc-flow-presets gen`
 * regenerates it; a unit test asserts the checked-in file matches roles.js.
 *
 *   node scripts/gen-presets.mjs [--check]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { presetRows, presetRegistryRow, ROLE_COUNT } from '../packages/sdlc-presets/src/roles.js';
import { dumpYaml } from '../packages/sdlc-core/src/yaml-lite.js';

const ROOT = join(import.meta.dirname, '..');
const TARGET = join(ROOT, 'packages', 'sdlc-presets', 'cordis.patch.yml');
const CHECK = process.argv.includes('--check');
// The self-report row must name THIS package, so read its manifest instead of
// hardcoding a scope `scripts/set-scope.mjs` can rewrite.
const SELF_PACKAGE = JSON.parse(readFileSync(join(ROOT, 'packages', 'sdlc-presets', 'package.json'), 'utf8')).name;

const HEADER = `# sdlc-presets — the ${ROLE_COUNT}-role registry (spec v3 C.3).
#
# GENERATED FILE — do not edit by hand. Source of truth:
#   packages/sdlc-presets/src/roles.js
# Regenerate with:  node scripts/gen-presets.mjs
#
# Each row is a @deepseek-ai/dsh-agent-preset. A preset's \`plugins\` list IS the
# agent composition (P7/P15): persona rows compose the prompt; mounted tool rows
# are the allowlist (by omission); the sdlc_report row is the propose-only result
# channel. Permissions and model are deliberately absent (P15/P21) — permission
# comes from the profile's permission row, the model from the tier overlay (C.6).
#
# The agent-preset-registry row is FIRST inside insert: so the registry exists
# before the presets register against it on templates that lack one
# (headless/sdk). The web template already ships the row; the generated lead
# meta-bundle replaces this insert with an id-targeted override — a duplicate
# id+name is loader-accepted but blocks plugin-manager uninstall. The M0-02
# live check pins one registry row with default sdlc-lead.
#
# This member patch keeps all 26 role compositions for the headless probe and
# programmatic mounting. The lead meta-bundle filters it to PUBLIC_ROLE_IDS
# (currently the lead) so the interactive DSH preset picker is not a 26-row
# role menu; see scripts/gen-bundle-patch.mjs.
`;

// The registry row is FIRST inside insert: so it exists before the presets
// register against it on templates that lack one (headless/sdk). The web
// template ships the row, so gen-bundle-patch converts this member insert into
// an id-targeted override for the lead — a duplicate id+name blocks uninstall.
//
// A trailing `sdlc-presets` plugin row executes this bundle's apply() at boot
// so the SDLC_SELFTEST hook reports the roster: data-only patches never run
// code, so without this row the probe reports tools + services but zero
// presets (observed live). The row is LAST so the report flushes after every
// other bundle contributed.
const registry = presetRegistryRow();
const presets = presetRows().filter((r) => r.id !== registry.id);
const selfReport = {
  id: 'sdlc-presets',
  name: `${SELF_PACKAGE}/plugin`,
  config: {},
};
const body = dumpYaml([{ insert: [registry, ...presets, selfReport] }]);
const content = `${HEADER}${body}\n`;

if (CHECK) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  if (current !== content) {
    process.stderr.write('gen-presets: cordis.patch.yml is stale — run `node scripts/gen-presets.mjs`\n');
    process.exit(1);
  }
  process.stdout.write(`gen-presets: up to date (${ROLE_COUNT} rows)\n`);
  process.exit(0);
}

writeFileSync(TARGET, content);
process.stdout.write(`gen-presets: wrote ${TARGET} (${ROLE_COUNT} preset rows)\n`);
