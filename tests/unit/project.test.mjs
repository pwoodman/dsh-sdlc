/**
 * tests/unit/project.test.mjs — project setup (spec v3 F.4, F.5, F.6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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

// ── ensureProject: the no-init-ritual bootstrap (F.4) ────────────────────────

test('ensureProject materialises a fresh workspace with the Harness model route', () => {
  const repo = makeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  try {
    const host = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' };
    const result = project.ensureProject({ projectRoot: repo, hostModel: host });
    assert.equal(result.ok, true);
    assert.equal(result.existed, false);
    assert.ok(existsSync(join(repo, '.sdlc', 'sdlc.db')));
    const config = readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8');
    // Every tier names the Harness route; no OpenAI/Anthropic entry remains,
    // so nothing in the fresh config implies a second API key.
    assert.match(config, /provider: deepseek-account/);
    assert.doesNotMatch(config, /openai|anthropic/);
    assert.match(config, /model: deepseek-flash/);
    assert.match(config, /reasoningEffort: high/);
    assert.match(config, /unknown: true/);
  } finally { cleanup(repo); }
});

test('ensureProject without a host model writes the spec defaults (explicit opt-out)', () => {
  const repo = makeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': 'x\n' });
  try {
    const result = project.ensureProject({ projectRoot: repo, hostModel: null });
    assert.equal(result.ok, true);
    const config = readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8');
    assert.match(config, /provider: openai/);
  } finally { cleanup(repo); }
});

test('ensureProject is a no-op when the DB exists and never rewrites an authored config', () => {
  const repo = makeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': 'x\n' });
  try {
    project.ensureProject({ projectRoot: repo, hostModel: null });
    const configPath = join(repo, '.sdlc', 'config.yml');
    writeFileSync(configPath, 'observability:\n  logLevel: debug\n');
    const second = project.ensureProject({
      projectRoot: repo,
      // A different live route must NOT leak into the user's config.
      hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    });
    assert.equal(second.ok, true);
    assert.equal(second.existed, true);
    assert.equal(second.steps, undefined, 'no init steps run for an existing project');
    assert.match(readFileSync(configPath, 'utf8'), /logLevel: debug/);
  } finally { cleanup(repo); }
});

test('ensureProject sets up a markerless workspace with manual gates instead of failing', async () => {
  // The user-facing contract: a plain folder (no lockfile marker) must not be
  // locked out of the product. Auto-setup proceeds with an HONEST config —
  // detection: manual, empty gates — while explicit `initProject` (below)
  // still refuses to guess.
  const repo = makeRepo({ 'README.md': '# nothing here\n' });
  try {
    const result = project.ensureProject({
      projectRoot: repo,
      hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    });
    assert.equal(result.ok, true, 'a markerless workspace is still usable');
    assert.equal(result.existed, false);
    assert.equal(result.stack, null);
    assert.equal(result.manual, true);
    assert.deepEqual(result.gateCommands, {});
    assert.deepEqual(result.bootstrap, []);

    const configText = readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8');
    assert.match(configText, /detection: manual/);
    assert.match(configText, /gates: \{\}/);
    assert.match(configText, /provider: deepseek-account/);
    assert.doesNotMatch(configText, /openai|anthropic/);
    // It is a real setup, so the integration machinery is prepared.
    assert.equal(git(['branch', '--list', 'sdlc/integration'], repo), 'sdlc/integration');

    // The vacuous-verification state is VISIBLE, not silent.
    const cfg = await core.config();
    const { config } = cfg.loadConfig(repo);
    const validation = cfg.validateConfig(config, { projectRoot: repo });
    assert.equal(validation.ok, true);
    assert.ok(validation.warnings.some((w) => /manual and no gates are authored/.test(w)),
      'validation warns about empty manual gates');
  } finally { cleanup(repo); }
});

test('initProject (the explicit init) still refuses to guess gates on a markerless workspace', () => {
  const repo = makeRepo({ 'README.md': '# nothing here\n' });
  try {
    const result = project.initProject({ projectRoot: repo });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNRECOGNISED_STACK');
    assert.match(result.message, /never guesses/);
    // The failure path leaves the git repo untouched: no branch, no gitignore.
    assert.equal(git(['branch', '--list', 'sdlc/integration'], repo), '', 'no integration branch from a failed init');
    assert.equal(existsSync(join(repo, '.gitignore')), false, 'no gitignore mutation from a failed init');
    assert.equal(existsSync(join(repo, '.sdlc', 'config.yml')), false, 'no guessed config');
    assert.equal(result.steps.some((s) => s.step === 'gate-detection'), false);
  } finally { cleanup(repo); }
});

test('ensureProject completes a db-only half-project instead of treating it as done', async () => {
  const repo = makeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': 'x\n' });
  try {
    // A read command can create a bare DB before any complete bootstrap
    // (node:sqlite opens/creates on demand). The marker of "done" must be
    // the config initProject writes, not the DB file.
    const schema = await core.schema();
    mkdirSync(join(repo, '.sdlc'), { recursive: true });
    const db = schema.openDatabase(join(repo, '.sdlc', 'sdlc.db'), { requireQuickCheck: false });
    db.close();
    assert.equal(existsSync(join(repo, '.sdlc', 'config.yml')), false);

    const result = project.ensureProject({
      projectRoot: repo,
      hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.existed, false, 'a db-only state is not a complete project');
    assert.ok(existsSync(join(repo, '.sdlc', 'config.yml')));
    assert.match(readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8'), /deepseek-account/);
    assert.ok(existsSync(join(repo, '.gitignore')), 'the full init steps ran');
  } finally { cleanup(repo); }
});

test('ensureProject recreates a removed DB while preserving the authored config', () => {
  // `git clean -fdx` removes the gitignored DB and keeps config.yml. The
  // next touch must repair the missing half without adopting a new route
  // into the config the user already has.
  const repo = makeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': 'x\n' });
  try {
    project.ensureProject({ projectRoot: repo, hostModel: { provider: 'deepseek-account', model: 'deepseek-flash' } });
    rmSync(join(repo, '.sdlc', 'sdlc.db'));
    const second = project.ensureProject({
      projectRoot: repo,
      hostModel: { provider: 'nvidia', model: 'some-other-route' },
    });
    assert.equal(second.ok, true);
    assert.equal(second.existed, false, 'a project missing its DB is repaired, not treated as done');
    assert.ok(existsSync(join(repo, '.sdlc', 'sdlc.db')), 'the DB was recreated');
    const config = readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8');
    assert.match(config, /deepseek-account/, 'the authored config is preserved untouched');
    assert.doesNotMatch(config, /some-other-route/);
  } finally { cleanup(repo); }
});

test('initProject (the explicit init) still refuses to guess gates on a markerless workspace', () => {
  const repo = makeRepo({ 'README.md': '# nothing here\n' });
  try {
    const result = project.initProject({ projectRoot: repo });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNRECOGNISED_STACK');
    assert.match(result.message, /never guesses/);
    // The failure path leaves the git repo untouched: no branch, no gitignore.
    assert.equal(git(['branch', '--list', 'sdlc/integration'], repo), '', 'no integration branch from a failed init');
    assert.equal(existsSync(join(repo, '.gitignore')), false, 'no gitignore mutation from a failed init');
    assert.equal(existsSync(join(repo, '.sdlc', 'config.yml')), false, 'no guessed config');
    assert.equal(result.steps.some((s) => s.step === 'gate-detection'), false);
  } finally { cleanup(repo); }
});
// (the former "failed bootstrap never mutates git" case is now the explicit
// init contract above — auto-setup no longer fails on markers, it succeeds
// with manual gates, and a successful setup legitimately prepares the branch)
