#!/usr/bin/env node
/**
 * scripts/install-local.mjs — install the orchestrator from a source checkout.
 *
 * This is the "works today" path. The published-npm path
 * (`npx @patwoodman/dsh-sdlc-flow init`) is a thin wrapper that downloads the packages
 * first and then runs exactly these steps.
 *
 * Corrected against the real CLI (spec v2 Quick Start / Part F are wrong):
 *   - `--headless` is NOT a launcher flag. A one-shot profile must include the
 *     `@deepseek-ai/dsh-headless` bundle, created from the shipped `headless`
 *     template. `dsh --profile X --headless "..."` exits 1 with
 *     "unknown option '--headless'".
 *   - Profile templates are a closed set {acp, web, headless, sdk, sdk-minimal};
 *     an out-of-tree plugin cannot ship one. Custom profiles are created with
 *     `dsh <name> --from-default-profile <shipped>`.
 *   - `dsh plugin --profile X add <pkg...>` forwards to pnpm; pnpm is required
 *     (exit 127 without it) and multiple local directories are supported.
 *   - There is no `dsh plugin init`; profiles initialize on first use.
 *
 *   node scripts/install-local.mjs [--dry-run] [--json] [--skip-build]
 *     --profile-lead <name>    (default sdlc-web)
 *     --profile-worker <name>  (default sdlc-worker)
 *     --profile-probe <name>   (default sdlc-probe, from the `sdk` template)
 *
 * Idempotent, non-interactive and safe to re-run.
 *
 * The lead gets exactly ONE sdlc bundle. `@patwoodman/dsh-sdlc-flow`'s patch is
 * GENERATED as the union of its members' rows (scripts/gen-bundle-patch.mjs),
 * because the DSH loader mounts only the bundles a profile lists and never
 * descends into a bundle's dependencies. The four members are installed as
 * plain module dependencies so the row names resolve from the profile's
 * node_modules. Adding them as bundles too would compose every row twice.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from './lib/harness.mjs';
import { dshPeerSatisfied } from './lib/semver-lite.mjs';
import { ownBundlePrefix, isOwnBundleName } from './lib/composition.mjs';
import { PUBLIC_ROLE_COUNT } from '../packages/sdlc-presets/src/roles.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const has = (name) => argv.includes(name);

const DRY_RUN = has('--dry-run');
const SKIP_BUILD = has('--skip-build');
const JSON_OUT = has('--json');
const HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const ROOT = join(import.meta.dirname, '..');

const LEAD = flag('--profile-lead', 'sdlc-web');
const WORKER = flag('--profile-worker', 'sdlc-worker');
const PROBE = flag('--profile-probe', 'sdlc-probe');

/** package name → directory, for every packages/* manifest. */
const PKG_DIR = (() => {
  const dir = join(ROOT, 'packages');
  const map = new Map();
  for (const name of readdirSync(dir)) {
    const manifest = join(dir, name, 'package.json');
    if (!existsSync(manifest)) continue;
    map.set(JSON.parse(readFileSync(manifest, 'utf8')).name, join(dir, name));
  }
  return map;
})();

function pkgDir(name) {
  const dir = PKG_DIR.get(name);
  if (!dir) throw new Error(`package ${name} has no packages/* directory`);
  return dir;
}

/** The bundle list a profile recipe declares — the single source of truth. */
function recipeBundles(recipe) {
  const path = join(ROOT, 'profiles', recipe, 'profile.json');
  const bundles = JSON.parse(readFileSync(path, 'utf8')).bundles;
  if (!Array.isArray(bundles) || bundles.length === 0) throw new Error(`${path}: bundles must be a non-empty array`);
  return bundles;
}

const LEAD_RECIPE = 'sdlc-web';
const PROBE_RECIPE = 'sdlc-probe';
const WORKER_RECIPE = 'sdlc-worker';

/**
 * `@scope/` of THIS suite, read from the packages' own manifests. Never a
 * literal: after `scripts/set-scope.mjs` renames the suite, a hardcoded prefix
 * stops matching the suite's bundles — the previous scope then survives in
 * `dsh.profile.bundles` and every composed row appears twice.
 */
