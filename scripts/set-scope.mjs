#!/usr/bin/env node
/**
 * scripts/set-scope.mjs — re-scope the whole suite for your own npm account.
 *
 * WHY THIS EXISTS. The packages ship under one npm scope (originally `@sdlc`).
 * A scope your account does not own makes `npm publish` answer 403 and makes
 * `dsh plugin add <pkg>` unresolvable for everyone else. Publishing under a
 * scope you own — `@your-username` is free and exists the moment you sign in to
 * npm, or a free npm org — is a one-time rename that touches far more than
 * package.json: every row in every `cordis.patch.yml` names a package, every
 * profile recipe lists bundles by name, the client bundle's module id must equal
 * its package name, and the tests and docs quote all of it.
 *
 * This script rewrites all of it in one pass, idempotently. The current scope is
 * read from the meta-bundle's manifest, so it works whatever scope the tree is
 * at now.
 *
 *   node scripts/set-scope.mjs @your-username            # rename
 *   node scripts/set-scope.mjs @your-username --check    # report drift only
 *   node scripts/set-scope.mjs --restore                 # back to the original
 *
 * It refuses an invalid npm scope, and it never touches node_modules, .git,
 * package build output, the eval fixtures, or itself.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ORIGINAL_SCOPE = '@sdlc/';
const SELF = join('scripts', 'set-scope.mjs');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const RESTORE = argv.includes('--restore');
const scopeArg = argv.find((a) => !a.startsWith('-'));

if (!scopeArg && !RESTORE) {
  process.stderr.write('usage: node scripts/set-scope.mjs @your-npm-username [--check]   (or --restore)\n');
  process.exit(2);
}

const bare = RESTORE ? ORIGINAL_SCOPE.slice(1, -1) : String(scopeArg).replace(/^@/, '').replace(/\/$/, '');
if (!/^[a-z0-9][a-z0-9._-]*$/.test(bare)) {
  process.stderr.write(
    `set-scope: "${scopeArg}" is not a valid npm scope.\n` +
    '  A scope is lowercase, slash-free and 1-214 chars: @your-username, @acme-team.\n' +
    '  Your own username scope exists automatically once you sign in to npm.\n',
  );
  process.exit(2);
}
const to = `@${bare}/`;

// The current scope comes from the tree itself, never from a constant that a
// previous rename would have rewritten.
const metaName = JSON.parse(readFileSync(join(ROOT, 'packages', 'sdlc-orchestrator', 'package.json'), 'utf8')).name;
const from = `${metaName.slice(0, metaName.indexOf('/'))}/`;

if (from === to) {
  process.stdout.write(`set-scope: already ${to} — nothing to do\n`);
  process.exit(0);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.tools', '.validation', '.sdlc']);
/** Package build output and run artifacts only. `scripts/lib`, `tests/lib` and
 *  `eval/lib` are SOURCE and do carry package names, so they must be rewritten. */
const SKIP_PATH = /^(packages\/[^/]+\/lib\/|\.eval-)/;
const TEXT = /\.(json|yml|yaml|mjs|cjs|js|jsx|md|sh)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (rel === SELF) continue;
    if (SKIP_PATH.test(rel) || SKIP_PATH.test(`${rel}/`)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEXT.test(entry)) out.push(full);
  }
  return out;
}

const changed = [];
for (const file of walk(ROOT)) {
  const before = readFileSync(file, 'utf8');
  // Plain `@scope/name`, plus the regex-escaped `@scope\/name` form that appears
  // inside /.../ literals. Both name packages, so both must move.
  const after = before.split(from).join(to).split(from.replace('/', '\\/')).join(to.replace('/', '\\/'));
  if (after === before) continue;
  changed.push(relative(ROOT, file));
  if (!CHECK) writeFileSync(file, after);
}

if (CHECK) {
  if (changed.length) {
    process.stderr.write(`set-scope: ${changed.length} file(s) still reference ${from}:\n  ${changed.join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`set-scope: every reference already uses ${to}\n`);
  process.exit(0);
}

process.stdout.write(
  `set-scope: ${from} → ${to} — ${changed.length} file(s) rewritten\n` +
  (changed.length ? `  ${changed.slice(0, 12).join('\n  ')}${changed.length > 12 ? `\n  … ${changed.length - 12} more` : ''}\n` : '') +
  '\n  next:\n' +
  '    node scripts/build-ui.mjs && node scripts/gen-bundle-patch.mjs\n' +
  "    node --test 'tests/**/*.test.mjs'\n" +
  (RESTORE
    ? ''
    : '    git tag v<version> && git push origin v<version>   # the Release workflow publishes when NPM_TOKEN is set\n'),
);
