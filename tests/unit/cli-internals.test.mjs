/**
 * tests/unit/cli-internals.test.mjs — in-process coverage of the `sdlc` CLI module.
 *
 * Complements `tests/unit/cli.test.mjs`, which exercises the REAL executable as a
 * child process (the right black-box test). A spawned process cannot report V8
 * coverage to the parent, so the module's remaining branches — the dotted-key
 * path helpers and the per-command error branches — are driven here in-process.
 *
 * K.9 requires `sdlc-cli` ≥ 90 % lines; this file is what makes that number
 * meaningful rather than aspirational.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { load, tempDir, cleanup, makeRepo } from '../lib/helpers.mjs';

const cli = await load('packages/sdlc-cli/src/cli.mjs');

/** A minimal project directory that `sdlc init` accepts. */
function scaffold(prefix = 'sdlc-cli-int-') {
  const dir = tempDir(prefix);
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  return dir;
}

const flags = (extra = {}) => ({ _: [], flags: extra });

// ── the pure dotted-key helpers ───────────────────────────────────────────

test('setPath/getPath round-trip dotted keys, array indexes and the [] append form', () => {
  const obj = {};
  cli.setPath(obj, 'tiers.cheap[0].provider', 'openai');
  cli.setPath(obj, 'tiers.cheap[0].model', 'gpt-4o-mini');
  cli.setPath(obj, 'tiers.cheap[1].provider', 'anthropic');
  cli.setPath(obj, 'observability.logLevel', 'warn');
  cli.setPath(obj, 'execution.workerEnvKeys[]', 'OPENAI_API_KEY');
  assert.equal(cli.getPath(obj, 'tiers.cheap[0].provider'), 'openai');
  assert.equal(cli.getPath(obj, 'tiers.cheap[0].model'), 'gpt-4o-mini');
  assert.equal(cli.getPath(obj, 'tiers.cheap[1].provider'), 'anthropic');
  assert.equal(cli.getPath(obj, 'observability.logLevel'), 'warn');
  // A trailing `[]` addresses the ARRAY at that path.
  assert.deepEqual(cli.getPath(obj, 'execution.workerEnvKeys[]'), ['OPENAI_API_KEY']);
  // Missing paths return null rather than throwing.
  assert.equal(cli.getPath(obj, 'nope.nothing.here'), null);
  assert.equal(cli.getPath(null, 'a.b'), null);
  // Mixed nesting creates containers of the right kind.
  const nested = {};
  cli.setPath(nested, 'a[0].b[1]', 'v');
  assert.deepEqual(nested, { a: [{ b: [null, 'v'] }] });

  // REGRESSION: setting a sibling key must not clobber the container. This is
  // the spec Quick Start sequence (provider then model at the same index).
  const quick = {};
  cli.setPath(quick, 'tiers.cheap[0].provider', 'openai');
  cli.setPath(quick, 'tiers.cheap[0].model', 'openai/gpt-4o-mini');
  assert.deepEqual(quick, { tiers: { cheap: [{ provider: 'openai', model: 'openai/gpt-4o-mini' }] } });
  assert.equal(cli.getPath(quick, 'tiers.cheap[0].provider'), 'openai', 'the provider was erased by the sibling write');

  // REGRESSION: `[]` appends instead of creating a literal "[]" key.
  const list = {};
  cli.setPath(list, 'execution.workerEnvKeys[]', 'A');
  cli.setPath(list, 'execution.workerEnvKeys[]', 'B');
  assert.deepEqual(list, { execution: { workerEnvKeys: ['A', 'B'] } });
  assert.equal('[]' in list.execution.workerEnvKeys, false, 'a literal "[]" key was created');

  // A kind mismatch is repaired rather than silently nested wrongly.
  const repaired = { a: 'scalar' };
  cli.setPath(repaired, 'a.b', 1);
  assert.deepEqual(repaired, { a: { b: 1 } });
});

// ── command handlers, driven in-process ───────────────────────────────────

test('status/tasks/explain handle an uninitialised project without throwing', () => {
  const dir = tempDir('sdlc-cli-empty-');
  try {
    // No .sdlc/ at all: status exits 0 with a helpful message.
    assert.equal(cli.cmdStatus(dir, flags()), 0);
    assert.equal(cli.cmdStatus(dir, flags({ json: true })), 0);
    // tasks/explain on a project with a db but no rows.
    assert.equal(cli.cmdInit(dir, flags()), 1, 'no stack marker ⇒ init fails');

    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    assert.equal(cli.cmdInit(dir, flags()), 0);
    assert.equal(cli.cmdTasks(dir, flags({ json: true })), 0);
    assert.equal(cli.cmdTasks(dir, flags()), 0, 'empty task list prints "no tasks"');
    assert.equal(cli.cmdLogs(dir, flags({ json: true })), 0);
    assert.equal(cli.cmdLogs(dir, flags()), 0);
    assert.equal(cli.cmdDb(dir, { _: ['nonsense'], flags: {} }), 2, 'unknown db subcommand is a usage error');
    assert.equal(cli.cmdDb(dir, flags({ json: true })), 0, 'export-events');
    assert.equal(cli.cmdDb(dir, { _: ['integrity'], flags: {} }), 0);
  } finally { cleanup(dir); }
});