const OWN_PREFIX = ownBundlePrefix();

/** `@scope/dsh-sdlc-flow-core` in this tree — used only in remediation text. */
const CORE_PACKAGE = [...PKG_DIR.keys()].find((name) => name.endsWith('-core')) ?? `${OWN_PREFIX}dsh-sdlc-flow-core`;


const steps = [];
let failed = false;

function step(name, fn) {
  const started = Date.now();
  if (DRY_RUN) {
    steps.push({ name, status: 'dry-run', ms: 0 });
    if (!JSON_OUT) console.log(`  [dry-run] ${name}`);
    return;
  }
  try {
    const detail = fn() ?? '';
    steps.push({ name, status: 'ok', detail, ms: Date.now() - started });
    if (!JSON_OUT) console.log(`  [ok]      ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failed = true;
    steps.push({ name, status: 'fail', error: e.message, ms: Date.now() - started });
    if (!JSON_OUT) console.log(`  [FAIL]    ${name}\n            ${e.message}`);
  }
}

function sh(cmd, args, opts = {}) {
  const res = run(cmd, args, { timeoutMs: 900_000, ...opts });
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || String(res.error ?? '')).trim().slice(0, 1500);
    // `dsh plugin` buries the pnpm reason in a per-operation log file. Surface
    // its tail so CI failures are diagnosable without SSH-ing into the runner.
    // Note: the log only captures piped output; CLI-inherited pnpm output goes
    // to our own stdout/stderr instead, so capture the tail of THOSE too.
    const ownTail = [res.stdout, res.stderr].map((t) => String(t ?? '').trim().split('\n').slice(-12).join('\n')).join('\n').trim().slice(-1200);
    let logTail = '';
    if (cmd === 'dsh') {
      const m = /diagnostics:\s*(\S+)/.exec(detail);
      if (m) {
        try {
          const text = readFileSync(m[1], 'utf8').trim();
          logTail = text
            ? `\n--- pnpm.log tail (${m[1]}) ---\n${text.split('\n').slice(-25).join('\n')}`
            : `\n--- pnpm.log (${m[1]}) is EMPTY: pnpm inherited our stdio, so its error is in our own output tail above; the empty log only records the exit code ---`;
        } catch {
          logTail = `\n--- pnpm.log (${m[1]}) is unreadable ---`;
        }
      }
    }
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.code}\n--- own output tail ---\n${ownTail}\n${detail}${logTail}`);
  }
  return res;
}

// ── preflight ──────────────────────────────────────────────────────────────

if (!JSON_OUT) {
  console.log(`\nSDLC orchestrator — local install${DRY_RUN ? ' (dry run)' : ''}`);
  console.log('==========================================\n');
  console.log(`  DSH_HOME : ${HOME}`);
  console.log(`  source   : ${ROOT}\n`);
}

/**
 * Repair profile state that makes a re-install fail for reasons that have
 * nothing to do with the current tree:
 *
 *   1. DEAD DEPENDENCIES. A profile installed by an earlier scope (or from a
 *      since-moved checkout) still carries an own-suite dependency that no
 *      longer resolves: `@old-scope/orchestrator-*`, which `dsh plugin add`
 *      would try to fetch from the registry, or a `link:` path that no longer
 *      exists. pnpm resolves every dependency it is asked to lock, so ONE dead
 *      entry fails the whole `dsh plugin add` — including the profiles the user
 *      never touched. A healthy entry (present scope, existing link target) is
 *      kept: the recipe re-adds it anyway, and re-adding is the slow part.
 *   2. A FOREIGN pnpm STORE. `node_modules/.modules.yaml` records the global
 *      store a profile was linked from. If that store no longer exists (a moved
 *      checkout, a different `XDG_DATA_HOME`, a different pnpm major), pnpm
 *      aborts with ERR_PNPM_UNEXPECTED_STORE *before* installing anything and
 *      never repairs itself: only `pnpm install` or deleting `node_modules`
 *      does. That is the failure a moved checkout always produces.
 *
 * Both are profile-local derived state that the recipe recreates, so dropping
 * them is safe. Anything else in the profile is left alone.
 */
