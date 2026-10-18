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
 *   4. install with `dsh plugin add <name>@<exact>`;
 *   5. re-add the bundle to `dsh.profile.bundles` (a failed uninstall can
 *      leave a package installed but disabled) and verify the installed
 *      package.json version.
 *
 * Run it without cloning:
 *
 *   npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install
 *   npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --only all
 *
 * Flags: --only lead|worker|probe|all (default lead), --tag latest|beta,
 *        --version <exact>, --dsh-home <dir>, --dry-run, --json, --help.
 *
 * Node built-ins only: this file is shipped in the published package and must
 * run before any dependency is installed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PACKAGE, BUNDLES } from './index.js';
import { normalizeReleaseAgeExcludes } from './install-lib.mjs';

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
const DSH_HOME = flag('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh'));
const DRY_RUN = has('--dry-run');
const JSON_OUT = has('--json');

if (has('--help') || has('-h')) {
  process.stdout.write(`Usage: dsh-sdlc-install [options]

Install the latest published DSH SDLC Flow bundle into a DSH profile.

  --only lead|worker|probe|all  which profile(s) to install (default: lead)
  --tag latest|beta             registry dist-tag to resolve (default: latest)
  --version <exact>             pin an exact version instead of a tag
  --dsh-home <dir>              DSH home (default: $DSH_HOME or ~/.dsh)
  --dry-run                     print the commands without changing anything
  --json                        machine-readable result
  -h, --help                    this help

Examples:
  npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install
  npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --only all
  npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --version 0.4.0-beta.21
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
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
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
  writeFileSync(file, next);
  record('pinned pnpm release-age exemptions', specs.join(', '));
}

/** Ensure the bundle is selected even if an earlier failed uninstall removed it. */
function ensureBundles(name, bundles) {
  const file = join(profileDir(name), 'package.json');
  if (DRY_RUN) {
    record(`would select bundles ${bundles.join(', ')}`);
    return;
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  const current = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  const missing = bundles.filter((bundle) => !current.includes(bundle));
  if (missing.length === 0) {
    record(`profile ${name} already selects ${bundles.length} bundle(s)`);
    return;
  }
  manifest.dsh.profile.bundles = [...current, ...missing];
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  record(`selected bundle(s) in ${name}`, missing.join(', '));
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

const PLANS = {
  lead: { profile: 'sdlc-web', template: 'web', packages: [META], bundles: [META] },
  worker: { profile: 'sdlc-worker', template: 'headless', packages: [GUARD, TOOLS], bundles: [GUARD, TOOLS] },
  probe: { profile: 'sdlc-probe', template: 'sdk', packages: [CORE, TOOLS, PRESETS, GUARD], bundles: [CORE, TOOLS, PRESETS, GUARD] },
};

function planFor(only) {
  return only === 'all' ? ['lead', 'worker', 'probe'] : [only];
}

async function main() {
  if (!JSON_OUT) {
    process.stdout.write(`\nDSH SDLC Flow — registry install${DRY_RUN ? ' (dry run)' : ''}\n`);
    process.stdout.write('================================================\n\n');
    process.stdout.write(`  DSH_HOME : ${DSH_HOME}\n`);
  }

  const { version, source } = await resolveVersion();
  record(`resolved ${META}@${version}`, `from ${source}`);

  const dsh = DRY_RUN ? { status: 0, stdout: '' } : run('dsh', ['--version']);
  if (!DRY_RUN && dsh.status !== 0) {
    throw new Error('dsh is not on PATH. Install it first: npm install -g @deepseek-ai/dsh@0.2.1-alpha.2 (or any 0.2.x).');
  }
  record('dsh CLI available', DRY_RUN ? '(dry run)' : dsh.stdout.trim());

  for (const only of planFor(ONLY)) {
    const plan = PLANS[only];
    if (!plan || plan.packages.some((pkg) => pkg === undefined)) {
      throw new Error(`cannot derive the ${only} package list from ${META}'s BUNDLES export`);
    }
    ensureProfile(plan.profile, plan.template);
    ensureReleaseAgeExcludes(plan.profile, plan.packages.map((pkg) => `${pkg}@${version}`));
    mustRun(
      'dsh',
      ['plugin', '--profile', plan.profile, 'add', '--ignore-workspace-root-check', ...plan.packages.map((pkg) => `${pkg}@${version}`)],
      `install into ${plan.profile}`,
    );
    record(`installed ${plan.packages.map((pkg) => `${pkg}@${version}`).join(', ')}`, plan.profile);
    ensureBundles(plan.profile, plan.bundles);
    if (!DRY_RUN) {
      for (const pkg of plan.packages) {
        const actual = installedVersion(plan.profile, pkg);
        if (actual !== version) {
          throw new Error(`${plan.profile}: expected ${pkg}@${version}, found ${pkg}@${actual ?? '<missing>'}`);
        }
      }
      record(`verified ${plan.profile}`, plan.packages.map((pkg) => `${pkg}@${version}`).join(', '));
    }
  }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ version, tag: EXACT === null ? TAG : null, only: ONLY, dshHome: DSH_HOME, steps }, null, 2)}\n`);
  } else {
    process.stdout.write('\nDone. Restart DeepSeek Harness (or any running lead) so the new bundle is loaded:\n');
    process.stdout.write('  dsh --profile sdlc-web\n\n');
    if (ONLY === 'lead' || ONLY === 'all') {
      process.stdout.write('A new session will use the sdlc-lead preset. If you still see an "agent-preset/invalid"\n');
      process.stdout.write('error, the app is still running the old bundle — quit it completely and reopen.\n');
    }
  }
}

main().catch((error) => {
  if (JSON_OUT) process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  else process.stderr.write(`\ndsh-sdlc-install: ${error.message}\n`);
  process.exit(1);
});
