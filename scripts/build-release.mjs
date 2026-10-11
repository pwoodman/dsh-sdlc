#!/usr/bin/env node
/**
 * scripts/build-release.mjs — the beta-tester artifact.
 *
 * WHY THIS EXISTS. A source checkout is not something a beta tester should
 * need: `git clone` + `npm install` + `node scripts/install-local.mjs` is three
 * steps, one of which needs a toolchain. This script produces ONE file that
 * contains everything needed to install the plugin on a machine that has only
 * `dsh`, `pnpm` and Node:
 *
 *   dsh-sdlc-<version>.tgz
 *     dsh-sdlc-<version>/
 *       install.sh          ← the tester runs this
 *       VERSION
 *       packages/<pkg>/lib/  ← prebuilt host entries + the browser bundle
 *       packages/<pkg>/cordis.patch.yml
 *       profiles/, scripts/, tests/, docs…
 *
 * The profiles install with `link:` specs pointing at the copy this script
 * makes under `$DSH_HOME/dsh-sdlc/<version>/`, so `link:` is deliberate: pnpm
 * does not resolve a linked package's dependencies, which is what lets the
 * unpublished `@patwoodman/*` members resolve to the local tree instead of a registry
 * that has never heard of them. A `file:` spec would send pnpm to the registry
 * for `@patwoodman/orchestrator-core@0.4.0-beta.2` and fail.
 *
 *   node scripts/build-release.mjs [--skip-build] [--out <dir>]
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { run } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const has = (name) => argv.includes(name);

const SKIP_BUILD = has('--skip-build');
const OUT_DIR = join(ROOT, flag('--out', 'dist'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NAME = `dsh-sdlc-${VERSION}`;
// Staged OUTSIDE the repo: cpSync refuses to copy a directory into itself, and
// a stage inside the tree would otherwise have to be excluded from its own copy.
const STAGE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-sdlc-stage-'));
const STAGE = join(STAGE_ROOT, NAME);
const TARBALL = join(OUT_DIR, `${NAME}.tgz`);
const ALIAS = join(OUT_DIR, 'dsh-sdlc-beta.tgz');

/** Never ship these: local state, caches, dependencies and the release output.
 *
 * The list is a FALLBACK for hosts without git. When the tree IS a git checkout
 * the exclusions come from `.gitignore` itself (see `ignoredPaths`), because a
 * hand-kept list drifts: a new scratch directory silently travelled in the
 * tarball and doubled its size the first time this was released.
 */
const EXCLUDE = [
  '.git', 'node_modules', '.tools', '.validation', '.sdlc', '.probe-dsh', 'dist',
  '.eval-home', '.eval-tarball-home', '.eval-tarball-home2', '.eval-out', '.eval-out-live', '.eval-out-pilot',
  '.eval-out-shard0', '.eval-out-shard1', '.eval-out-merged',
  // any other `.eval-*` scratch home (the git path derives these from .gitignore)
  '.eval-tarball-home2',
  'demo/.sdlc', 'demo/data', 'demo/dist',
  // The repo keeps no workspace lockfile (zero-dependency build); a stray one
  // must not travel in a release artifact where it would look authoritative.
  'pnpm-lock.yaml',
];

/**
 * Build output that .gitignore excludes but the ARTIFACT must carry: the
 * tarball installs with no build step, so the prebuilt `lib/` trees are the
 * whole point. Everything else that git ignores (node_modules, DSH homes, eval
 * output, caches) stays out.
 */
const KEEP_IGNORED = [
  /^packages\/[^/]+\/lib(\/|$)/,
  /^lib(\/|$)/,
];

/** Every path git reports as untracked-and-ignored (`--ignored=matching`
 *  expands ignored directories), or `null` outside a git checkout. */
function ignoredPaths() {
  const res = run('git', ['status', '--porcelain', '--ignored=matching', '-z'], { cwd: ROOT, timeoutMs: 120_000 });
  if (!res.ok) return null;
  const set = new Set();
  for (const entry of res.stdout.split('\0')) {
    if (entry.length < 4 || entry[0] !== '!' || entry[1] !== ' ') continue;
    set.add(entry.slice(3).replace(/\/+$/, ''));
    // A deleted-but-ignored file is reported with a rename arrow; keep it simple.
  }
  return set;
}

const IGNORED = ignoredPaths();

function isKeptIgnored(rel) {
  return KEEP_IGNORED.some((re) => re.test(rel));
}

function excluded(rel) {
  const posix = rel.split('\\').join('/');
  if (posix === '') return false;
  if (IGNORED && !isKeptIgnored(posix)) {
    // Ignored if the path itself, or any ancestor directory, is ignored.
    const parts = posix.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      if (IGNORED.has(parts.slice(0, i).join('/'))) return true;
    }
  }
  return EXCLUDE.some((e) => posix === e || posix.startsWith(`${e}/`));
}