step('repair: dead own-suite dependencies and any foreign pnpm store', () => {
  const repaired = [];
  for (const profile of [LEAD, WORKER, PROBE]) {
    const manifestPath = join(HOME, 'profiles', profile, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const deps = manifest.dependencies ?? {};

    const dead = [];
    for (const [name, spec] of Object.entries(deps)) {
      if (!isOwnBundleName(name)) continue;
      // In this tree, or linked to a directory that exists → still healthy.
      if (PKG_DIR.has(name)) continue;
      if (typeof spec === 'string' && spec.startsWith('link:')) {
        const target = spec.slice('link:'.length).split('#')[0];
        if (existsSync(target)) continue;
      }
      dead.push(name);
    }
    if (dead.length > 0) {
      manifest.dependencies = Object.fromEntries(Object.entries(deps).filter(([name]) => !dead.includes(name)));
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      repaired.push(`${profile}: dropped ${dead.length} dead dependenc${dead.length === 1 ? 'y' : 'ies'} (${dead.join(', ')})`);
    }

    const modules = join(HOME, 'profiles', profile, 'node_modules');
    const marker = join(modules, '.modules.yaml');
    if (!existsSync(marker)) continue;
    const meta = readFileSync(marker, 'utf8');
    // `.modules.yaml` is JSON in practice; fall back to a line match if a future
    // pnpm writes real YAML.
    let store = null;
    try { store = JSON.parse(meta)?.storeDir ?? null; } catch { /* not JSON */ }
    store ??= /storeDir:\s*(.+)$/m.exec(meta)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null;
    if (store && !existsSync(store)) {
      rmSync(modules, { recursive: true, force: true });
      repaired.push(`${profile}: removed node_modules linked from the missing store ${store}`);
    }
  }
  return repaired.length ? repaired.join('; ') : 'nothing to repair';
});

/**
 * The meta-bundle is SELF-CONTAINED (the members are folded into its
 * lib/rows/): a lead profile installed by an older tree still carries the four
 * member modules as plain dependencies — ghost entries a GUI uninstall cannot
 * remove. Drop them so an upgrade converges on the one-package shape.
 */
step('repair: drop member ghosts from the lead (the meta-bundle is self-contained)', () => {
  const manifestPath = join(HOME, 'profiles', LEAD, 'package.json');
  if (!existsSync(manifestPath)) return 'no lead profile yet';
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const [bundle] = recipeBundles(LEAD_RECIPE);
  const deps = { ...(manifest.dependencies ?? {}) };
  const ghosts = Object.keys(deps).filter((n) => isOwnBundleName(n) && n !== bundle);
  if (ghosts.length === 0) return 'nothing to repair';
  for (const ghost of ghosts) delete deps[ghost];
  manifest.dependencies = deps;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return `dropped ${ghosts.length} member ghost${ghosts.length === 1 ? '' : 's'} (${ghosts.join(', ')})`;
});

step('preflight: package directories present', () => {
  const wanted = new Set([
    ...recipeBundles(LEAD_RECIPE), ...recipeBundles(WORKER_RECIPE), ...recipeBundles(PROBE_RECIPE),
    ...Object.keys(JSON.parse(readFileSync(join(pkgDir(recipeBundles(LEAD_RECIPE)[0]), 'package.json'), 'utf8')).dependencies ?? {}),
  ]);
  const missing = [...wanted].filter((name) => !PKG_DIR.has(name));
  if (missing.length) throw new Error(`no packages/* directory for: ${missing.join(', ')}`);
  return `${wanted.size} packages`;
});
step('preflight: dsh CLI on PATH', () => sh('dsh', ['--version']).stdout.trim());

/**
 * A `dsh` that RUNS is not enough — the platform suite has to find the installed
 * `@deepseek-ai/dsh` package directory next to the executable (PLAT-08 reads its
 * shutdown templates; PLAT-13/14/16 skip without it). A wrapper on PATH — the
 * common `npx @deepseek-ai/dsh` shim, a hand-written script, a shell function —
 * satisfies `--version` and then fails the post-install M0 gate with a message
 * about shutdown templates that says nothing about the real cause. Fail here
 * instead, before anything is installed.
 */
step('preflight: dsh resolves to an installed @deepseek-ai/dsh package', () => {
  const which = run('sh', ['-c', 'command -v dsh']);
  const found = which.stdout.trim();
  if (!found) throw new Error('dsh is not on PATH');
  let resolved = found;
  try { resolved = execFileSync('realpath', [found], { encoding: 'utf8' }).trim(); } catch { /* keep */ }
  // npm/pnpm global bin links point straight at the package's bin entry.
  const parts = resolved.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const pkg = join(parts.slice(0, i).join('/'), 'package.json');
    if (!existsSync(pkg)) continue;
    try {
      if (JSON.parse(readFileSync(pkg, 'utf8')).name === '@deepseek-ai/dsh') return resolved;
    } catch { /* not a manifest we can read */ }
  }
  throw new Error(
    `dsh on PATH (${found}) is not an installed @deepseek-ai/dsh package.\n` +
      `  A wrapper (npx, a shim, a shell function) runs --version but has no package\n` +
      `  directory, so the post-install M0 gate fails on PLAT-08 shutdown templates.\n` +
      `  Fix: npm install -g @deepseek-ai/dsh@0.2.0-rc.2`,
  );
});
step('preflight: DSH runtime within the declared peer range', () => {
  const actual = sh('dsh', ['--version']).stdout.trim().replace(/^v/, '');
  const want = JSON.parse(readFileSync(join(ROOT, 'packages', 'sdlc-core', 'package.json'), 'utf8')).peerDependencies['@deepseek-ai/dsh'];
  if (!dshPeerSatisfied(actual)) {
    throw new Error(
      `dsh ${actual} is outside the declared peer range ${want}.\n` +
        `  Install a 0.2.x runtime, or grant an exemption:\n` +
        `    dsh plugin --profile ${LEAD} allow-version ${CORE_PACKAGE}@<ver> --dsh-version ${actual} --accept-risk`,
    );
  }
  return actual;
});
step('preflight: pnpm available (required by `dsh plugin`)', () => {
  const res = run('pnpm', ['--version']);
  if (!res.ok) {
    throw new Error('pnpm not on PATH. `dsh plugin add` exits 127 without it.\n  Fix: npm install -g pnpm\n  (corepack is not bundled with Node 25+)');
  }
  return `pnpm ${res.stdout.trim()}`;
});

