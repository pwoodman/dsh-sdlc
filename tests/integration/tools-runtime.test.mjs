/** Full generated preset admission and execution on an available real host. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../lib/helpers.mjs';

const runtime = process.env.SDLC_VERIFY_RUNTIME ?? join(ROOT, '.validation/desktop-runtime');
const available = existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js'));
test('all 26 shipped presets admit and execute with scoped tool negative controls', {
  skip: available ? false : 'Set SDLC_VERIFY_RUNTIME to an unpacked current Harness runtime',
}, () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/verify-tool-runtime.mjs'), runtime], {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS: 26 role compositions mount/);
  assert.match(result.stdout, /lead exposes 1 selectable preset/);
  assert.match(result.stdout, /worker\/invalid-input negative controls/);
});
