/**
 * scripts/lib/fold-meta.cjs — fold the member packages into the meta-bundle.
 *
 * WHY: a profile installs ONE bundle (`@patwoodman/dsh-sdlc-flow`) but used to
 * carry FIVE `@patwoodman/*` entries (the meta plus four member dependencies),
 * so a GUI uninstall left four ghost entries behind and removing a member
 * first was refused by the package manager. Folding the members into the
 * meta-bundle makes a profile hold exactly ONE own-scope package: the plugin
 * manager's single remove button then removes everything, first try.
 *
 * The dependency closure is six packages (core→guard, tools→core, ui→cli):
 *   packages/sdlc-{guard,core,tools,presets,client-ui,cli} → folded here.
 *
 * TWO rewrite passes, because two different consumers resolve member names:
 *
 *   CODE (import/require specifiers inside folded .js): rewritten to RELATIVE
 *   paths between the folded trees (`../core/lib/worker-result.js`). Relative
 *   imports need no exports entry, work identically under the loader and under
 *   plain node, and keep each folded module's behavior byte-equivalent. String
 *   constants that merely CONTAIN a member name (e.g. the client's SDLC_ID)
 *   are deliberately untouched — they are labels, not resolutions.
 *
 *   PATCH (row `name:` fields and preset `plugins:` lists in cordis.patch.yml):
 *   rewritten to FLAT one-segment aliases on the meta package
 *   (`@patwoodman/dsh-sdlc-flow/services`, `…/tools-plugin`, `…/tools`,
 *   `…/presets-plugin`, `…/ui`) — the loader resolves row/plugin names through
 *   the package `exports` map, and one segment is the shape the loader already
 *   resolves today (`@patwoodman/dsh-sdlc-flow-core/services`).
 *
 * The worker and probe profiles keep mounting guard/tools/core/presets as
 * separate bundles (E6), so the member packages stay published and their own
 * patches stay untouched — only the meta-bundle's generated patch is folded.
 */
'use strict';

const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');

const ROOT = join(__dirname, '..', '..');
const META_DIR = join(ROOT, 'packages', 'sdlc-orchestrator');

/** Fold order = the generated patch's load order (guard first: core imports it). */
const FOLD = [
  { dir: 'sdlc-guard', short: 'guard' },
  { dir: 'sdlc-core', short: 'core' },
  { dir: 'sdlc-tools', short: 'tools' },
  { dir: 'sdlc-presets', short: 'presets' },
  { dir: 'sdlc-client-ui', short: 'ui' },
  { dir: 'sdlc-cli', short: 'cli' },
];

/** npm name of a folded member, from its manifest (never a hardcoded scope). */
function memberName(dir) {
  return JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')).name;
}

const memberNames = () => FOLD.map((f) => memberName(f.dir));

/** Escape a package name for literal use in a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Member main entries that are not `lib/index.js`. */
const MEMBER_MAIN = { 'sdlc-cli': 'lib/cli.mjs' };

/** Member subpath exports that are not the plain `lib/<sub>.js` stem rule. */
const MEMBER_SUBPATH = {
  'sdlc-core/complexity': 'lib/complexity/index.js',
};

/** Absolute file a member specifier resolves to, inside the member's package. */
function memberFile(dir, subpath) {
  const main = MEMBER_MAIN[dir] ?? 'lib/index.js';
  if (!subpath) return join(ROOT, 'packages', dir, main);
  const special = MEMBER_SUBPATH[`${dir}/${subpath}`];
  return join(ROOT, 'packages', dir, special ?? `lib/${subpath}.js`);
}

/** Absolute file of a folded member specifier, inside the meta package. */
function foldedFile(short, subpath) {
  const member = FOLD.find((f) => f.short === short);
  const dir = join(META_DIR, 'lib', 'rows', short, 'lib');
  if (!subpath) {
    // A bare member import resolves to the member's MAIN, which is not always
    // lib/index.js (the CLI's is lib/cli.mjs).
    const main = MEMBER_MAIN[member.dir] ?? 'lib/index.js';
    return join(META_DIR, 'lib', 'rows', short, main);
  }
  const special = MEMBER_SUBPATH[`${member.dir}/${subpath}`];
  if (special) return join(META_DIR, 'lib', 'rows', short, special);
  return join(dir, `${subpath}.js`);
}

/**
 * CODE pass — rewrite import/require specifiers that name a folded member.
 * Only specifiers after `from '`, `import('` or `require('` are touched, so
 * identity strings (SDLC_ID, PACKAGE labels) survive verbatim.
 */
function rewriteCode(text, fromDir) {
  const names = memberNames().map(escapeRe).join('|');
  const re = new RegExp(`(\\b(?:from|import|require)\\s*\\(?\\s*['"])(${names})((?:/[A-Za-z0-9@._-]+)*)['"]`, 'g');
  return text.replace(re, (m, lead, name, sub) => {
    const member = FOLD.find((f) => memberName(f.dir) === name);
    const target = foldedFile(member.short, sub ? sub.slice(1) : '');
    const rel = relative(fromDir, target).split('\\').join('/');
    return `${lead}${rel.startsWith('.') ? rel : `./${rel}`}'`;
  });
}