// ── build ──────────────────────────────────────────────────────────────────

if (!SKIP_BUILD) {
  // Absolute script paths and no `cwd`: each generator resolves its own root from
  // `import.meta.dirname`. Not chdir-ing means the install also works when the
  // checkout lives somewhere node cannot `getcwd()` (containers, portal mounts).
  // Order matters: fold-meta.mjs copies each member's built lib/ into the
  // meta-bundle's lib/rows/, but build.mjs starts by wiping lib/ — so a second
  // bare build AFTER the fold deletes the folded tree (M0-11 then fails with
  // "@patwoodman/dsh-sdlc-flow/services does not resolve to a file"). Build
  // once, fold once, generate the patch last; never rebuild after folding.
  // The link step comes FIRST: member lib/ files import each other through
  // bare specifiers (@patwoodman/…), which resolve through the workspace
  // node_modules links. A no-clone tarball has no node_modules at all, so
  // without this the tarball install fails M0-03/M0-04/M0-12 with "failed to
  // import" while the source-checkout install passes.
  const gen = (name) => sh('node', [join(ROOT, 'scripts', name)]).stdout.trim().slice(-160);
  step('build: artifacts + fold + generated patches', () =>
    gen('link-workspace.mjs') + gen('gen-presets.mjs') + gen('build.mjs') + gen('build-ui.mjs') + gen('fold-meta.mjs') + gen('gen-bundle-patch.mjs'),
  );
}

