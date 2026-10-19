/**
 * tests/integration/installer-flow.test.mjs — the registry installer's local
 * decisions: check, upgrade cleanup, and uninstall dry-run.
 *
 * No registry, pnpm or dsh invocation is needed: --version pins the target and
 * --dry-run records package-manager commands without running them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const INSTALLER = join(ROOT, 'packages', 'sdlc-orchestrator', 'src', 'install.mjs');
const META = '@patwoodman/dsh-sdlc-flow';
const CORE = '@patwoodman/dsh-sdlc-flow-core';

function makeHome(t, version = '0.4.0-beta.20', { legacy = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sdlc-installer-flow-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, 'profiles', 'sdlc-web');
  mkdirSync(join(profile, 'node_modules', '@patwoodman', 'dsh-sdlc-flow'), { recursive: true });
  const dependencies = { [META]: version };
  const bundles = ['@deepseek-ai/dsh-base', META];
  if (legacy) {
    dependencies[CORE] = version;
    bundles.push(CORE);
  }
  const manifest = {
    dependencies,
    dsh: { profile: { bundles } },
  };
  const manifestPath = join(profile, 'package.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(profile, 'node_modules', '@patwoodman', 'dsh-sdlc-flow', 'package.json'), JSON.stringify({
    name: META,
    version,
  }));
  return { home, profile, manifestPath, before: readFileSync(manifestPath, 'utf8') };
}

function installer(home, args) {
  const result = spawnSync(process.execPath, [INSTALLER, ...args, '--dsh-home', home, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('--check reports an available update and changes nothing', (t) => {
  const fixture = makeHome(t);
  const report = installer(fixture.home, ['--check', '--only', 'lead', '--version', '0.4.0-beta.23']);
  assert.equal(report.mode, 'check');
  assert.equal(report.profiles[0].profile, 'sdlc-web');
  assert.equal(report.profiles[0].installed[META], '0.4.0-beta.20');
  assert.equal(report.profiles[0].updateAvailable, true);
  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), fixture.before, 'check must not write the profile');
});

test('--check says up to date when the installed version is the target', (t) => {
  const fixture = makeHome(t, '0.4.0-beta.23', { legacy: false });
  const report = installer(fixture.home, ['--check', '--only', 'lead', '--version', '0.4.0-beta.23']);
  assert.equal(report.profiles[0].updateAvailable, false);
  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), fixture.before);
});

test('install --dry-run prunes legacy members and stale bundles without writing', (t) => {
  const fixture = makeHome(t);
  const report = installer(fixture.home, ['--only', 'lead', '--version', '0.4.0-beta.23', '--dry-run']);
  assert.equal(report.mode, 'install');
  assert.equal(report.profiles[0].changed, true);
  const steps = report.steps.map((step) => step.step);
  assert.ok(steps.some((step) => /drop legacy suite dependencies/.test(step)), steps.join('\n'));
  assert.ok(steps.some((step) => /add .*@patwoodman\/dsh-sdlc-flow@0\.4\.0-beta\.23/.test(step)), steps.join('\n'));
  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), fixture.before, 'dry run must not write the profile');
});

test('--uninstall --dry-run deselects the suite and records the remove command', (t) => {
  const fixture = makeHome(t);
  const report = installer(fixture.home, ['--uninstall', '--only', 'lead', '--dry-run']);
  assert.equal(report.mode, 'uninstall');
  assert.deepEqual(report.profiles[0].removed, [META]);
  const steps = report.steps.map((step) => step.step);
  assert.ok(steps.some((step) => /set bundles in sdlc-web/.test(step)), steps.join('\n'));
  assert.ok(steps.some((step) => /dsh plugin --profile sdlc-web remove @patwoodman\/dsh-sdlc-flow/.test(step)), steps.join('\n'));
  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), fixture.before, 'dry run must not write the profile');
});
