/**
 * tests/unit/worker-mgr.test.mjs — worker dispatch primitives
 * (spec v3 C.2, B.3.2, B.10, E1, E5, E8).
 *
 * These are the pure, side-effect-free launch/parse helpers the runtime and
 * worker-process integration layer both depend on:
 *   - the platform env scrub (E5): `DSH_HOME` and every provider key are
 *     removed unless passed EXPLICITLY;
 *   - the launcher argv (E1): there is NO `--headless` flag;
 *   - deterministic run identity + nonce;
 *   - exit classification from the headless contract (P4/P32);
 *   - tolerant NDJSON parsing and the result channels;
 *   - the port allocator, worktree/contract paths and the E8 resume rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const wm = await core.workerMgr();

// ── E5: the platform env scrub ─────────────────────────────────────────────

test('SENSITIVE_ENV_PATTERN matches KEY/PASSWORD/SECRET/TOKEN case-insensitively', () => {
  assert.equal(wm.SENSITIVE_ENV_PATTERN.test('OPENAI_API_KEY'), true);
  assert.equal(wm.SENSITIVE_ENV_PATTERN.test('db_password'), true);
  assert.equal(wm.SENSITIVE_ENV_PATTERN.test('MY_SECRET'), true);
  assert.equal(wm.SENSITIVE_ENV_PATTERN.test('A_TOKEN'), true);
  assert.equal(wm.SENSITIVE_ENV_PATTERN.test('PATH'), false);
  assert.equal(wm.SENSITIVE_ENV_PATTERN.test('HOME'), false);
});

test('scrubEnv strips exactly /KEY|PASSWORD|SECRET|TOKEN/i and every DSH_* name', () => {
  const scrubbed = wm.scrubEnv({
    PATH: '/usr/bin',
    HOME: '/home/tester',
    LANG: 'C.UTF-8',
    DSH_HOME: '/home/tester/.dsh',
    DSH_PROFILE: 'sdlc-worker',
    OPENAI_API_KEY: 'sk-openai',
    ANTHROPIC_API_KEY: 'sk-anthropic',
    MY_SECRET: 'shh',
    A_TOKEN: 'tok',
    DB_PASSWORD: 'pw',
  });

  assert.deepEqual(scrubbed, {
    PATH: '/usr/bin',
    HOME: '/home/tester',
    LANG: 'C.UTF-8',
  });
  for (const gone of ['DSH_HOME', 'DSH_PROFILE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MY_SECRET', 'A_TOKEN', 'DB_PASSWORD']) {
    assert.equal(gone in scrubbed, false, `${gone} must be scrubbed`);
  }
  assert.deepEqual(wm.scrubEnv({}), {}, 'an empty env scrubs to an empty env');
});

// ── B.10: the explicit worker env map ──────────────────────────────────────

const BASE_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/tester',
  OPENAI_API_KEY: 'sk-openai',
  ANTHROPIC_API_KEY: 'sk-anthropic',
  DSH_HOME: '/parent/.dsh',
  MY_SECRET: 'shh',
};

test('buildWorkerEnv forwards DSH_HOME unconditionally and forwards no provider key by default', () => {
  const { env, audit } = wm.buildWorkerEnv({ dshHome: '/opt/dsh', baseEnv: BASE_ENV });

  assert.deepEqual(env, { PATH: '/usr/bin', DSH_HOME: '/opt/dsh' });
  assert.equal(env.OPENAI_API_KEY, undefined, 'never a provider key unless opted in');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.MY_SECRET, undefined);
  assert.deepEqual(audit.forwardedEnvKeys, []);
  assert.equal(audit.credentialPolicy, 'credential-store');
  assert.equal(audit.DSH_HOME, '/opt/dsh');
  assert.equal(audit.path, '<from-parent>');
});

test('buildWorkerEnv forwards only keys listed in workerEnvKeys and audits env-keys', () => {
  const { env, audit } = wm.buildWorkerEnv({
    dshHome: '/opt/dsh',
    baseEnv: BASE_ENV,
    workerEnvKeys: ['OPENAI_API_KEY', 'MY_SECRET', 'NOT_IN_PARENT'],
  });

  assert.equal(env.OPENAI_API_KEY, 'sk-openai');
  assert.equal(env.MY_SECRET, 'shh');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'unlisted provider keys stay out');
  assert.equal(env.NOT_IN_PARENT, undefined, 'a listed key absent from the parent is not invented');
  assert.deepEqual(audit.forwardedEnvKeys, ['MY_SECRET', 'OPENAI_API_KEY'], 'sorted');
  assert.equal(audit.credentialPolicy, 'env-keys');
});

test('buildWorkerEnv treats an opt-in for a missing key as credential-store', () => {
  const { audit } = wm.buildWorkerEnv({ dshHome: '/opt/dsh', baseEnv: {}, workerEnvKeys: ['OPENAI_API_KEY'] });
  assert.deepEqual(audit.forwardedEnvKeys, []);
  assert.equal(audit.credentialPolicy, 'credential-store');
});

test('buildWorkerEnv: extra wins over the parent and over dshHome; undefined extra is dropped', () => {
  const { env } = wm.buildWorkerEnv({
    dshHome: '/opt/dsh',
    baseEnv: BASE_ENV,
    workerEnvKeys: ['OPENAI_API_KEY'],
    extra: { DSH_HOME: '/override/.dsh', PATH: '/extra/bin', OPENAI_API_KEY: 'sk-override', FOO: 'bar', DROPPED: undefined },
  });

  assert.equal(env.DSH_HOME, '/override/.dsh');
  assert.equal(env.PATH, '/extra/bin');
  assert.equal(env.OPENAI_API_KEY, 'sk-override');
  assert.equal(env.FOO, 'bar');
  assert.equal('DROPPED' in env, false);
});

test('buildWorkerEnv records a null DSH_HOME when none is supplied', () => {
  const { env, audit } = wm.buildWorkerEnv({ baseEnv: BASE_ENV });
  assert.equal('DSH_HOME' in env, false);
  assert.equal(audit.DSH_HOME, null);
  assert.equal(audit.path, '<from-parent>');
});

// ── E1: the launcher argv (NO --headless) ──────────────────────────────────

test('buildSpawnArgv emits the documented C.2 shape and NEVER --headless', () => {
  const argv = wm.buildSpawnArgv({
    profile: 'sdlc-worker',
    tierOverlay: '.sdlc/tiers/cheap.yml',
    prompt: 'implement the task',
  });

  assert.deepEqual(argv, [
    'dsh', '--profile', 'sdlc-worker',
    '--patch', '.sdlc/tiers/cheap.yml',
    '--json', 'implement the task',
  ]);
  assert.equal(argv.includes('--headless'), false, 'E1: --headless is not a launcher flag');
});

test('buildSpawnArgv places --session-id before --json and omits absent flags', () => {
  const argv = wm.buildSpawnArgv({ profile: 'sdlc-worker', prompt: 'resume this', sessionId: 'sess-42' });
  assert.deepEqual(argv, ['dsh', '--profile', 'sdlc-worker', '--session-id', 'sess-42', '--json', 'resume this']);

  const noPrompt = wm.buildSpawnArgv({ prompt: null, extra: ['--verbose'] });
  assert.deepEqual(noPrompt, ['dsh', '--profile', 'sdlc-worker', '--json', '--verbose']);
  assert.equal(noPrompt.includes('--headless'), false);
});

// ── B.3.2: deterministic run identity + nonce ──────────────────────────────

test('workerRunId is deterministic per (task, attempt) and differs per attempt', () => {
  const a = wm.workerRunId('API-001', 1);
  const b = wm.workerRunId('API-001', 1);
  const c = wm.workerRunId('API-001', 2);
  const d = wm.workerRunId('DB-001', 1);

  assert.equal(a, b, 'same (task, attempt) is deterministic');
  assert.notEqual(a, c, 'a different attempt is a different run');
  assert.notEqual(a, d, 'a different task is a different run');
  assert.match(a, /^API-001-a1-[0-9a-f]{8}$/);

  assert.notEqual(wm.workerRunId('API-001', 1, 'nonce-1'), a, 'a nonce varies the run id');
  assert.equal(wm.workerRunId('API-001', 1, 'nonce-1'), wm.workerRunId('API-001', 1, 'nonce-1'));
});

test('nonceFor is 32 hex chars and unique across calls', () => {
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    const n = wm.nonceFor('API-001-a1-deadbeef');
    assert.match(n, /^[0-9a-f]{32}$/);
    assert.equal(n.length, 32);
    seen.add(n);
  }
  assert.equal(seen.size, 25, 'every nonce is unique');
});

// ── P4/P32: exit classification ────────────────────────────────────────────

test('classifyExit maps exit code, signal and turn_end to the run status', () => {
  assert.equal(wm.classifyExit({ exitCode: 0 }), 'completed');
  assert.equal(wm.classifyExit({ exitCode: 0, turnEndReason: 'completed' }), 'completed');
  assert.equal(wm.classifyExit({ exitCode: 1 }), 'failed');
  assert.equal(wm.classifyExit({}), 'failed', 'no exit code and no signal is a failure');
  assert.equal(wm.classifyExit({ signal: 'SIGTERM' }), 'aborted');
  assert.equal(wm.classifyExit({ signal: 'SIGKILL' }), 'timeout');
  assert.equal(wm.classifyExit({ signal: 'SIGKILL', exitCode: 0 }), 'timeout', 'SIGKILL wins over exit 0');
  assert.equal(wm.classifyExit({ signal: 'SIGTERM', exitCode: 0 }), 'aborted');
  assert.equal(wm.classifyExit({ exitCode: 0, turnEndReason: 'aborted' }), 'aborted');
  assert.equal(wm.classifyExit({ exitCode: 0, turnEndReason: 'failed' }), 'failed');
  assert.equal(wm.classifyExit({ exitCode: 1, turnEndReason: 'aborted' }), 'aborted');
});

test('NDJSON_EVENT_TYPES is the documented closed set', () => {
  assert.deepEqual(wm.NDJSON_EVENT_TYPES, [
    'session', 'status', 'text', 'thinking', 'tool_call', 'tool_result', 'turn_end', 'final', 'error',
  ]);
});

// ── NDJSON parsing + result channels ───────────────────────────────────────

test('parseNdjson ignores blank lines, collects malformed lines, and never throws', () => {
  const stream = [
    '',
    '{"type":"session","id":"s1"}',
    '   ',
    'not json at all',
    '{"type":"final","text":"done"}',
    '{"broken":',
    '',
  ].join('\n');

  const { events, malformed } = wm.parseNdjson(stream);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.type), ['session', 'final']);
  assert.deepEqual(malformed, ['not json at all', '{"broken":']);

  assert.deepEqual(wm.parseNdjson(null), { events: [], malformed: [] });
  assert.deepEqual(wm.parseNdjson(undefined), { events: [], malformed: [] });
  assert.deepEqual(wm.parseNdjson(''), { events: [], malformed: [] });
});

test('parseNdjson caps a malformed line at 500 characters', () => {
  const long = 'x'.repeat(600);
  const { malformed } = wm.parseNdjson(long);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].length, 500);
});

test('finalText picks the LAST final event with a string text', () => {
  assert.equal(
    wm.finalText([
      { type: 'final', text: 'first' },
      { type: 'final', text: 'second' },
    ]),
    'second',
  );
  assert.equal(wm.finalText([{ type: 'final', text: 'kept' }, { type: 'final', text: 42 }]), 'kept', 'non-string text is skipped');
  assert.equal(wm.finalText([{ type: 'text', text: 'nope' }]), null);
  assert.equal(wm.finalText([]), null);
  assert.equal(wm.finalText(), null);
  assert.equal(wm.finalText([{ type: 'final', text: '' }]), '', 'an empty final is still a final');
});

test('turnEndReason picks the last turn_end, falling back to status', () => {
  assert.equal(
    wm.turnEndReason([
      { type: 'turn_end', reason: 'aborted' },
      { type: 'turn_end', reason: 'completed' },
    ]),
    'completed',
  );
  assert.equal(wm.turnEndReason([{ type: 'turn_end', status: 'failed' }]), 'failed');
  assert.equal(wm.turnEndReason([{ type: 'turn_end' }]), null);
  assert.equal(wm.turnEndReason([{ type: 'final' }]), null);
  assert.equal(wm.turnEndReason(), null);
});

// ── B.10: port allocator + worktree paths ──────────────────────────────────

test('portBlock(4100, 2) yields base 4120 and the ten ports 4120..4129', () => {
  const block = wm.portBlock(4100, 2);
  assert.equal(block.base, 4120);
  assert.deepEqual(block.ports, [4120, 4121, 4122, 4123, 4124, 4125, 4126, 4127, 4128, 4129]);
  assert.equal(block.ports.length, 10);

  const first = wm.portBlock(4100, 0);
  assert.equal(first.base, 4100);
  assert.deepEqual(first.ports, [4100, 4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108, 4109]);
  assert.equal(wm.portBlock(4100, 3, 2).base, 4106);
});

test('contractPathFor / worktreeExcludeEntries return the documented locations', () => {
  assert.equal(wm.contractPathFor('/tmp/wt-1'), '/tmp/wt-1/.sdlc/task-contract.json');

  assert.deepEqual(wm.worktreeExcludeEntries('/tmp/wt-1'), [
    { path: '/tmp/wt-1/.git/info/exclude', lines: ['.sdlc/'] },
  ]);
});

test('workerLogPath places the NDJSON capture under .sdlc/verification', () => {
  const path = wm.workerLogPath('/tmp/project', 'API-001', 'API-001-a1-deadbeef');
  assert.equal(path, '/tmp/project/.sdlc/verification/API-001/worker-API-001-a1-deadbeef.ndjson');
});

test('runLabel is the basename of the run identity', () => {
  assert.equal(wm.runLabel('API-001-a1-deadbeef'), 'API-001-a1-deadbeef');
  assert.equal(wm.runLabel('/var/runs/API-001-a1-deadbeef'), 'API-001-a1-deadbeef');
});

// ── B.10: provider concurrency limit ───────────────────────────────────────

test('providerLimitFromRegistry returns Infinity when undeclared and the declared limit otherwise', () => {
  assert.equal(wm.providerLimitFromRegistry([], 'openai'), Infinity);
  assert.equal(wm.providerLimitFromRegistry(undefined, 'openai'), Infinity);
  assert.equal(wm.providerLimitFromRegistry([{ provider: 'openai' }], 'openai'), Infinity);
  assert.equal(wm.providerLimitFromRegistry([{ provider: 'openai', limits: {} }], 'openai'), Infinity);
  assert.equal(wm.providerLimitFromRegistry([{ provider: 'other', limits: { maxConcurrent: 9 } }], 'openai'), Infinity);

  const registry = [
    { provider: 'openai', limits: { maxConcurrent: 3 } },
    { provider: 'anthropic', limits: { maxConcurrent: 7 } },
  ];
  assert.equal(wm.providerLimitFromRegistry(registry, 'openai'), 3);
  assert.equal(wm.providerLimitFromRegistry(registry, 'anthropic'), 7);
});

// ── E8: the resume rule ────────────────────────────────────────────────────

test('sessionForAttempt: first attempt is always fresh', () => {
  assert.deepEqual(wm.sessionForAttempt(), { sessionId: null, fresh: true, reason: 'first-attempt' });
  assert.deepEqual(
    wm.sessionForAttempt({ previousSessionId: null, worktreeRecreated: true }),
    { sessionId: null, fresh: true, reason: 'first-attempt' },
  );
});

test('sessionForAttempt: a re-created worktree starts fresh with reason worktree-recreated', () => {
  assert.deepEqual(
    wm.sessionForAttempt({ previousSessionId: 'sess-1', worktreeRecreated: true }),
    { sessionId: null, fresh: true, reason: 'worktree-recreated' },
  );
  // worktree recreation wins over a simultaneous preset change.
  assert.equal(
    wm.sessionForAttempt({ previousSessionId: 'sess-1', worktreeRecreated: true, presetChanged: true }).reason,
    'worktree-recreated',
  );
});

test('sessionForAttempt: a changed preset starts fresh', () => {
  assert.deepEqual(
    wm.sessionForAttempt({ previousSessionId: 'sess-1', presetChanged: true }),
    { sessionId: null, fresh: true, reason: 'preset-changed' },
  );
});

test('sessionForAttempt: an unchanged worktree resumes the same session id', () => {
  assert.deepEqual(
    wm.sessionForAttempt({ previousSessionId: 'sess-1' }),
    { sessionId: 'sess-1', fresh: false, reason: 'same-worktree' },
  );
  assert.deepEqual(
    wm.sessionForAttempt({ previousSessionId: 'sess-1', worktreeRecreated: false, presetChanged: false }),
    { sessionId: 'sess-1', fresh: false, reason: 'same-worktree' },
  );
});