test('config show/validate/get/set/unknown behave and persist', () => {
  const dir = scaffold();
  try {
    assert.equal(cli.cmdInit(dir, flags()), 0);
    assert.equal(cli.cmdConfig(dir, { _: ['validate'], flags: {} }), 0);
    assert.equal(cli.cmdConfig(dir, { _: ['show'], flags: {} }), 0);
    assert.equal(cli.cmdConfig(dir, { _: ['get', 'storage.dbPath'], flags: { json: true } }), 0);

    const configPath = join(dir, '.sdlc', 'config.yml');
    const before = readFileSync(configPath, 'utf8');
    assert.equal(cli.cmdConfig(dir, { _: ['set', 'observability.logLevel', 'warn'], flags: {} }), 0);
    const after = readFileSync(configPath, 'utf8');
    assert.notEqual(after, before);
    assert.match(after, /logLevel: warn/);

    // Missing operands are usage errors, not crashes.
    assert.equal(cli.cmdConfig(dir, { _: ['set', 'only.key'], flags: {} }), 2);
    assert.equal(cli.cmdConfig(dir, { _: ['nonsense'], flags: {} }), 2);

    // Host-model adoption is a validated write, with the same usage surface.
    assert.equal(cli.cmdConfig(dir, {
      _: ['use-host-model'],
      flags: { provider: 'deepseek-account', model: 'deepseek-flash', json: true },
    }), 0);
    const adopted = readFileSync(configPath, 'utf8');
    assert.match(adopted, /provider: deepseek-account/);
    assert.match(adopted, /unknown: true/);
  } finally { cleanup(dir); }

  // The no-init contract: on a describable workspace the adoption command
  // materialises .sdlc/ itself; on an undescribable one it fails closed with
  // the real reason.
  const fresh = scaffold('sdlc-cli-int-fresh-');
  try {
    assert.equal(cli.cmdConfig(fresh, {
      _: ['use-host-model'],
      flags: { provider: 'deepseek-account', model: 'deepseek-flash', json: true },
    }), 0);
    assert.ok(existsSync(join(fresh, '.sdlc', 'sdlc.db')), 'adoption bootstrapped the project');
    assert.match(readFileSync(join(fresh, '.sdlc', 'config.yml'), 'utf8'), /provider: deepseek-account/);

    // Guard rails: a half route and a self-contradictory opt-out are usage
    // errors, never a silent discovery fallback or a null-route crash.
    assert.equal(cli.cmdConfig(fresh, { _: ['use-host-model'], flags: { provider: 'only' } }), 2);
    assert.equal(cli.cmdConfig(fresh, { _: ['use-host-model'], flags: { 'no-host-model': true } }), 2);
    assert.equal(cli.cmdConfig(fresh, { _: ['use-host-model'], flags: { model: 'only' } }), 2);
  } finally { cleanup(fresh); }

  const undescribable = tempDir('sdlc-cli-int-noinit-');
  try {
    assert.equal(cli.cmdConfig(undescribable, { _: ['use-host-model'], flags: {} }), 1);
    assert.equal(existsSync(join(undescribable, '.sdlc', 'config.yml')), false);
  } finally { cleanup(undescribable); }
});

test('hostModelFromArgs pairs explicit flags and honours --no-host-model', () => {
  const { hostModelFromArgs } = cli;
  // Half a route is a usage error, never a silent fallback to discovery.
  assert.match(hostModelFromArgs({ flags: { provider: 'only' } }).error, /must be given together/);
  assert.match(hostModelFromArgs({ flags: { model: 'only' } }).error, /must be given together/);
  const explicit = hostModelFromArgs({ flags: { provider: 'deepseek-account', model: 'deepseek-flash' } });
  assert.equal(explicit.host.provider, 'deepseek-account');
  assert.equal(explicit.host.source, 'explicit');
  // The effort flag survives the explicit path too (kebab-case flag → camelCase route).
  const withEffort = hostModelFromArgs({
    flags: { provider: 'deepseek-account', model: 'deepseek-flash', 'reasoning-effort': 'high' },
  });
  assert.equal(withEffort.host.reasoningEffort, 'high');
  assert.equal(withEffort.host.source, 'explicit');
  assert.equal(hostModelFromArgs({ flags: { 'no-host-model': true } }).host, null);
  // Default (no flags): discovery, which always resolves a usable route.
  const discovered = hostModelFromArgs({ flags: {} });
  assert.equal(typeof discovered.host?.provider, 'string');
  assert.equal(typeof discovered.host?.model, 'string');
});

