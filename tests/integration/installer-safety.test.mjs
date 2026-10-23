/**
 * tests/integration/installer-safety.test.mjs — the shipped `dsh-sdlc-install`
 * against a fake `dsh` on PATH.
 *
 * The existing installer-flow test only exercised `--check`/`--dry-run`; the
 * real mutation path (bundle selection, dependency prune, YAML exemption,
 * `dsh plugin add`, version verification) was never executed. That is how a
 * failed add could leave a profile selecting a package that was never
 * installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ROOT, run } from '../lib/helpers.mjs';

const INSTALLER = join(ROOT, 'packages', 'sdlc-orchestrator', 'src', 'install.mjs');
const META = '@patwoodman/dsh-sdlc-flow';
const TARGET = '0.4.0-beta.24';

const FAKE_DSH = `#!/bin/sh
# Fake dsh for the installer tests. Logs every call, answers --version from
# FAKE_DSH_VERSION, and writes the requested package into the profile when the
# install succeeds.
printf '%s\\n' "$*" >> "$FAKE_DSH_LOG"
case "$1" in
  --version)
    printf '%s\\n' "\${FAKE_DSH_VERSION:-0.2.0-rc.2}"
    exit 0
    ;;
  plugin)
    if [ "\${FAKE_DSH_PLUGIN_EXIT:-0}" != "0" ]; then
      printf 'simulated plugin add failure\\n' >&2
      exit "\${FAKE_DSH_PLUGIN_EXIT}"
    fi
    profile="$3"
    spec="$6"
    version="\${spec##*@}"
    package="\${spec%@*}"
    dir="$DSH_HOME/profiles/$profile/node_modules/$package"
    mkdir -p "$dir"
    printf '{"name":"%s","version":"%s"}\\n' "$package" "$version" > "$dir/package.json"
    # Real dsh plugin add pins the dependency in the profile manifest.
    # Portability (Oct 2026): never resolve `node` via PATH here. Node 22's
    # multi-file test workers run with a PATH that omits the node binary's own
    # directory (single-file runs inherit it, so bare `node` worked locally for
    # years), and `sh` swallows the resulting `node: command not found`
    # (exit 127) because this script has no `set -e` — the add then "succeeds"
    # with the dependency unpinned. FAKE_NODE carries the absolute
    # process.execPath so the fake is hermetic; a failed pin aborts the add
    # (exit 1) instead of lying about success.
    if [ -z "${FAKE_NODE:-}" ]; then
      printf 'fake dsh: FAKE_NODE is not set (the test must pass process.execPath)\\n' >&2
      exit 1
    fi
    "$FAKE_NODE" -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.dependencies??={};d.dependencies[process.argv[2]]=process.argv[3];fs.writeFileSync(p,JSON.stringify(d,null,2)+"\\n")' \\
      "$DSH_HOME/profiles/$profile/package.json" "$package" "$version" || exit 1
    exit 0
    ;;
esac
exit 0
`;

function makeHome(t, { manifest } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sdlc-installer-safety-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, 'profiles', 'sdlc-web');
  mkdirSync(profile, { recursive: true });
  const doc = manifest ?? {
    name: 'sdlc-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  };
  const manifestPath = join(profile, 'package.json');
  writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n');

  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'dsh'), FAKE_DSH, { mode: 0o755 });
  const log = join(home, 'dsh.log');
  return { home, profile, manifestPath, bin, log };
}

function installer(fixture, args, env = {}) {
  return run(process.execPath, [INSTALLER, ...args, '--dsh-home', fixture.home, '--json'], {
    cwd: ROOT,
    timeoutMs: 60_000,
    env: {
      PATH: `${fixture.bin}:${process.env.PATH}`,
      FAKE_DSH_LOG: fixture.log,
      FAKE_NODE: process.execPath,
      ...env,
    },
  });
}

function manifestOf(fixture) {
  return JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
}

test('a failed plugin add restores the profile exactly (no uninstalled bundle selected)', (t) => {
  const fixture = makeHome(t);
  const before = readFileSync(fixture.manifestPath, 'utf8');
  const result = installer(fixture, ['--only', 'lead', '--version', TARGET], { FAKE_DSH_PLUGIN_EXIT: '1' });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /simulated plugin add failure/);
  assert.match(result.stdout + result.stderr, /profile was restored/);
  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), before, 'manifest must be byte-identical after a failed add');
  assert.deepEqual(manifestOf(fixture).dsh.profile.bundles, [], 'no bundle is selected if nothing was installed');
  assert.equal(existsSync(join(fixture.profile, 'pnpm-workspace.yaml')), false, 'the YAML exemption is rolled back too');
  assert.equal(existsSync(join(fixture.profile, 'node_modules')), false);
});

test('a successful install is verified, selects the bundle, and is idempotent', (t) => {
  const fixture = makeHome(t);
  const first = installer(fixture, ['--only', 'lead', '--version', TARGET]);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.profiles[0].changed, true);

  const manifest = manifestOf(fixture);
  assert.deepEqual(manifest.dsh.profile.bundles, [META], 'the bundle is selected only after a successful add');
  assert.equal(manifest.dependencies[META], TARGET);
  const installed = JSON.parse(readFileSync(
    join(fixture.profile, 'node_modules', ...META.split('/'), 'package.json'),
    'utf8',
  ));
  assert.equal(installed.version, TARGET);

  const second = installer(fixture, ['--only', 'lead', '--version', TARGET]);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.profiles[0].changed, false);
  assert.ok(secondReport.steps.some((step) => /already up to date/.test(step.step)), secondReport.steps.map((s) => s.step).join('\n'));

  const calls = readFileSync(fixture.log, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(calls.filter((line) => line.startsWith('plugin ')).length, 1, 'the second run does not reinstall');
});

test('a manager that reports success but installs the old version rolls back', (t) => {
  const fixture = makeHome(t);
  const before = readFileSync(fixture.manifestPath, 'utf8');
  // The fake writes the requested version; simulate a manager that did not
  // replace the package by pre-creating the old version and making the fake
  // script a no-op on this call.
  writeFileSync(join(fixture.bin, 'dsh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DSH_LOG"
case "$1" in
  --version) printf '0.2.0-rc.2\\n'; exit 0;;
  plugin) exit 0;;
esac
exit 0
`, { mode: 0o755 });
  const result = installer(fixture, ['--only', 'lead', '--version', TARGET]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, new RegExp(`expected ${META}@${TARGET.replace(/\./g, '\\.')}, found`));
  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), before);
});

test('--version accepts only an exact semver and never swallows another flag', (t) => {
  const fixture = makeHome(t);
  for (const args of [
    ['--only', 'lead', '--version', '--dry-run'],
    ['--only', 'lead', '--version', 'latest'],
    ['--only', 'lead', '--version', '^0.4.0'],
  ]) {
    const result = installer(fixture, args);
    assert.equal(result.status, 2, `${args.join(' ')} must exit 2`);
    assert.match(result.stdout + result.stderr, /--version (requires an exact semver|must be an exact semver)/);
  }
  assert.equal(existsSync(join(fixture.profile, 'pnpm-workspace.yaml')), false, 'no config was written');
});

test('--dsh-home with no value is rejected', (t) => {
  const fixture = makeHome(t);
  const result = run(process.execPath, [INSTALLER, '--only', 'lead', '--dsh-home'], {
    cwd: ROOT,
    env: { PATH: `${fixture.bin}:${process.env.PATH}`, FAKE_DSH_LOG: fixture.log },
    timeoutMs: 30_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout + result.stderr, /--dsh-home requires a directory/);
});

test('an incompatible dsh host is refused before any profile write', (t) => {
  const fixture = makeHome(t);
  const before = readFileSync(fixture.manifestPath, 'utf8');
  const result = installer(fixture, ['--only', 'lead', '--version', TARGET], { FAKE_DSH_VERSION: '0.1.9' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /requires @deepseek-ai\/dsh >=0\.2\.0-rc\.2 <0\.3\.0-0; found 0\.1\.9/);
  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), before);
});

test('importing the installer export performs no install and writes nothing', (t) => {
  const fixture = makeHome(t);
  const home = join(fixture.home, 'import-home');
  mkdirSync(home, { recursive: true });
  const result = run(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(INSTALLER)}); process.stdout.write('IMPORT_RETURNED')`,
  ], {
    cwd: ROOT,
    timeoutMs: 30_000,
    env: { DSH_HOME: home, npm_config_registry: 'http://127.0.0.1:1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'IMPORT_RETURNED');
  assert.equal(readFileSync(fixture.manifestPath, 'utf8').includes('dsh-sdlc-flow'), false, 'no profile mutation');
  assert.equal(existsSync(join(home, '.sdlc-install.lock')), false, 'no lock left behind');
});

test('the app-managed desktop profile is reported, never modified', (t) => {
  const fixture = makeHome(t);
  const desktop = join(fixture.home, 'profiles', 'desktop');
  mkdirSync(join(desktop, 'node_modules', '@patwoodman', 'dsh-sdlc-flow'), { recursive: true });
  writeFileSync(join(desktop, 'package.json'), JSON.stringify({
    dependencies: { [META]: '0.4.0-beta.20' },
    dsh: { profile: { bundles: [META] } },
  }));
  writeFileSync(join(desktop, 'node_modules', '@patwoodman', 'dsh-sdlc-flow', 'package.json'), JSON.stringify({ name: META, version: '0.4.0-beta.20' }));
  const before = readFileSync(join(desktop, 'package.json'), 'utf8');
  const result = installer(fixture, ['--check', '--only', 'lead', '--version', TARGET]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const entry = report.profiles.find((p) => p.profile === 'desktop');
  assert.ok(entry, 'desktop is reported');
  assert.equal(entry.managed, false);
  assert.match(entry.reason, /app owns the desktop profile/);
  assert.equal(readFileSync(join(desktop, 'package.json'), 'utf8'), before, 'desktop manifest is untouched');
});

test('a corrupt profile manifest is diagnosed, never rewritten', (t) => {
  const fixture = makeHome(t);
  writeFileSync(fixture.manifestPath, '{"dependencies":');
  const before = readFileSync(fixture.manifestPath, 'utf8');
  const result = installer(fixture, ['--check', '--only', 'lead', '--version', TARGET]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /package\.json is not valid JSON/);
  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), before);
});