// ── profiles ───────────────────────────────────────────────────────────────
// `--from-default-profile` only accepts the shipped template names, which each
// recipe declares (`profiles/<recipe>/profile.json#template`). Creating a
// profile this way is idempotent: initProfile never overwrites existing files.

function recipeTemplate(recipe) {
  return JSON.parse(readFileSync(join(ROOT, 'profiles', recipe, 'profile.json'), 'utf8')).template;
}

function ensureProfile(profileName, recipe, note) {
  if (existsSync(join(HOME, 'profiles', profileName, 'package.json'))) return 'exists';
  const template = recipeTemplate(recipe);
  sh('dsh', ['--profile', profileName, '--from-default-profile', template, '--dump-config']);
  return `created from "${template}"${note ? ` (${note})` : ''}`;
}

step(`profile: ${LEAD} from the ${LEAD_RECIPE} recipe`, () => ensureProfile(LEAD, LEAD_RECIPE));
step(`profile: ${WORKER} from the ${WORKER_RECIPE} recipe (one-shot workers)`, () => ensureProfile(WORKER, WORKER_RECIPE));
step(`profile: ${PROBE} from the ${PROBE_RECIPE} recipe (deterministic boot probe)`, () => ensureProfile(PROBE, PROBE_RECIPE));

/**
 * Make the profile's `dsh.profile.bundles` match its recipe.
 *
 * The shipped (non-@sdlc) bundles keep their order and precedence; every @sdlc
 * entry is replaced by the recipe's list. This is the beta.1 → beta.2 upgrade
 * path as much as a fresh install: beta.1 selected the meta-bundle *and* its
 * four members, which was harmless while the meta-bundle's patch held one row,
 * but now that the patch is the union of the members' rows it would compose
 * every row twice. The members stay in `dependencies` — that is what the row
 * names resolve from.
 */
function syncProfileBundles(profileName, recipe) {
  const path = join(HOME, 'profiles', profileName, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const wanted = recipeBundles(recipe);
  const current = manifest.dsh?.profile?.bundles ?? [];
  const shipped = current.filter((b) => !isOwnBundleName(b));
  const next = [...shipped, ...wanted];
  const removed = current.filter((b) => isOwnBundleName(b) && !wanted.includes(b));
  if (JSON.stringify(current) === JSON.stringify(next)) return 'already exact';
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: next } };
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return removed.length
    ? `dropped ${removed.join(', ')} from the bundle list`
    : `set to ${next.join(', ')}`;
}

step(`bundles: ${LEAD} selects exactly the ${LEAD_RECIPE} recipe`, () => syncProfileBundles(LEAD, LEAD_RECIPE));
step(`bundles: ${WORKER} selects exactly the ${WORKER_RECIPE} recipe`, () => syncProfileBundles(WORKER, WORKER_RECIPE));
step(`bundles: ${PROBE} selects exactly the ${PROBE_RECIPE} recipe`, () => syncProfileBundles(PROBE, PROBE_RECIPE));

// ── bundles ────────────────────────────────────────────────────────────────
// The recipe files are the single source of truth for WHAT is mounted; this
// section only decides HOW each profile gets there.
//
//   lead   — ONE bundle (`@patwoodman/dsh-sdlc-flow`), whose generated patch declares
//            the whole lead composition. Its four members are installed as
//            ordinary module dependencies (`pnpm add`) so the row names resolve
//            from the profile's node_modules. They must NOT be bundles here:
//            `dsh plugin add` would select them, and their patches would
//            compose every row a second time. The meta-bundle is published with
//            those dependencies, so a registry install needs no second step;
//            the explicit `pnpm add` is what makes a source/link install work
//            while the members are unpublished.
//   worker — guard + tools, as bundles (E6: never core, never the meta-bundle).
//   probe  — exactly the recipe's bundles: core + tools + presets + guard.
function specsFor(names) {
  return names.map((name) => `link:${pkgDir(name)}`);
}