test('cmdInit/cmdStatus adopt the Harness route on a fresh bootstrap, in-process', () => {
  const dir = scaffold('sdlc-cli-int-adopt-');
  try {
    assert.equal(cli.cmdInit(dir, flags({ provider: 'deepseek-account', model: 'deepseek-flash', json: true })), 0);
    let config = readFileSync(join(dir, '.sdlc', 'config.yml'), 'utf8');
    assert.match(config, /provider: deepseek-account/);
    assert.doesNotMatch(config, /provider: openai/);

    // Status on a second fresh workspace bootstraps it with the same policy.
    const other = scaffold('sdlc-cli-int-adopt2-');
    try {
      assert.equal(cli.cmdStatus(other, flags({ provider: 'deepseek-account', model: 'deepseek-flash', json: true })), 0);
      assert.ok(existsSync(join(other, '.sdlc', 'sdlc.db')));
      config = readFileSync(join(other, '.sdlc', 'config.yml'), 'utf8');
      assert.match(config, /provider: deepseek-account/);
      // An authored config is never rewritten by a later status/ensure.
      writeFileSync(join(other, '.sdlc', 'config.yml'), 'observability:\n  logLevel: debug\n');
      assert.equal(cli.cmdStatus(other, flags({ json: true })), 0);
      assert.match(readFileSync(join(other, '.sdlc', 'config.yml'), 'utf8'), /logLevel: debug/);
    } finally { cleanup(other); }
  } finally { cleanup(dir); }
});

test('lock status/release/unknown and the force guard', () => {
  const dir = scaffold();
  try {
    assert.equal(cli.cmdInit(dir, flags()), 0);
    assert.equal(cli.cmdLock(dir, { _: ['status'], flags: { json: true } }), 0);
    assert.equal(cli.cmdLock(dir, { _: [], flags: {} }), 0, 'defaults to status');
    assert.equal(cli.cmdLock(dir, { _: ['release'], flags: {} }), 0, 'no lock to release');
    assert.equal(cli.cmdLock(dir, { _: ['nonsense'], flags: {} }), 2);

    // A live lock (written by hand) must not be broken without --force.
    const lockPath = join(dir, '.sdlc', 'sdlc.lock');
    mkdirSync(join(dir, '.sdlc'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), bootId: 'b', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    assert.equal(cli.cmdLock(dir, { _: ['release'], flags: {} }), 1, 'a live lock is protected');
    assert.equal(existsSync(lockPath), true);
    assert.equal(cli.cmdLock(dir, { _: ['release'], flags: { force: true } }), 0);
    assert.equal(existsSync(lockPath), false);
  } finally { cleanup(dir); }
});

test('resume/stop report on an initialised project and cancel dispatchable work', () => {
  const dir = scaffold();
  try {
    assert.equal(cli.cmdInit(dir, flags()), 0);
    assert.equal(cli.cmdResume(dir, flags({ json: true })), 0);
    assert.equal(cli.cmdStop(dir, flags({ json: true })), 0);
    assert.equal(cli.cmdStop(dir, flags({ force: true })), 0);
  } finally { cleanup(dir); }
});

test('doctor and verify always emit a parseable result', () => {
  const dir = scaffold();
  try {
    assert.equal(cli.cmdInit(dir, flags()), 0);
    // doctor exits 0 or 1 depending on the host, but always writes a report.
    const doctorCode = cli.cmdDoctor(dir, flags({ json: true }));
    assert.ok(doctorCode === 0 || doctorCode === 1);
    assert.equal(cli.cmdVerify(dir, { _: [], flags: { task: 'T-1', gates: 'syntax' } }), 0, 'a gate with no command is skipped, not failed');
  } finally { cleanup(dir); }
});

test('init reports --force and --reconfigure, and an unknown command is a usage error', async () => {
  const dir = scaffold();
  try {
    assert.equal(cli.cmdInit(dir, flags()), 0);
    assert.equal(cli.cmdInit(dir, flags({ force: true })), 0);
    assert.equal(cli.cmdInit(dir, flags({ reconfigure: true })), 0);
  } finally { cleanup(dir); }

  // The dispatcher: help, unknown command, and the root override.
  assert.equal(await cli.main(['help']), 0);
  assert.equal(await cli.main([]), 0);
  assert.equal(await cli.main(['definitely-not-a-command']), 2);
  const repo = makeRepo({ 'pnpm-lock.yaml': '' });
  try {
    assert.equal(await cli.main(['--root', repo, 'init']), 0);
    assert.equal(await cli.main(['--root', repo, 'status', '--json']), 0);
  } finally { cleanup(repo); }
});

test('usage text documents every command the module dispatches', () => {
  const text = cli.usage();
  for (const command of Object.keys(cli.COMMANDS)) {
    assert.match(text, new RegExp(`sdlc ${command}\\b`), `usage does not mention "${command}"`);
  }
});
