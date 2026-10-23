#!/usr/bin/env node
/**
 * scripts/build-release.mjs — the no-clone release artifact.
 *
 * WHY THIS EXISTS. A source checkout is not something a release user should
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
 * for `@patwoodman/dsh-sdlc-flow-core@0.4.0-beta.2` and fail.
 *
 *   node scripts/build-release.mjs [--skip-build] [--out <dir>] [--dry-run] [--check]
 *
 * C20: exit codes come from scripts/lib/harness.mjs EXIT (PASS 0 / FAIL 1 /
 * USAGE 2); unknown flags exit USAGE, never FAIL. `--dry-run` prints what
 * would be staged without writing dist/. `--check` verifies the last build
 * output is fresh and exits without side effects.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { run, EXIT } from './lib/harness.mjs';
import { makeReleaseExcluder, parseIgnoredPaths } from './lib/release-excludes.mjs';

const ROOT = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const has = (name) => argv.includes(name);

const SKIP_BUILD = has('--skip-build');
const DRY_RUN = has('--dry-run');
const CHECK = has('--check');
const KNOWN = new Set(['--skip-build', '--out', '--dry-run', '--check']);
const unknown = argv.filter((a, i) => a.startsWith('--') && !KNOWN.has(a) && argv[i - 1] !== '--out');
if (unknown.length) {
  process.stderr.write(`build-release: unknown flag ${unknown[0]} (usage: [--skip-build] [--out <dir>] [--dry-run] [--check])\n`);
  process.exit(EXIT.USAGE);
}
const OUT_DIR = join(ROOT, flag('--out', 'dist'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NAME = `dsh-sdlc-${VERSION}`;
// Staged OUTSIDE the repo: cpSync refuses to copy a directory into itself, and
// a stage inside the tree would otherwise have to be excluded from its own copy.
const STAGE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-sdlc-stage-'));
const STAGE = join(STAGE_ROOT, NAME);
const TARBALL = join(OUT_DIR, `${NAME}.tgz`);
const ALIAS = join(OUT_DIR, 'dsh-sdlc-beta.tgz');

/** Every path git reports as untracked-and-ignored (`--ignored=matching`
 *  expands ignored directories), or `null` outside a git checkout.
 *
 *  The parser lives in `scripts/lib/release-excludes.mjs`: the first version
 *  required the `! ` porcelain form, so it silently matched nothing and let
 *  `.pnpm-store` (11 MiB) into the beta artifact. */
function ignoredPaths() {
  const res = run('git', ['status', '--porcelain', '--ignored=matching', '-z'], { cwd: ROOT, timeoutMs: 120_000 });
  if (!res.ok) return null;
  return parseIgnoredPaths(res.stdout);
}

const IGNORED = ignoredPaths();
const excluded = makeReleaseExcluder({ ignored: IGNORED });

const INSTALL_SH = `#!/bin/sh
# dsh-sdlc installer — no clone, no build, one command.
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

// ── check ──────────────────────────────────────────────────────────────────
// Verify the last build output is fresh without side effects: every REQUIRED
// entry resolves and build --check passes. No staging, no tarball.

if (CHECK) {
  // install.sh and VERSION are generated at stage time, not by the build —
  // the check covers build outputs only.
  const built = REQUIRED.filter((rel) => rel !== 'install.sh' && rel !== 'VERSION');
  const missing = built.filter((rel) => !existsSync(join(ROOT, rel)));
  if (missing.length) {
    process.stderr.write(`build-release --check: missing build output: ${missing.join(', ')}\n`);
    process.exit(EXIT.FAIL);
  }
  for (const script of ['build.mjs --check', 'build-ui.mjs --check']) {
    const [file, ...args] = script.split(' ');
    const res = run(process.execPath, [join(ROOT, 'scripts', file), ...args], { timeoutMs: 600_000 });
    if (!res.ok) {
      process.stderr.write(`build-release --check: ${script} is stale\n${res.stdout ?? ''}${res.stderr ?? ''}\n`);
      process.exit(EXIT.FAIL);
    }
  }
  process.stdout.write('build-release --check: staged tree complete, builds fresh\n');
  process.exit(EXIT.PASS);
}

// ── dry run ────────────────────────────────────────────────────────────────
// Print what WOULD be staged without writing dist/ or running the build.

if (DRY_RUN) {
  const planned = [...REQUIRED, `VERSION (${VERSION})`, 'install.sh (generated)'];
  process.stdout.write(`build-release --dry-run: would stage ${planned.length} required entries into ${NAME}.tgz\n`);
  for (const rel of planned) process.stdout.write(`  ${rel}\n`);
  process.stdout.write(`  tarball: ${relative(ROOT, TARBALL)}\n`);
  process.exit(EXIT.PASS);
}

// ── build ──────────────────────────────────────────────────────────────────

if (!SKIP_BUILD) {
  for (const script of ['gen-presets.mjs', 'build.mjs', 'build-ui.mjs', 'fold-meta.mjs', 'gen-bundle-patch.mjs']) {
    // Absolute script path, no `cwd`: every generator resolves its own root from
    // `import.meta.dirname`, and not chdir-ing keeps this working on hosts where
    // the checkout path is not a normal directory (containers, portals, mounts).
    const res = run(process.execPath, [join(ROOT, 'scripts', script)], { timeoutMs: 600_000 });
    if (!res.ok) {
      process.stderr.write(
        `build-release: ${script} failed (exit ${res.code ?? 'n/a'}${res.error ? `: ${res.error.message}` : ''})\n` +
        `${res.stdout ?? ''}${res.stderr ?? ''}\n`,
      );
      process.exit(EXIT.FAIL);
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
// and the browser bundle travelled with it (REQUIRED is declared once above).
const previous = REQUIRED.filter((rel) => !existsSync(join(target, rel)));
if (previous.length) {
  process.stderr.write(`build-release: the staged tree is incomplete: ${previous.join(', ')}\n`);
  process.exit(EXIT.FAIL);
}

// ── pack ───────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
rmSync(TARBALL, { force: true });
const tar = spawnSync('tar', ['-czf', TARBALL, '-C', STAGE_ROOT, NAME], { encoding: 'utf8' });
if (tar.status !== 0) {
  process.stderr.write(`build-release: tar failed\n${tar.stderr}\n`);
  process.exit(EXIT.FAIL);
}
cpSync(TARBALL, ALIAS);
rmSync(STAGE_ROOT, { recursive: true, force: true });

const bytes = statSync(TARBALL).size;
// C20: `sha256sum` is absent on some hosts (macOS without coreutils, minimal
// containers). Fall back to node:crypto so the digest line never prints
// `sha256 …` from an empty match over a failed spawn.
function sha256File(path) {
  const probed = spawnSync('sha256sum', [path], { encoding: 'utf8' });
  const external = (probed.stdout ?? '').split(/\s+/)[0] ?? '';
  if (probed.status === 0 && /^[0-9a-f]{64}$/i.test(external)) return external;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
const sha = sha256File(TARBALL);

process.stdout.write(
  `\n  ${relative(ROOT, TARBALL)}  ${(bytes / 1024 / 1024).toFixed(1)} MiB  sha256 ${sha.slice(0, 16)}…\n` +
  `  ${relative(ROOT, ALIAS)}  (stable name for a "latest" release URL)\n\n` +
  `  tester instructions:\n` +
  `    tar xzf ${NAME}.tgz && cd ${NAME} && ./install.sh\n\n`,
);