/**
 * `dsh plugin … add` flags forwarded verbatim to the profile-local pnpm.
 *
 * pnpm 9 refuses ANY `pnpm add` whose cwd is a workspace root with
 * ERR_PNPM_ADDING_TO_ROOT unless `--ignore-workspace-root-check` is set (pnpm
 * 10+ only refuses multi-pattern workspaces, which is why a pnpm-12 machine
 * passes while CI's pinned pnpm 9.12.0 fails). DSH always creates a
 * single-pattern workspace in the profile (`packages: ['.']`), so every
 * bundle install trips the pnpm 9 guard: the profile IS its own workspace
 * root and the add is exactly what the user asked for. The flag is
 * pass-through (DSH forwards unknown args to pnpm), a no-op on pnpm 10+,
 * and documented in `dsh plugin --help` output.
 */
const ADD_FLAGS = ['--ignore-workspace-root-check'];

/**
 * A one-line summary of a tool's stdout for the step log. `dsh plugin add`
 * prints several lines (a pnpm notice, the resolved-spec warnings, a timing
 * line); slicing the tail chopped the last line mid-word, so the summary reads
 * the last non-empty line whole instead.
 */
function lastLine(text, max = 200) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.at(-1) ?? '';
  return line.length > max ? `…${line.slice(-max)}` : line;
}

step(`install: lead bundle into ${LEAD} (the single, self-contained spec)`, () => {
  const [bundle] = recipeBundles(LEAD_RECIPE);
  sh('dsh', ['plugin', '--profile', LEAD, 'add', ...ADD_FLAGS, `link:${pkgDir(bundle)}`]);
  const deps = Object.keys(JSON.parse(readFileSync(join(pkgDir(bundle), 'package.json'), 'utf8')).dependencies ?? {})
    .filter((name) => isOwnBundleName(name));
  if (deps.length === 0) return `${bundle} (self-contained — the members are folded into it)`;
  // Compat for an UNFOLDED tree (older checkout): members ride as plain
  // dependencies. The folded shape is asserted by the verify step below.
  const pnpmRes = run('pnpm', ['add', '--dir', join(HOME, 'profiles', LEAD), ...specsFor(deps)], { timeoutMs: 900_000 });
  if (!pnpmRes.ok) {
    const detail = (pnpmRes.stderr || pnpmRes.stdout || String(pnpmRes.error ?? '')).trim().slice(0, 2000);
    throw new Error(`pnpm add (member modules) exited ${pnpmRes.code}\n${detail}`);
  }
  return `${bundle} + ${deps.length} member modules (unfolded tree)`;
});
step(`install: worker bundles into ${WORKER} (guard + report tools ONLY)`, () =>
  lastLine(sh('dsh', ['plugin', '--profile', WORKER, 'add', ...ADD_FLAGS, ...specsFor(recipeBundles(WORKER_RECIPE))]).stdout),
);
step(`install: probe bundles into ${PROBE} (recipe composition incl. the guard)`, () =>
  lastLine(sh('dsh', ['plugin', '--profile', PROBE, 'add', ...ADD_FLAGS, ...specsFor(recipeBundles(PROBE_RECIPE))]).stdout),
);

// ── verification ───────────────────────────────────────────────────────────

/** The loader-accepted duplicate: the web template ships its own
 *  `agent-preset-registry` row and the presets block inserts one. */
const ALLOWED_DUPS = new Map([['agent-preset-registry', 2]]);

