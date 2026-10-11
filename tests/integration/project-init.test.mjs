/**
 * tests/integration/project-init.test.mjs — spec v3 G.3.1, F.4/F.5/F.6 (L4).
 *
 * `project.initProject` on a real temp git repo with `package.json` +
 * `pnpm-lock.yaml`:
 *   - creates the `.sdlc/` tree, the `sdlc/integration` branch, `sdlc.db`,
 *     `.gitignore` entries and `.sdlc/config.yml` with detected gate commands;
 *   - re-running is idempotent;
 *   - the generated config round-trips through the project's own yaml-lite;
 *   - an unrecognised stack returns `ok:false` / `UNRECOGNISED_STACK` and never
 *     guesses gate commands.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { core, makeRepo, git, cleanup } from '../lib/helpers.mjs';

test('project-init: creates the .sdlc tree, integration branch, DB, gitignore and detected gates', async () => {
  const { initProject, SDLC_TREE, GITIGNORE_ENTRIES, INTEGRATION_BRANCH } = await core.project();
  const repo = makeRepo({
    'package.json': JSON.stringify({
      name: 'demo',
      devDependencies: { '@playwright/test': '^1.0.0' },
    }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  });
  try {
    const result = initProject({ projectRoot: repo });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    assert.equal(result.stack, 'pnpm');
    assert.equal(result.playwright, true);

    for (const dir of SDLC_TREE) {
      assert.ok(existsSync(join(repo, dir)), `${dir} must exist`);
    }
    assert.ok(existsSync(join(repo, '.sdlc', 'sdlc.db')), 'the SQLite database is created');
    assert.equal(git(['rev-parse', '--verify', '--quiet', INTEGRATION_BRANCH], repo).length, 40);
    assert.equal(result.integration.created, true);

    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    for (const entry of GITIGNORE_ENTRIES) {
      assert.ok(gitignore.split('\n').includes(entry), `.gitignore must contain ${entry}`);
    }

    const configText = readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8');
    assert.match(configText, /verification:/);
    assert.match(configText, /gates:/);
    assert.match(configText, /pnpm/);
    assert.match(configText, /bootstrapCommands:/);
    // Playwright detected ⇒ e2e/visual gates are concrete commands.
    assert.match(configText, /playwright/);
    assert.deepEqual(result.gateCommands.unit.command, ['pnpm', 'test']);
    assert.deepEqual(result.bootstrap, ['pnpm', 'install', '--prefer-offline']);

    // ── idempotence ──────────────────────────────────────────────────────
    const second = initProject({ projectRoot: repo });
    assert.equal(second.ok, true);
    assert.deepEqual(second.integration, { created: false, reason: 'exists' });
    assert.equal(second.steps.find((s) => s.step === 'config').status, 'exists');
    assert.equal(second.steps.find((s) => s.step === 'gitignore').added, 0);
    assert.equal(readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8'), configText);
  } finally {
    cleanup(repo);
  }
});

test('project-init: an unrecognised stack fails closed and never guesses gates', async () => {
  const { initProject } = await core.project();
  const repo = makeRepo({ 'README.md': '# no stack markers here\n' });
  try {
    const result = initProject({ projectRoot: repo });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNRECOGNISED_STACK');
    assert.match(result.message, /never guesses/);
    // The tree is prepared, but no DB and no guessed config are written.
    assert.ok(existsSync(join(repo, '.sdlc')));
    assert.equal(existsSync(join(repo, '.sdlc', 'config.yml')), false);
    assert.equal(existsSync(join(repo, '.sdlc', 'sdlc.db')), false);

    // NEGATIVE CONTROL: a manual/forced retry with an override is required.
    assert.equal(result.steps.some((s) => s.step === 'gate-detection'), false);
  } finally {
    cleanup(repo);
  }
});

test('project-init: the generated config.yml round-trips through yaml-lite', async () => {
  const { initProject } = await core.project();
  const { parseYaml } = await core.yaml();
  const repo = makeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  try {
    initProject({ projectRoot: repo });
    const text = readFileSync(join(repo, '.sdlc', 'config.yml'), 'utf8');
    const parsed = parseYaml(text);
    assert.equal(typeof parsed, 'object');
    assert.ok(parsed.verification.gates.unit, 'detected gates survive the serialization round-trip');
    assert.deepEqual(parsed.execution.workerEnvKeys, []);
    // Regression guard: an earlier `dumpYaml` wrote empty arrays as `key:\n[]`
    // (unindented), producing a config `parseYaml` could not read.
  } finally {
    cleanup(repo);
  }
});
