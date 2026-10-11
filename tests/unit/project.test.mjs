/**
 * tests/unit/project.test.mjs — project setup (spec v3 F.4, F.5, F.6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { core, tempDir, cleanup, makeRepo, git } from '../lib/helpers.mjs';

const project = await core.project();

test('initProject creates the F.6 tree, DB, integration branch, gitignore and config', () => {
  const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'x', devDependencies: {} }), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  try {
    const result = project.initProject({ projectRoot: repo });
    assert.equal(result.ok, true);
    assert.equal(result.stack, 'pnpm');
    assert.equal(result.integration.created, true);

    for (const dir of ['.sdlc', '.sdlc/backup', '.sdlc/config', '.sdlc/tiers', '.sdlc/worktrees', '.sdlc/recovery', '.sdlc/verification']) {
      assert.ok(existsSync(join(repo, dir)), `missing ${dir}`);
    }
    assert.ok(existsSync(join(repo, '.sdlc', 'sdlc.db')));
    assert.equal(git(['branch', '--list', 'sdlc/integration'], repo), 'sdlc/integration');

    const ignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    for (const entry of project.GITIGNORE_ENTRIES) assert.ok(ignore.includes(entry), `gitignore missing ${entry}`);

    const config = readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8');
    assert.match(config, /detection: auto/);
    assert.match(config, /pnpm/);
  } finally { cleanup(repo); }
});

test('initProject is idempotent: a second run changes nothing important', () => {
  const repo = makeRepo({ 'pnpm-lock.yaml': 'x\n' });
  try {
    project.initProject({ projectRoot: repo });
    const ignoreFirst = readFileSync(join(repo, '.gitignore'), 'utf8');
    const second = project.initProject({ projectRoot: repo });
    assert.equal(second.ok, true);
    assert.equal(second.integration.reason, 'exists');
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), ignoreFirst, 'no duplicated gitignore entries');
  } finally { cleanup(repo); }
});

test('an unrecognised stack fails with UNRECOGNISED_STACK instead of guessing (F.5)', () => {
  const repo = makeRepo({ 'README.md': 'nothing here\n' });
  try {
    const result = project.initProject({ projectRoot: repo });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNRECOGNISED_STACK');
    assert.match(result.message, /never guesses/);
  } finally { cleanup(repo); }
});

test('--force rewrites config; a plain re-run preserves it', () => {
  const repo = makeRepo({ 'package.json': '{}', 'package-lock.json': '{}' });
  try {
    project.initProject({ projectRoot: repo });
    const configPath = join(repo, '.sdlc', 'config.yml');
    writeFileSync(configPath, 'observability:\n  logLevel: debug\n');
    const preserved = project.initProject({ projectRoot: repo });
    assert.equal(preserved.steps.find((s) => s.step === 'config').status, 'exists');
    assert.match(readFileSync(configPath, 'utf8'), /logLevel: debug/);
    const forced = project.initProject({ projectRoot: repo, force: true });
    assert.equal(forced.steps.find((s) => s.step === 'config').status, 'rewritten');
    assert.doesNotMatch(readFileSync(configPath, 'utf8'), /logLevel: debug/);
  } finally { cleanup(repo); }
});

test('the integration branch is created from HEAD and not overwritten later', () => {
  const repo = makeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
  try {
    const before = git(['rev-parse', 'HEAD'], repo);
    project.initProject({ projectRoot: repo });
    assert.equal(git(['rev-parse', 'sdlc/integration'], repo), before);
  } finally { cleanup(repo); }
});

test('outside a git repository init still prepares .sdlc/ and reports why', () => {
  const dir = tempDir('sdlc-nogit-');
  try {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const result = project.initProject({ projectRoot: dir });
    assert.equal(result.ok, true);
    assert.equal(result.integration.reason, 'not-a-git-repo');
    assert.ok(existsSync(join(dir, '.sdlc', 'config.yml')));
  } finally { cleanup(dir); }
});

test('describeProject prints the stack, gates and next command', () => {
  const repo = makeRepo({ 'go.mod': 'module x\n' });
  try {
    const result = project.initProject({ projectRoot: repo });
    const text = project.describeProject(result);
    assert.match(text, /stack\s+: go/);
    assert.match(text, /next\s+: sdlc config validate/);
  } finally { cleanup(repo); }
});