step('verify: lead profile selects exactly one sdlc bundle', () => {
  const manifest = JSON.parse(readFileSync(join(HOME, 'profiles', LEAD, 'package.json'), 'utf8'));
  const selected = (manifest.dsh?.profile?.bundles ?? []).filter((b) => isOwnBundleName(b));
  if (selected.length !== 1 || selected[0] !== recipeBundles(LEAD_RECIPE)[0]) {
    throw new Error(
      `expected exactly [${recipeBundles(LEAD_RECIPE)[0]}] as the lead's sdlc bundle, found [${selected.join(', ')}].\n` +
        `  Member bundles in the lead would compose every row twice — remove them:\n` +
        `    dsh plugin --profile ${LEAD} remove <member>`,
    );
  }
  return selected[0];
});
step('verify: the lead holds exactly ONE own-scope package (one-click GUI uninstall)', () => {
  const manifest = JSON.parse(readFileSync(join(HOME, 'profiles', LEAD, 'package.json'), 'utf8'));
  const [bundle] = recipeBundles(LEAD_RECIPE);
  const own = Object.keys(manifest.dependencies ?? {}).filter((n) => isOwnBundleName(n));
  if (own.length !== 1 || own[0] !== bundle) {
    throw new Error(
      `the lead profile must depend on exactly [${bundle}], found [${own.join(', ') || 'none'}].\n` +
        `  The meta-bundle is self-contained (members folded into lib/rows/) — member\n` +
        `  dependencies would leave ghost entries a GUI uninstall cannot remove.\n` +
        `  Upgrade path: re-run this installer (it drops the ghosts automatically).`,
    );
  }
  return bundle;
});
step('verify: lead profile composes the full lead without unexpected duplicate rows', () => {
  const res = sh('dsh', ['--profile', LEAD, '--dump-config']);
  const ids = [...res.stdout.matchAll(/^- id:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''));
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const dups = [...counts].filter(([id, n]) => n > (ALLOWED_DUPS.get(id) ?? 1));
  if (dups.length) throw new Error(`duplicate row ids: ${dups.map(([id, n]) => `${id}x${n}`).join(', ')}`);
  if (!counts.has('sdlc-orchestrator')) throw new Error('the meta-bundle row is absent from the composed lead');
  for (const id of ['sdlc-tasks', 'sdlc-router', 'sdlc-verifier', 'sdlc-tools', 'sdlc-ui']) {
    if (!counts.has(id)) {
      throw new Error(
        `row ${id} is absent from the composed lead — the meta-bundle's generated patch is incomplete.\n` +
          '  Regenerate it with: node scripts/gen-bundle-patch.mjs',
      );
    }
  }
  const presets = [...counts.keys()].filter((id) => /^preset-sdlc-/.test(id)).length;
  if (presets !== PUBLIC_ROLE_COUNT) {
    throw new Error(`expected ${PUBLIC_ROLE_COUNT} selectable preset-sdlc-* rows in the composed lead, found ${presets}`);
  }
  return `${counts.size} unique ids incl. ${presets} selectable preset(s) (sdlc-ui + meta-bundle present)`;
});
step('verify: M0 gate', () => {
  const res = run('node', [join(ROOT, 'scripts', 'validate-m0.mjs')], { timeoutMs: 900_000 });
  if (!res.ok) throw new Error((res.stdout + res.stderr).slice(-1500));
  return 'M0 green';
});

// ── report ─────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  mkdirSync(join(ROOT, '.validation'), { recursive: true });
  const out = join(ROOT, '.validation', 'install.json');
  writeFileSync(out, JSON.stringify({ ok: !failed, dshHome: HOME, steps }, null, 2) + '\n');
  console.log(out);
} else {
  console.log('');
  if (failed) {
    console.log('Install FAILED. Re-running this script is safe: profile creation and');
    console.log('bundle installation are both idempotent. To roll back a profile:');
    console.log(`  rm -rf ${join(HOME, 'profiles', LEAD)}`);
  } else {
    console.log('Install complete. Next:');
    console.log(`  node scripts/doctor.mjs                # environment check`);
    console.log(`  dsh --profile ${LEAD}                  # interactive lead (web GUI)`);
    console.log(`  dsh --profile ${WORKER} "<one task>"   # one-shot worker`);
  }
  console.log('');
}

process.exit(failed ? 1 : 0);
