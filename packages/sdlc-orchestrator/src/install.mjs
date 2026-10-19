#!/usr/bin/env node
/**
 * packages/sdlc-orchestrator/src/install.mjs — registry installer/updater.
 *
 * The Desktop Add-plugin field and `dsh plugin add` both go through pnpm, and
 * pnpm 11 applies a 24-hour `minimumReleaseAge` to `latest`/range requests. A
 * beta published minutes ago therefore resolves to the PREVIOUS beta — exactly
 * how beta.19 (broken presets) kept installing while beta.20 was already
 * `latest`. This command is the reliable path:
 *
 *   1. resolve `latest` (or `beta`) from the npm registry itself;
 *   2. pin the EXACT version in the profile and add the matching
 *      `minimumReleaseAgeExclude` entry (pnpm's documented escape hatch);
 *   3. create the profile from its shipped template when it is missing;
 *   4. prune member/pre-rename packages and stale suite bundle entries;
 *   5. install with `dsh plugin add <name>@<exact>` (skipped when the profile
 *      is already at the target and no manifest cleanup was needed);
 *   6. re-select the bundle (a failed uninstall can leave a package installed
 *      but disabled) and verify the installed package.json version.
 *
 * `--check` performs steps 1 and the installed-version read only.
 * `--uninstall` reverses step 5 for the selected profiles.
 *
 * Run it without cloning:
 *
 *   npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install
 *   npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --only all
 *   npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --check --json
 *   npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --uninstall --only all
 *
 * Flags: --only lead|worker|probe|all (default lead), --tag latest|beta,
 *        --version <exact>, --uninstall/--remove, --check, --force,
 *        --dsh-home <dir>, --dry-run, --json, --help.
 *
 * Node built-ins only: this file is shipped in the published package and must
 * run before any dependency is installed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE, BUNDLES } from './index.js';
import {
  normalizeReleaseAgeExcludes,
  compareVersions,
  pruneSuiteDependencies,
  syncSuiteBundles,
  acquireInstallLock,
  resolveDshSpawn,
  writeFileAtomic,
} from './install-lib.mjs';

const INVOKED_DIRECTLY = (() => {
  try {
    const entry = process.argv[1];
    return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

const REGISTRY = process.env.npm_config_registry || 'https://registry.npmjs.org';
const META = PACKAGE;
const CORE = BUNDLES.find((name) => name.endsWith('-core'));
const TOOLS = BUNDLES.find((name) => name.endsWith('-tools'));
const PRESETS = BUNDLES.find((name) => name.endsWith('-presets'));
const UI = BUNDLES.find((name) => name.endsWith('-ui'));
const GUARD = BUNDLES.find((name) => name.endsWith('-guard')) ?? `${META}-guard`;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const flag = (name, fallback) => (has(name) ? argv[argv.indexOf(name) + 1] : fallback);

const ONLY = flag('--only', 'lead');
const TAG = flag('--tag', 'latest');
const EXACT = flag('--version', null);
const DSH_HOME_ARG = flag('--dsh-home', null);
const DSH_HOME = DSH_HOME_ARG ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const DRY_RUN = has('--dry-run');
const JSON_OUT = has('--json');
const UNINSTALL = has('--uninstall') || has('--remove');
const CHECK = has('--check');
const FORCE = has('--force');

function validateArguments() {
if (has('--help') || has('-h')) {
  process.stdout.write(`Usage: dsh-sdlc-install [options]

Install, update, check, or uninstall the published DSH SDLC Flow bundle.

  --only lead|worker|probe|all  which profile(s) to manage (default: lead)
  --tag latest|beta             registry dist-tag to resolve (default: latest)
  --version <exact>             pin an exact version instead of a tag
  --uninstall, --remove         remove the suite's packages and bundle selections
  --check                       report installed vs published; change nothing
  --force                       reinstall the same version, or allow a downgrade
  --dsh-home <dir>              DSH home (default: $DSH_HOME or ~/.dsh)
  --dry-run                     print the commands without changing anything
  --json                        machine-readable result
  -h, --help                    this help

Running the install command again is the upgrade path: it resolves the newest
version, prunes legacy member packages, and replaces the installed meta-bundle.
A newer registry version is also installed automatically on the next lead start
(SDLC_AUTO_UPDATE=off disables that; SDLC_AUTO_UPDATE=check only reports).

Examples:
  npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install
  npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --only all
  npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --version 0.4.0-beta.21
  npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --uninstall --only all
  npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --check --json
`);
  process.exit(0);
}

const VALID_ONLY = new Set(['lead', 'worker', 'probe', 'all']);
if (!VALID_ONLY.has(ONLY)) {
  process.stderr.write(`dsh-sdlc-install: --only must be one of ${[...VALID_ONLY].join(', ')}\n`);
  process.exit(2);
}
if (!['latest', 'beta'].includes(TAG) && EXACT === null) {
  process.stderr.write('dsh-sdlc-install: --tag must be latest or beta\n');
  process.exit(2);
}
if (has('--version')) {
  // `flag()` returns the next argv token even when that token is another flag;
  // `--version --dry-run` used to pin the literal string "--dry-run" and pass
  // `pkg@--dry-run` to pnpm. Require an exact semver, never a tag.
  if (EXACT === null || EXACT === undefined || EXACT === '' || EXACT.startsWith('-')) {
    process.stderr.write('dsh-sdlc-install: --version requires an exact semver (for example 0.4.0-beta.24)\n');
    process.exit(2);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(EXACT)) {
    process.stderr.write(`dsh-sdlc-install: --version must be an exact semver, got "${EXACT}" (use --tag latest|beta for a tag)\n`);
    process.exit(2);
  }
}
if (has('--dsh-home') && (DSH_HOME_ARG === null || DSH_HOME_ARG === undefined || DSH_HOME_ARG === '' || DSH_HOME_ARG.startsWith('-'))) {
  process.stderr.write('dsh-sdlc-install: --dsh-home requires a directory\n');
  process.exit(2);
}
if (UNINSTALL && CHECK) {
  process.stderr.write('dsh-sdlc-install: --uninstall and --check are mutually exclusive\n');
  process.exit(2);
}

}

const steps = [];
function record(step, detail = '') {
  steps.push({ step, detail });
  if (!JSON_OUT) process.stdout.write(`  [ok]      ${step}${detail ? ` — ${detail}` : ''}\n`);
}
function warn(message) {
  steps.push({ step: message, warning: true });
  if (!JSON_OUT) process.stdout.write(`  [warn]    ${message}\n`);
}

function run(command, args, { cwd, timeoutMs = 900_000 } = {}) {
  if (DRY_RUN) {
    record(`exec ${command} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const spawn = command === 'dsh'
    ? resolveDshSpawn(args)
    : { command, args, shell: false };
  const result = spawnSync(spawn.command, spawn.args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: spawn.shell,
    env: { ...process.env, DSH_HOME },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function mustRun(command, args, context) {
  const result = run(command, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-1_500);
    throw new Error(`${context}: \`${command} ${args.join(' ')}\` exited ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

async function resolveVersion() {
  if (EXACT !== null) return { version: EXACT, source: '--version' };
  const url = `${REGISTRY.replace(/\/+$/, '')}/${META.replace('/', '%2F')}`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new Error(`cannot reach the npm registry at ${REGISTRY}: ${error.message}\nPin a version with --version <exact> or check your network.`);
  }
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status} for ${META}`);
  const packument = await response.json();
  const version = packument?.['dist-tags']?.[TAG];
  if (typeof version !== 'string') {
    throw new Error(`registry has no ${TAG} dist-tag for ${META} (tags: ${Object.keys(packument?.['dist-tags'] ?? {}).join(', ')})`);
  }
  return { version, source: TAG };
}

const profileDir = (name) => join(DSH_HOME, 'profiles', name);

/** Create a profile from its shipped template when absent. */
function ensureProfile(name, template) {
  const dir = profileDir(name);
  if (existsSync(join(dir, 'package.json'))) {
    record(`profile ${name} already exists`);
    return;
  }
  mustRun('dsh', ['--profile', name, '--from-default-profile', template, '--dump-config'], `create profile ${name}`);
  record(`created profile ${name} from the ${template} template`);
}

