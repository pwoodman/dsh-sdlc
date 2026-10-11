/**
 * tests/integration/worker-process.test.mjs — spec v3 G.3.2, B.10, C.2, E5/E8 (L4).
 *
 * The platform scrub (E5) strips `/KEY|PASSWORD|SECRET|TOKEN/i` and every
 * `DSH_*` name, so worker launch MUST pass an explicit env map:
 *   - `DSH_HOME` is always forwarded;
 *   - provider keys are forwarded ONLY when the deployment opts in via
 *     `workerEnvKeys`, and the choice is recorded in the run manifest
 *     (`credential-store` vs `env-keys`).
 * `buildSpawnArgv` emits `--profile`, `--patch`, `--json` and NEVER `--headless`
 * (E1). `sessionForAttempt` refuses to adopt a session across a re-created
 * worktree (E8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

test('worker-process: default env is credential-store (no provider key), DSH_HOME forwarded', async () => {
  const { buildWorkerEnv, scrubEnv } = await core.workerMgr();
  const baseEnv = { PATH: '/usr/bin:/bin', DSH_HOME: '/parent/home', OPENAI_API_KEY: 'sk-test-secret' };

  // The platform scrub is the threat we must survive.
  const scrubbed = scrubEnv(baseEnv);
  assert.deepEqual(scrubbed, { PATH: '/usr/bin:/bin' });

  const { env, audit } = buildWorkerEnv({ dshHome: '/orchestrator/home', baseEnv, workerEnvKeys: [] });
  assert.deepEqual(env, { PATH: '/usr/bin:/bin', DSH_HOME: '/orchestrator/home' });
  assert.equal('OPENAI_API_KEY' in env, false, 'the provider key must NOT be forwarded by default');
  assert.deepEqual(audit.forwardedEnvKeys, []);
  assert.equal(audit.credentialPolicy, 'credential-store');
  assert.equal(audit.DSH_HOME, '/orchestrator/home');
  assert.equal(audit.path, '<from-parent>');
});

test('worker-process: env-key opt-in forwards the key and records `env-keys`', async () => {
  const { buildWorkerEnv } = await core.workerMgr();
  const baseEnv = { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test-secret', ANTHROPIC_API_KEY: 'sk-anthropic' };
  const { env, audit } = buildWorkerEnv({
    dshHome: '/dsh',
    baseEnv,
    workerEnvKeys: ['OPENAI_API_KEY'],
  });
  assert.equal(env.OPENAI_API_KEY, 'sk-test-secret');
  assert.equal('ANTHROPIC_API_KEY' in env, false, 'only opted-in keys are forwarded');
  assert.deepEqual(audit.forwardedEnvKeys, ['OPENAI_API_KEY']);
  assert.equal(audit.credentialPolicy, 'env-keys');

  // NEGATIVE CONTROL: forgetting DSH_HOME is observable — the worker would
  // silently fall back to `~/.dsh`.
  const { env: noHome } = buildWorkerEnv({ baseEnv, workerEnvKeys: [] });
  assert.equal('DSH_HOME' in noHome, false);
});

test('worker-process: buildSpawnArgv emits --profile/--patch/--json and NEVER --headless', async () => {
  const { buildSpawnArgv } = await core.workerMgr();
  const argv = buildSpawnArgv({
    profile: 'sdlc-worker',
    tierOverlay: '/tmp/tier-overlay.yml',
    prompt: 'implement the task',
    sessionId: 'session-1',
  });
  assert.equal(argv[0], 'dsh');
  assert.ok(argv.includes('--profile'));
  assert.equal(argv[argv.indexOf('--profile') + 1], 'sdlc-worker');
  assert.ok(argv.includes('--patch'));
  assert.equal(argv[argv.indexOf('--patch') + 1], '/tmp/tier-overlay.yml');
  assert.ok(argv.includes('--json'));
  assert.ok(argv.includes('--session-id'));
  assert.equal(argv.includes('--headless'), false, 'E1: --headless is not a launcher flag');
  assert.equal(argv.at(-1), 'implement the task');

  // Without an overlay there is no --patch, and still no --headless.
  const bare = buildSpawnArgv({ profile: 'sdlc-worker', prompt: 'x' });
  assert.equal(bare.includes('--patch'), false);
  assert.equal(bare.includes('--headless'), false);

  // NEGATIVE CONTROL: even a caller-supplied extra cannot resurrect --headless
  // as a launcher flag without being explicit about it.
  const withExtra = buildSpawnArgv({ profile: 'sdlc-worker', prompt: 'x', extra: ['--verbose'] });
  assert.ok(withExtra.includes('--verbose'));
  assert.equal(withExtra.includes('--headless'), false);
});

test('worker-process: sessionForAttempt refuses adoption across a re-created worktree (E8)', async () => {
  const { sessionForAttempt } = await core.workerMgr();
  assert.deepEqual(sessionForAttempt({}), { sessionId: null, fresh: true, reason: 'first-attempt' });

  const recreated = sessionForAttempt({ previousSessionId: 's-1', worktreeRecreated: true, presetChanged: false });
  assert.deepEqual(recreated, { sessionId: null, fresh: true, reason: 'worktree-recreated' });

  const presetChanged = sessionForAttempt({ previousSessionId: 's-1', worktreeRecreated: false, presetChanged: true });
  assert.deepEqual(presetChanged, { sessionId: null, fresh: true, reason: 'preset-changed' });

  const sameTree = sessionForAttempt({ previousSessionId: 's-1', worktreeRecreated: false, presetChanged: false });
  assert.deepEqual(sameTree, { sessionId: 's-1', fresh: false, reason: 'same-worktree' });
});