const INSTALL_SH = `#!/bin/sh
# dsh-sdlc beta installer — no clone, no build, one command.
#
#   ./install.sh                 # install/refresh the three profiles
#   ./install.sh --dry-run       # show what it would do
#   ./install.sh --json          # machine-readable evidence bundle
#
# It copies this tree to \${DSH_HOME:-$HOME/.dsh}/dsh-sdlc/<version>/ first, so the
# download can be deleted afterwards: the profiles link into that copy, not into
# wherever you happened to unpack it.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"
DSH_HOME_DIR="\${DSH_HOME:-$HOME/.dsh}"
DEST="$DSH_HOME_DIR/dsh-sdlc/$VERSION"

mkdir -p "$(dirname "$DEST")"
if [ ! -d "$DEST" ]; then
  cp -R "$SRC" "$DEST"
  echo "dsh-sdlc: installed the plugin tree to $DEST"
else
  echo "dsh-sdlc: reusing $DEST"
fi

command -v dsh  >/dev/null 2>&1 || { echo "dsh-sdlc: 'dsh' is not on PATH. Install DeepSeek Harness first." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "dsh-sdlc: 'node' is not on PATH (>= 22.5 is required)." >&2; exit 1; }

exec node "$DEST/scripts/install-local.mjs" "$@"
`;

// ── build ──────────────────────────────────────────────────────────────────

if (!SKIP_BUILD) {
  for (const script of ['gen-presets.mjs', 'gen-bundle-patch.mjs', 'build.mjs', 'build-ui.mjs']) {
    // Absolute script path, no `cwd`: every generator resolves its own root from
    // `import.meta.dirname`, and not chdir-ing keeps this working on hosts where
    // the checkout path is not a normal directory (containers, portals, mounts).
    const res = run('node', [join(ROOT, 'scripts', script)], { timeoutMs: 600_000 });
    if (!res.ok) {
      process.stderr.write(
        `build-release: ${script} failed (exit ${res.code ?? 'n/a'}${res.error ? `: ${res.error.message}` : ''})\n` +
        `${res.stdout ?? ''}${res.stderr ?? ''}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`  ${script} ok\n`);
  }
}

// ── stage ──────────────────────────────────────────────────────────────────

mkdirSync(STAGE, { recursive: true });

const target = STAGE;
cpSync(ROOT, target, {
  recursive: true,
  dereference: false,
  filter: (src) => {
    const rel = relative(ROOT, src);
    if (rel === '') return true;
    return !excluded(rel);
  },
});

writeFileSync(join(target, 'VERSION'), `${VERSION}\n`);
writeFileSync(join(target, 'install.sh'), INSTALL_SH);
chmodSync(join(target, 'install.sh'), 0o755);

// The tarball must be installable with no build step: prove the host entries
// and the browser bundle travelled with it.
const REQUIRED = [
  'install.sh', 'VERSION', 'package.json', 'profiles/sdlc-web/profile.json',
  'packages/sdlc-orchestrator/lib/index.js',
  'packages/sdlc-orchestrator/cordis.patch.yml',
  'packages/sdlc-core/lib/index.js',
  'packages/sdlc-guard/lib/plugin.js',
  'packages/sdlc-tools/lib/plugin.js',
  'packages/sdlc-presets/lib/plugin.js',
  'packages/sdlc-client-ui/lib/index.js',
  'packages/sdlc-client-ui/lib/client.js',
];
const missing = REQUIRED.filter((rel) => !existsSync(join(target, rel)));
if (missing.length) {
  process.stderr.write(`build-release: the staged tree is incomplete: ${missing.join(', ')}\n`);
  process.exit(1);
}

// ── pack ───────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
rmSync(TARBALL, { force: true });
const tar = spawnSync('tar', ['-czf', TARBALL, '-C', STAGE_ROOT, NAME], { encoding: 'utf8' });
if (tar.status !== 0) {
  process.stderr.write(`build-release: tar failed\n${tar.stderr}\n`);
  process.exit(1);
}
cpSync(TARBALL, ALIAS);
rmSync(STAGE_ROOT, { recursive: true, force: true });

const bytes = statSync(TARBALL).size;
const sha = spawnSync('sha256sum', [TARBALL], { encoding: 'utf8' }).stdout.split(/\s+/)[0] ?? '';

process.stdout.write(
  `\n  ${relative(ROOT, TARBALL)}  ${(bytes / 1024 / 1024).toFixed(1)} MiB  sha256 ${sha.slice(0, 16)}…\n` +
  `  ${relative(ROOT, ALIAS)}  (stable name for a "latest" release URL)\n\n` +
  `  tester instructions:\n` +
  `    tar xzf ${NAME}.tgz && cd ${NAME} && ./install.sh\n\n`,
);