/** FLAT aliases the folded patch uses: member(+sub) → [rows-short, alias, file]. */
const FLAT_ALIAS = {
  'core': ['core', 'core', 'index.js'],
  'core/services': ['core', 'services', 'services.js'],
  'core/selftest': ['core', 'selftest', 'selftest.js'],
  'tools': ['tools', 'tools', 'index.js'],
  'tools/plugin': ['tools', 'tools-plugin', 'plugin.js'],
  'presets': ['presets', 'presets', 'index.js'],
  'presets/plugin': ['presets', 'presets-plugin', 'plugin.js'],
  'ui': ['ui', 'ui', 'index.js'],
  'guard': ['guard', 'guard', 'index.js'],
  'cli': ['cli', 'cli', 'cli.mjs'],
};

/** The exports map entries the folded aliases need (export key → lib path). */
function aliasExports() {
  const out = {};
  for (const [memberKey, [short, alias, file]] of Object.entries(FLAT_ALIAS)) {
    out[`./${alias}`] = `./lib/rows/${short}/lib/${file}`;
  }
  return out;
}

/**
 * PATCH pass — rewrite member references in a member's patch body to the
 * meta's flat aliases. Handles quoted names with and without a subpath.
 */
function rewritePatch(text) {
  const names = memberNames().map(escapeRe).join('|');
  const re = new RegExp(`(['"])(${names})((?:/[A-Za-z0-9._-]+)?)\\1`, 'g');
  return text.replace(re, (m, quote, name, sub) => {
    const member = FOLD.find((f) => memberName(f.dir) === name);
    const entry = FLAT_ALIAS[member.short + (sub || '')];
    if (!entry) return m; // unknown subpath: leave verbatim (the --check pass flags it)
    return `${quote}@patwoodman/dsh-sdlc-flow/${entry[1]}${quote}`;
  });
}

/** Copy one member's lib/ into lib/rows/<short>/lib/ with the CODE rewrite. */
function foldMemberLib({ dir, short }) {
  const src = join(ROOT, 'packages', dir, 'lib');
  if (!existsSync(src)) throw new Error(`fold-meta: ${src} missing — run the build first`);
  const dest = join(META_DIR, 'lib', 'rows', short);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, join(dest, 'lib'), { recursive: true });
  // A stub manifest so code reading `../../package.json` (the UI's pkgVersion)
  // keeps working at its new depth without rewriting that path. `"type":
  // "module"` keeps the loader and node from mis-parsing the ESM tree as CJS.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'));
  writeFileSync(join(dest, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }, null, 2)}\n`);
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  })(join(dest, 'lib'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let rewritten = rewriteCode(text, join(file, '..'));
    // The browser module id MUST equal the SERVING package's name (DSH's client
    // loader keys the module table by it), so inside the folded client bundle
    // every `@patwoodman/dsh-sdlc-flow-ui` string — module id, style-tag id and
    // `dataset.plugin` — becomes the meta package's name.
    if (short === 'ui' && file.endsWith(join('lib', 'client.js'))) {
      rewritten = rewritten.split(pkg.name).join('@@META@@');
    }
    if (rewritten !== text) writeFileSync(file, rewritten);
  }
  return pkg;
}

/** Fold every member and update the meta manifest (idempotent). */
function fold() {
  let uiPkg = null;
  for (const member of FOLD) {
    const foldedPkg = foldMemberLib(member);
    if (member.short === 'ui') uiPkg = foldedPkg;
  }
  const manifestPath = join(META_DIR, 'package.json');
  const metaName = JSON.parse(readFileSync(manifestPath, 'utf8')).name;
  // The client bundle placeholders are now the meta name (rewritten per file
  // against each member's own name first, so the ui bundle's id/tag follow).
  for (const member of FOLD) {
    if (member.short !== 'ui') continue;
    const clientPath = join(META_DIR, 'lib', 'rows', 'ui', 'lib', 'client.js');
    writeFileSync(clientPath, readFileSync(clientPath, 'utf8').split('@@META@@').join(metaName));
  }
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete pkg.dependencies;
  // Reset, don't merge: a previous fold (or an older rows/-style scheme) must
  // never leave stale alias keys in the shipped exports map.
  const aliasKeys = new Set(Object.keys(aliasExports()));
  const aliasStem = /^\.\/(core|tools|presets|guard|ui|cli|services|selftest|tools-plugin|presets-plugin|rows)\b/;
  const base = {};
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    if (aliasKeys.has(key) || aliasStem.test(key)) continue;
    base[key] = value;
  }
  const exports = { ...base, ...aliasExports() };
  // The browser entry the client loader fetches from the SERVING package.
  exports['./client'] = './lib/rows/ui/lib/client.js';
  pkg.exports = exports;
  // The host-side client manifest travels with the fold: same inject list and
  // platform as the ui member declared.
  pkg.dsh = { ...(pkg.dsh ?? {}), client: uiPkg?.dsh?.client };
  pkg.files = [...new Set([...(pkg.files ?? []), 'lib/rows'])];
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return FOLD.map((f) => f.short);
}

/** Whether the fold has already been applied to the meta manifest. */
function isFolded() {
  const pkg = JSON.parse(readFileSync(join(META_DIR, 'package.json'), 'utf8'));
  return !pkg.dependencies && Boolean(pkg.exports?.['./services']);
}

module.exports = { FOLD, ROOT, META_DIR, fold, isFolded, rewritePatch, rewriteCode, aliasExports, memberNames, memberName, foldedFile };
