#!/usr/bin/env node
/**
 * scripts/gen-bundle-patch.mjs — generate the lead meta-bundle's patch layer.
 *
 * WHY THIS EXISTS. The DSH loader mounts exactly the bundles a profile lists in
 * `dsh.profile.bundles`; it does NOT descend into a bundle's `dependencies`. A
 * meta-bundle whose members are ordinary npm dependencies therefore composes
 * NOTHING but its own row — which is what `dsh plugin --profile sdlc-web add
 * @sdlc/orchestrator` used to produce: one `sdlc-orchestrator` row and no
 * services, tools, presets or UI.
 *
 * `@sdlc/orchestrator` is the one spec the lead installs, so its own patch must
 * carry the whole lead composition. That composition is the union of its four
 * members' rows, and this script is the single place that union is assembled:
 * the members keep owning their rows (the worker and probe profiles mount them
 * as bundles directly), while the meta-bundle's patch is generated from them so
 * the two can never drift.
 *
 * The union is a textual concatenation of each member's patch body. Concatenating
 * top-level YAML sequences yields one sequence of `insert:` entries — exactly the
 * dialect the loader reads — and it preserves each member's formatting verbatim,
 * including `!!js` expressions and long block scalars that a parse/re-dump round
 * trip could mangle.
 *
 *   node scripts/gen-bundle-patch.mjs [--check]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const META_DIR = join(ROOT, 'packages', 'sdlc-orchestrator');
const TARGET = join(META_DIR, 'cordis.patch.yml');
const CHECK = process.argv.includes('--check');

/** The lead composition, in load order. Each entry owns its rows. */
const MEMBERS = [
  { dir: 'sdlc-core', pkg: '@sdlc/orchestrator-core', what: 'host services (spec v3 C.2)' },
  { dir: 'sdlc-tools', pkg: '@sdlc/orchestrator-tools', what: 'model tools + the /sdlc command surface (C.4)' },
  { dir: 'sdlc-presets', pkg: '@sdlc/orchestrator-presets', what: 'the 26 role presets (C.3)' },
  { dir: 'sdlc-client-ui', pkg: '@sdlc/orchestrator-ui', what: 'the web UI + host routes (C.1)' },
];

const HEADER = `# sdlc-orchestrator — lead-profile meta-bundle (the ONE spec the lead installs).
#
# GENERATED FILE — do not edit by hand.
# Regenerate with:  node scripts/gen-bundle-patch.mjs
#
# The DSH loader mounts exactly the bundles listed in \`dsh.profile.bundles\` and
# loads each one's OWN \`dsh.bundle.patch\`; it does not follow a bundle's
# \`dependencies\`. So this package — the single spec the lead profile installs —
# must declare the whole lead composition itself. Below is the union of its four
# members' rows, concatenated verbatim by the generator:
#
#   ${MEMBERS.map((m) => `${m.pkg.padEnd(34)} ${m.what}`).join('\n#   ')}
#
# The members keep declaring their own \`dsh.bundle.patch\` because the worker and
# probe profiles mount them as bundles directly (\`profiles/*/profile.json\`).
# They are never listed as bundles in the lead profile: in the lead they are
# plain module dependencies, present so the row names below resolve. Listing
# them there as well would compose every row twice.
#
# Order matters only where a row waits on a service: services first, then the
# tools and preset rows that use them, then the UI. The
# \`agent-preset-registry\` row stays FIRST inside the presets block (the dialect
# has no insert-if-missing), so on the web template the composed lead holds two
# same-id registry rows at one service — the loader accepts both and every
# preset activates (verified live); M0-02 pins those counts.
`;

const SELF_ROW = `# ── the meta-bundle's own row ────────────────────────────────────────────────
# A row that executes this package's apply() at boot, so the meta-bundle is a
# real loader layer rather than data alone (the sdlc-ui self-report pattern).
- insert:
    - id: sdlc-orchestrator
      name: '@sdlc/orchestrator'
      config: {}
`;

/** The member's patch body with its leading comment/blank header block removed. */
function bodyOf(member) {
  const path = join(ROOT, 'packages', member.dir, 'cordis.patch.yml');
  if (!existsSync(path)) throw new Error(`gen-bundle-patch: ${path} does not exist`);
  const lines = readFileSync(path, 'utf8').split('\n');
  let first = 0;
  while (first < lines.length && (lines[first].trim() === '' || lines[first].startsWith('#'))) first += 1;
  if (!lines[first]?.startsWith('-')) {
    throw new Error(`gen-bundle-patch: ${path} does not start a top-level YAML sequence with "- "`);
  }
  let last = lines.length - 1;
  while (last > first && lines[last].trim() === '') last -= 1;
  return lines.slice(first, last + 1).join('\n') + '\n';
}

const blocks = MEMBERS.map((member) => {
  const rule = `# ── from ${member.pkg} — ${member.what}\n`;
  return `${rule}${bodyOf(member)}`;
});

const content = `${HEADER}\n${SELF_ROW}\n${blocks.join('\n')}`;

if (CHECK) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  if (current !== content) {
    process.stderr.write('gen-bundle-patch: packages/sdlc-orchestrator/cordis.patch.yml is stale — run `node scripts/gen-bundle-patch.mjs`\n');
    process.exit(1);
  }
  process.stdout.write(`gen-bundle-patch: up to date (${MEMBERS.length} member layers)\n`);
  process.exit(0);
}

writeFileSync(TARGET, content);
process.stdout.write(`gen-bundle-patch: wrote ${TARGET} (${MEMBERS.length} member layers)\n`);
