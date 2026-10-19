/**
 * tests/integration/build-release-exclusions.test.mjs — the no-clone artifact
 * is the first thing beta testers download.
 *
 * This test builds the real tarball with the real script (no build, artifacts
 * already exist) into a temp directory and inspects it. It is the end-to-end
 * guard for the `.pnpm-store` regression: the unit test proves the parser, this
 * proves the ship artifact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ROOT, run, tempDir } from '../lib/helpers.mjs';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const MAX_BYTES = 4 * 1024 * 1024;

test('build-release ships no local state and stays small enough to download', (t) => {
  const out = join(tempDir('sdlc-release-out-'), 'dist');
  mkdirSync(out, { recursive: true });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  // `--out` is resolved against the repo root by the script; pass a relative
  // path so the temp dir stays outside the checkout.
  const result = run(process.execPath, [
    'scripts/build-release.mjs',
    '--skip-build',
    '--out', relative(ROOT, out),
  ], { cwd: ROOT, timeoutMs: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const tarball = join(out, `dsh-sdlc-${VERSION}.tgz`);
  assert.ok(existsSync(tarball), 'the versioned tarball exists');
  assert.ok(statSync(tarball).size <= MAX_BYTES, `tarball is ${statSync(tarball).size} bytes (limit ${MAX_BYTES})`);

  const listed = run('tar', ['tzf', tarball]);
  assert.equal(listed.status, 0, listed.stderr);
  const entries = listed.stdout.split('\n').filter(Boolean);
  const prefix = `dsh-sdlc-${VERSION}/`;
  const forbidden = [
    `${prefix}.pnpm-store/`,
    `${prefix}node_modules/`,
    `${prefix}.git/`,
    `${prefix}.sdlc/`,
    `${prefix}.validation/`,
    `${prefix}.eval-out/`,
    `${prefix}.eval-out-live/`,
    `${prefix}dist/`,
  ];
  for (const entry of entries) {
    for (const bad of forbidden) {
      assert.ok(!entry.startsWith(bad), `${entry} must not be in the beta artifact`);
    }
  }

  // The artifact's whole purpose is an install with no build step.
  for (const required of [
    'install.sh',
    'VERSION',
    'package.json',
    'packages/sdlc-orchestrator/lib/index.js',
    'packages/sdlc-orchestrator/cordis.patch.yml',
    'packages/sdlc-core/lib/index.js',
    'packages/sdlc-client-ui/lib/client.js',
  ]) {
    assert.ok(entries.includes(prefix + required), `${required} ships in the beta artifact`);
  }
});
