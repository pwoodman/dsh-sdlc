/**
 * tests/contract/release-workflow.test.mjs — the release path must fail closed
 * before npm, and publish in dependency order.
 *
 * The publish loop skips versions that already exist; a version-not-published
 * guard and a tag condition are the two things that keep a manual or re-tagged
 * run from reporting success with zero publishes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../lib/helpers.mjs';

const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

function packages() {
  const out = new Map();
  for (const dir of ['sdlc-guard', 'sdlc-core', 'sdlc-cli', 'sdlc-tools', 'sdlc-presets', 'sdlc-client-ui', 'sdlc-orchestrator']) {
    const path = join(ROOT, 'packages', dir, 'package.json');
    if (existsSync(path)) out.set(dir, JSON.parse(readFileSync(path, 'utf8')));
  }
  return out;
}

test('the release runs the version guard before building or publishing', () => {
  assert.match(workflow, /node scripts\/verify-release\.mjs/);
  assert.ok(workflow.indexOf('verify-release.mjs') < workflow.indexOf('publish to npm'), 'guard runs before publish');
});

test('publishing requires a version tag (a workflow_dispatch on main cannot publish)', () => {
  const step = workflow.slice(workflow.indexOf('- name: publish to npm'), workflow.indexOf('- name: post-publish registry install smoke'));
  assert.match(step, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test('members publish after their dependencies, meta last', () => {
  const match = /for dir in ([a-z0-9 -]+); do/.exec(workflow);
  assert.ok(match, 'publish loop found');
  const order = match[1].trim().split(/\s+/);
  assert.equal(order.at(-1), 'sdlc-orchestrator', 'the meta-bundle publishes last');

  const all = packages();
  const dirOf = new Map([...all].map(([dir, pkg]) => [pkg.name, dir]));
  for (const dir of order) {
    const pkg = all.get(dir);
    assert.ok(pkg, `publish loop names a real package: ${dir}`);
    for (const [dependency] of Object.entries(pkg.dependencies ?? {})) {
      const depDir = dirOf.get(dependency);
      if (!depDir) continue;
      const depIndex = order.indexOf(depDir);
      assert.ok(depIndex >= 0, `${pkg.name} depends on ${dependency}, which is not in the publish loop`);
      assert.ok(depIndex < order.indexOf(dir), `${dependency} must publish before ${pkg.name}`);
    }
  }
});

test('a post-publish registry install smoke exists (the only path that resolves members from npm)', () => {
  assert.match(workflow, /post-publish registry install smoke/);
  const step = workflow.slice(workflow.indexOf('post-publish registry install smoke'));
  assert.match(step, /dsh-sdlc-install --only all/);
  assert.match(step, /dsh-sdlc-install --check/);
  assert.match(step, /--uninstall --only all/);
});