/**
 * Add exact-version `minimumReleaseAgeExclude` entries, normalizing the
 * malformed `pkg@a || pkg@b` form (pnpm does not understand it) into separate
 * list items. This is the difference between installing the fresh beta and
 * silently resolving the previous one.
 */
function ensureReleaseAgeExcludes(name, specs) {
  const file = join(profileDir(name), 'pnpm-workspace.yaml');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : 'packages:\n  - .\n';
  const next = normalizeReleaseAgeExcludes(text, specs);
  if (DRY_RUN) {
    record(`would set minimumReleaseAgeExclude (${specs.join(', ')})`);
    return;
  }
  writeFileAtomic(file, next);
  record('pinned pnpm release-age exemptions', specs.join(', '));
}

function readProfilePackage(name) {
  const file = join(profileDir(name), 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${name}: package.json is not valid JSON (${error instanceof Error ? error.message : String(error)}). `
      + 'Refusing to rewrite it; repair or delete the profile directory first.',
    );
  }
}

function writeProfilePackage(name, manifest) {
  writeFileAtomic(join(profileDir(name), 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Snapshot the two profile files the installer mutates, so a failed install
 * cannot leave the profile selecting a package that was never installed.
 *
 * @returns {Record<string, Buffer|null>}
 */
function snapshotProfile(name) {
  const snapshot = {};
  for (const file of ['package.json', 'pnpm-workspace.yaml']) {
    const path = join(profileDir(name), file);
    snapshot[file] = existsSync(path) ? readFileSync(path) : null;
  }
  return snapshot;
}

/** Restore a snapshot; a file that did not exist is removed again. */
function restoreProfile(name, snapshot) {
  for (const [file, content] of Object.entries(snapshot)) {
    const path = join(profileDir(name), file);
    if (content === null) rmSync(path, { force: true });
    else writeFileAtomic(path, content);
  }
}

/**
 * Make the profile select exactly the recipe's suite bundles. The shipped
 * (non-suite) bundles keep their order; stale own entries are dropped. This is
 * the beta.1 → beta.2 and per-release upgrade path.
 *
 * @returns {boolean} whether the manifest changed
 */
function syncBundles(name, bundles) {
  const manifest = readProfilePackage(name);
  if (manifest === null) return false;
  const current = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const { bundles: next, removed } = syncSuiteBundles(current, bundles, {
    metaName: META,
    memberNames: BUNDLES,
  });
  if (JSON.stringify(current) === JSON.stringify(next)) {
    record(`profile ${name} already selects the expected bundle(s)`);
    return false;
  }
  if (DRY_RUN) {
    record(`would set bundles in ${name}`, next.join(', ') || '(no suite bundles)');
    return true;
  }
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles = next;
  writeProfilePackage(name, manifest);
  record(`selected bundle(s) in ${name}`, next.join(', ') || '(no suite bundles)');
  if (removed.length) record('dropped stale suite bundle selection(s)', removed.join(', '));
  return true;
}

/**
 * Drop legacy member packages (and the pre-rename `orchestrator` family) from
 * the profile manifest. The lead's meta-bundle is self-contained; keeping the
 * members makes a GUI uninstall leave ghosts. Worker/probe profiles keep the
 * members they actually mount.
 *
 * @returns {string[]} removed package names
 */
function pruneDependencies(name, keep) {
  const manifest = readProfilePackage(name);
  if (manifest === null) return [];
  const current = manifest.dependencies ?? {};
  const { dependencies, removed } = pruneSuiteDependencies(current, {
    metaName: META,
    memberNames: BUNDLES,
    keep,
  });
  if (removed.length === 0) return [];
  if (DRY_RUN) {
    record(`would drop legacy suite dependencies from ${name}`, removed.join(', '));
    return removed;
  }
  manifest.dependencies = dependencies;
  writeProfilePackage(name, manifest);
  record(`dropped legacy suite dependencies from ${name}`, removed.join(', '));
  return removed;
}

function installedVersion(name, pkgName) {
  const manifest = join(profileDir(name), 'node_modules', ...pkgName.split('/'), 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return null;
  }
}

function installedVersions(name, packages) {
  return Object.fromEntries(packages.map((pkg) => [pkg, installedVersion(name, pkg)]));
}

/**
 * Decide whether the packages need a package-manager run.
 * @returns {{action:'skip'|'install'|'refuse', installed:Record<string,string|null>, newer?:string[]}}
 */
function installAction(profile, packages, version) {
  const installed = installedVersions(profile, packages);
  const allAtTarget = packages.every((pkg) => installed[pkg] === version);
  if (allAtTarget) return FORCE ? { action: 'install', installed } : { action: 'skip', installed };
  const newer = [];
  for (const pkg of packages) {
    const current = installed[pkg];
    if (!current) continue;
    try {
      if (compareVersions(current, version) > 0) newer.push(`${pkg}@${current}`);
    } catch {
      // A non-semver installed version (for example a workspace link) is
      // treated as replaceable rather than as a downgrade.
    }
  }
  if (newer.length > 0 && !FORCE) return { action: 'refuse', installed, newer };
  return { action: 'install', installed };
}

const PLANS = {
  lead: { profile: 'sdlc-web', template: 'web', packages: [META], bundles: [META] },
  worker: { profile: 'sdlc-worker', template: 'headless', packages: [GUARD, TOOLS], bundles: [GUARD, TOOLS] },
  probe: { profile: 'sdlc-probe', template: 'sdk', packages: [CORE, TOOLS, PRESETS, GUARD], bundles: [CORE, TOOLS, PRESETS, GUARD] },
};

function planFor(only) {
  return only === 'all' ? ['lead', 'worker', 'probe'] : [only];
}

/** Remove a profile's suite selection and installed packages. */
function uninstallProfile(plan) {
  const manifest = readProfilePackage(plan.profile);
  if (manifest === null) {
    record(`profile ${plan.profile} does not exist — nothing to uninstall`);
    return { profile: plan.profile, removed: [] };
  }
  syncBundles(plan.profile, []);
  const { removed: suiteDeps } = pruneSuiteDependencies(manifest.dependencies ?? {}, {
    metaName: META,
    memberNames: BUNDLES,
    keep: [],
  });
  const candidates = [...new Set([...plan.packages, ...suiteDeps])];
  const present = candidates.filter((pkg) => installedVersion(plan.profile, pkg) !== null);
  if (present.length > 0) {
    mustRun(
      'dsh',
      ['plugin', '--profile', plan.profile, 'remove', ...present],
      `uninstall from ${plan.profile}`,
    );
  }
  pruneDependencies(plan.profile, []);
  record(
    `uninstalled from ${plan.profile}`,
    present.length > 0 ? present.join(', ') : 'no installed suite packages (manifest cleaned)',
  );
  if (!DRY_RUN) {
    for (const pkg of candidates) {
      const actual = installedVersion(plan.profile, pkg);
      if (actual !== null) {
        warn(`${plan.profile}: ${pkg}@${actual} is still installed — close the app and re-run --uninstall`);
      }
    }
  }
  return { profile: plan.profile, removed: present };
}

async function main() {
  const mode = UNINSTALL ? 'uninstall' : CHECK ? 'check' : 'install';
  if (!JSON_OUT) {
    process.stdout.write(`\nDSH SDLC Flow — registry ${mode}${DRY_RUN ? ' (dry run)' : ''}\n`);
    process.stdout.write('================================================\n\n');
    process.stdout.write(`  DSH_HOME : ${DSH_HOME}\n`);
  }

  let version = null;
  if (!UNINSTALL) {
    const resolved = await resolveVersion();
    version = resolved.version;
    record(`resolved ${META}@${version}`, `from ${resolved.source}`);
  }

  if (!CHECK) {
    const dsh = DRY_RUN ? { status: 0, stdout: '' } : run('dsh', ['--version']);
    if (!DRY_RUN && dsh.status !== 0) {
      throw new Error('dsh is not on PATH. Install it first: npm install -g @deepseek-ai/dsh@0.2.0-rc.2 (or any 0.2.x).');
    }
    if (!DRY_RUN) {
      const observed = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(dsh.stdout);
      const found = observed?.[1] ?? null;
      if (found === null) {
        throw new Error(`dsh --version did not report a semver (got "${dsh.stdout.trim()}"); refusing to install against an unknown host`);
      }
      if (compareVersions(found, '0.2.0-rc.2') < 0 || compareVersions(found, '0.3.0') >= 0) {
        throw new Error(`this suite requires @deepseek-ai/dsh >=0.2.0-rc.2 <0.3.0-0; found ${found}`);
      }
    }
    record('dsh CLI available', DRY_RUN ? '(dry run)' : dsh.stdout.trim());
  }

  const profiles = [];
  // Desktop owns its `desktop` profile; the app, not this CLI, manages it.
  // Report it honestly instead of silently pretending it does not exist.
  const desktopManifest = readProfilePackage('desktop');
  if (desktopManifest !== null) {
    const installed = installedVersions('desktop', [META]);
    profiles.push({
      profile: 'desktop',
      managed: false,
      reason: 'the DeepSeek Harness app owns the desktop profile; install through Plugins → Add plugin',
      installed,
      updateAvailable: Boolean(version) && installed[META] !== version,
    });
    if (!CHECK) warn('desktop profile is app-managed; this installer does not modify it');
  }

  for (const only of planFor(ONLY)) {
    const plan = PLANS[only];
    if (!plan || plan.packages.some((pkg) => pkg === undefined)) {
      throw new Error(`cannot derive the ${only} package list from ${META}'s BUNDLES export`);
    }

    if (UNINSTALL) {
      profiles.push(uninstallProfile(plan));
      continue;
    }

    if (CHECK) {
      const manifest = readProfilePackage(plan.profile);
      if (manifest === null) {
        record(`profile ${plan.profile} is not installed`);
        profiles.push({ profile: plan.profile, installed: {}, updateAvailable: true, reason: 'missing-profile' });
        continue;
      }
      const installed = installedVersions(plan.profile, plan.packages);
      const { removed: legacyPackages } = pruneSuiteDependencies(manifest.dependencies ?? {}, {
        metaName: META,
        memberNames: BUNDLES,
        keep: plan.packages,
      });
      const currentBundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
      const { removed: staleBundles } = syncSuiteBundles(currentBundles, plan.bundles, {
        metaName: META,
        memberNames: BUNDLES,
      });
      const versionMismatch = plan.packages.some((pkg) => installed[pkg] !== version);
      const updateAvailable = versionMismatch || legacyPackages.length > 0 || staleBundles.length > 0;
      record(
        `${plan.profile}: ${updateAvailable ? 'update/cleanup available' : 'up to date'}`,
        [
          plan.packages.map((pkg) => `${pkg}@${installed[pkg] ?? '<missing>'} → ${version}`).join(', '),
          legacyPackages.length > 0 ? `legacy: ${legacyPackages.join(', ')}` : null,
          staleBundles.length > 0 ? `stale bundles: ${staleBundles.join(', ')}` : null,
        ].filter(Boolean).join('; '),
      );
      profiles.push({
        profile: plan.profile,
        installed,
        updateAvailable,
        ...(legacyPackages.length > 0 ? { legacyPackages } : {}),
        ...(staleBundles.length > 0 ? { staleBundles } : {}),
      });
      continue;
    }

    ensureProfile(plan.profile, plan.template);
    // The bundle selection, dependency prune, YAML exemption and package-manager
    // run are one transaction. A failed `dsh plugin add` used to leave the
    // profile selecting a package that was never installed, so the next boot
    // could not mount the bundle. Snapshot and restore on any throw.
    const snapshot = snapshotProfile(plan.profile);
    try {
      const bundlesChanged = syncBundles(plan.profile, plan.bundles);
      const pruned = pruneDependencies(plan.profile, plan.packages);
      const action = installAction(plan.profile, plan.packages, version);
      if (action.action === 'refuse') {
        throw new Error(
          `${plan.profile}: installed version is newer than ${version} for ${action.newer.join(', ')}; refusing to downgrade without --force`,
        );
      }
      if (action.action === 'skip' && !bundlesChanged && pruned.length === 0) {
        record(`${plan.profile} is already up to date`, plan.packages.map((pkg) => `${pkg}@${version}`).join(', '));
        profiles.push({ profile: plan.profile, version, installed: action.installed, changed: false });
        continue;
      }

      ensureReleaseAgeExcludes(plan.profile, plan.packages.map((pkg) => `${pkg}@${version}`));
      mustRun(
        'dsh',
        ['plugin', '--profile', plan.profile, 'add', '--ignore-workspace-root-check', ...plan.packages.map((pkg) => `${pkg}@${version}`)],
        `install into ${plan.profile}`,
      );
      record(`installed ${plan.packages.map((pkg) => `${pkg}@${version}`).join(', ')}`, plan.profile);
      syncBundles(plan.profile, plan.bundles);
      pruneDependencies(plan.profile, plan.packages);
      if (!DRY_RUN) {
        for (const pkg of plan.packages) {
          const actual = installedVersion(plan.profile, pkg);
          if (actual !== version) {
            throw new Error(`${plan.profile}: expected ${pkg}@${version}, found ${pkg}@${actual ?? '<missing>'}`);
          }
        }
        record(`verified ${plan.profile}`, plan.packages.map((pkg) => `${pkg}@${version}`).join(', '));
      }
      profiles.push({ profile: plan.profile, version, installed: action.installed, changed: true });
    } catch (error) {
      restoreProfile(plan.profile, snapshot);
      throw new Error(
        `${plan.profile}: ${error instanceof Error ? error.message : String(error)}\n`
        + `The profile was restored to its previous state (${Object.keys(snapshot).join(', ')}).`,
      );
    }
  }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode,
      version,
      tag: !UNINSTALL && EXACT === null ? TAG : null,
      only: ONLY,
      dshHome: DSH_HOME,
      profiles,
      steps,
    }, null, 2)}\n`);
    return;
  }

  if (UNINSTALL) {
    process.stdout.write('\nUninstall complete. Restart DeepSeek Harness (or any running lead) so the bundle unloads.\n');
    process.stdout.write('Profile directories remain; delete them only if you also want to discard their config.\n');
    return;
  }
  if (CHECK) {
    process.stdout.write('\nCheck complete: no files were changed.\n');
    return;
  }
  process.stdout.write('\nDone. Restart DeepSeek Harness (or any running lead) so the new bundle is loaded:\n');
  process.stdout.write('  dsh --profile sdlc-web\n\n');
  if (ONLY === 'lead' || ONLY === 'all') {
    process.stdout.write('A new session will use the sdlc-lead preset. If you still see an "agent-preset/invalid"\n');
    process.stdout.write('error, the app is still running the old bundle — quit it completely and reopen.\n');
  }
}

if (INVOKED_DIRECTLY) {
  validateArguments();
  let releaseLock = null;
  try {
    if (!CHECK && !DRY_RUN) {
      releaseLock = acquireInstallLock(join(DSH_HOME, '.sdlc-install.lock'));
    }
    await main();
  } catch (error) {
    if (JSON_OUT) process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    else process.stderr.write(`\ndsh-sdlc-install: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    try { releaseLock?.(); } catch { /* best effort */ }
  }
}
