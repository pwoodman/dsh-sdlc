/**
 * tests/unit/guard-plugin.test.mjs — the DSH-facing guard layer (spec v3 C.7, L.4 T11).
 *
 * Covers contracts, tool-call path extraction, the plugin decision entry point,
 * REAL symlink containment (`escapesRoot` / `decideFsWriteReal`), host-API
 * installation (on / waterfall / none) and the denial evidence channel.
 * The pure matcher itself is covered by tests/unit/guard.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const plugin = await core.guardPlugin();
const g = await core.guard();

test('loadContract returns null for a missing or corrupt contract and the parsed object when present', () => {
  const dir = tempDir('sdlc-guard-contract-');
  try {
    assert.equal(plugin.CONTRACT_PATH, '.sdlc/task-contract.json');
    assert.equal(plugin.loadContract(dir), null, 'missing file → null');

    mkdirSync(join(dir, '.sdlc'), { recursive: true });
    writeFileSync(join(dir, '.sdlc/task-contract.json'), '{ not json');
    assert.equal(plugin.loadContract(dir), null, 'corrupt file → null');

    const contract = { allowed_paths: ['src/**'], forbidden_paths: ['vendor/**'] };
    writeFileSync(join(dir, '.sdlc/task-contract.json'), JSON.stringify(contract));
    assert.deepEqual(plugin.loadContract(dir), contract);
  } finally {
    cleanup(dir);
  }
});

test('guardFromWorktree takes paths from the contract and guardMode from config', () => {
  const dir = tempDir('sdlc-guard-worktree-');
  try {
    mkdirSync(join(dir, '.sdlc'), { recursive: true });
    writeFileSync(
      join(dir, '.sdlc/task-contract.json'),
      JSON.stringify({ allowed_paths: ['src/**'], forbidden_paths: ['src/auth/**'] }),
    );

    const guard = plugin.guardFromWorktree(dir, {});
    assert.ok(guard instanceof g.GuardPlugin);
    assert.deepEqual(guard.policy.allowed_paths, ['src/**']);
    assert.deepEqual(guard.policy.forbidden_paths, ['src/auth/**']);
    assert.equal(guard.policy.mode, 'deny', 'default guardMode is deny');
    assert.equal(guard.policy.worktreeRoot, dir);
    assert.equal(guard.checkFsWrite('src/api/a.ts'), 'allow');
    assert.equal(guard.checkFsWrite('tests/a.ts'), 'deny');
    assert.equal(guard.checkFsWrite('src/auth/a.ts'), 'deny', 'forbidden from the contract wins');

    const warn = plugin.guardFromWorktree(dir, { guardMode: 'warn' });
    assert.equal(warn.policy.mode, 'warn');
    assert.equal(warn.checkFsWrite('tests/a.ts'), 'allow', 'warn mode records but allows');
    assert.equal(warn.denials.length, 1);
    assert.equal(warn.denials[0].subject, 'tests/a.ts');

    // No contract at all → an empty allowed set (nothing is implicitly permitted).
    const bareRoot = tempDir('sdlc-guard-bare-wt-');
    try {
      const bare = plugin.guardFromWorktree(bareRoot, {});
      assert.deepEqual(bare.policy.allowed_paths, []);
    } finally {
      cleanup(bareRoot);
    }
  } finally {
    cleanup(dir);
  }
});

test('pathsFromToolCall collects every documented path field in order', () => {
  const args = {
    path: 'p1', file_path: 'p2', filePath: 'p3', target: 'p4', to: 'p5', from: 'p6',
    paths: ['p7', 'p8'], files: ['p9'], command: 'ignored', ignored: 'p10',
  };
  assert.deepEqual(
    plugin.pathsFromToolCall('write', args),
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'],
  );
  assert.deepEqual(plugin.pathsFromToolCall('write', { paths: ['a', null, '', 7] }), ['a']);
  assert.deepEqual(plugin.pathsFromToolCall('write', { files: ['only'] }), ['only']);
  assert.deepEqual(plugin.pathsFromToolCall('write', {}), []);
  // bash-shaped calls still expose their path-shaped args (the command is not a path)
  assert.deepEqual(plugin.pathsFromToolCall('bash', { command: 'rm -rf /', path: 'p' }), ['p']);
});

test('isBashTool recognises the shell-family tool names', () => {
  for (const name of ['bash', 'shell', 'run_command', 'terminal']) {
    assert.equal(plugin.isBashTool(name), true, `should be bash: ${name}`);
  }
  for (const name of ['write', 'read', 'edit', 'Bash', 'fs', '']) {
    assert.equal(plugin.isBashTool(name), false, `should not be bash: ${name}`);
  }
});

test('decideToolCall applies command policy to shell tools and path policy to fs tools', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: [] });

  const bashDenied = plugin.decideToolCall(guard, { toolName: 'bash', args: { command: 'rm -rf /' } });
  assert.equal(bashDenied.kind, 'deny');
  assert.match(bashDenied.reason, /forbidden-command/);
  assert.equal(plugin.decideToolCall(guard, { toolName: 'shell', args: { cmd: 'git status' } }).kind, 'allow');
  assert.equal(plugin.decideToolCall(guard, { toolName: 'run_command', args: { script: 'echo hi' } }).kind, 'allow');
  assert.equal(plugin.decideToolCall(guard, { toolName: 'terminal', args: { command: 'ls' } }).kind, 'allow');

  assert.equal(plugin.decideToolCall(guard, { toolName: 'write', args: { path: 'src/a.ts' } }).kind, 'allow');
  const denied = plugin.decideToolCall(guard, { toolName: 'write', args: { path: 'other/a.ts' } });
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /outside-allowed-paths/);
  assert.match(denied.reason, /other\/a\.ts/, 'the reason names the offending path');

  assert.equal(plugin.decideToolCall(guard, { toolName: 'read', args: {} }).kind, 'allow');
  assert.equal(plugin.decideToolCall(guard, {}).kind, 'allow');
});

test('escapesRoot (L.4 T11) follows a REAL symlink and fails closed when realpath throws', () => {
  const base = tempDir('sdlc-guard-symlink-');
  try {
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'link'), 'dir');

    const escaping = g.escapesRoot(join(root, 'link', 'secret.txt'), root);
    assert.equal(escaping.escapes, true, 'a real symlink out of root must be reported as an escape');
    assert.ok(escaping.relative.startsWith('..'), `expected ../ relative, got ${escaping.relative}`);

    assert.equal(g.escapesRoot(join(root, 'not-created.txt'), root).escapes, false);
    writeFileSync(join(root, 'real.txt'), 'x');
    assert.equal(g.escapesRoot(join(root, 'real.txt'), root).escapes, false);

    const failClosed = g.escapesRoot(join(root, 'link', 'secret.txt'), root, {
      realpath: () => { throw new Error('boom'); },
    });
    assert.equal(failClosed.escapes, true, 'an unresolvable path is treated as an escape');
    assert.match(failClosed.reason, /^realpath-failed:/);

    assert.deepEqual(g.escapesRoot(join(root, 'x'), ''), { escapes: false, reason: 'no-root' });
  } finally {
    cleanup(base);
  }
});

test('guard.decideFsWriteReal denies the symlink escape while the lexical matcher still allows it', () => {
  const base = tempDir('sdlc-guard-real-');
  try {
    const root = join(base, 'root');
    mkdirSync(root, { recursive: true });
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, 'link'), 'dir');

    const guard = new g.GuardPlugin({ allowed_paths: ['**'], worktreeRoot: root });
    assert.equal(guard.checkFsWrite('link/x.txt'), 'allow', 'checkFsWrite is deliberately filesystem-free');

    const real = guard.decideFsWriteReal('link/x.txt');
    assert.equal(real.kind, 'deny');
    assert.match(real.reason, /symlink-escape/);

    assert.equal(guard.decideFsWriteReal('inside/x.txt').kind, 'allow', 'a normal in-root path stays allowed');
  } finally {
    cleanup(base);
  }
});

test('installGuard on ctx.on registers the listener, denies through it and appends evidence', async () => {
  const dir = tempDir('sdlc-guard-install-');
  try {
    const listeners = [];
    const provided = [];
    const ctx = {
      on: (event, handler) => listeners.push([event, handler]),
      provide: (name, value) => provided.push([name, value]),
      logger: { debug() {}, warn() {} },
    };

    const guard = plugin.installGuard(ctx, { worktreeRoot: dir, guardMode: 'deny' });
    assert.ok(guard instanceof g.GuardPlugin, 'installGuard still returns the guard');
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0][0], 'tools/pre-execute');
    assert.equal(provided.length, 1);
    assert.equal(provided[0][0], 'sdlcGuard');
    assert.equal(provided[0][1].guard, guard);

    const decision = await listeners[0][1]({ toolName: 'bash', args: { command: 'rm -rf /' } });
    assert.equal(decision.kind, 'deny');

    const logPath = join(dir, '.sdlc', 'guard-denials.jsonl');
    assert.equal(existsSync(logPath), true, 'a denial is appended to .sdlc/guard-denials.jsonl');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.kind, 'deny');
    assert.equal(entry.toolName, 'bash');
    assert.match(entry.reason, /forbidden-command/);

    // an allowed call writes no further evidence
    await listeners[0][1]({ toolName: 'write', args: { path: '.sdlc/task-outbox.json' } });
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('installGuard falls back to ctx.waterfall when ctx.on is absent', async () => {
  const dir = tempDir('sdlc-guard-waterfall-');
  try {
    const calls = [];
    const ctx = { waterfall: (event, handler) => calls.push([event, handler]) };
    const guard = plugin.installGuard(ctx, { worktreeRoot: dir });
    assert.ok(guard instanceof g.GuardPlugin);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'tools/pre-execute');
    assert.equal((await calls[0][1]({ toolName: 'write', args: { path: 'x.ts' } })).kind, 'deny');
  } finally {
    cleanup(dir);
  }
});

test('installGuard with no host API returns a usable guard and never throws', async () => {
  const dir = tempDir('sdlc-guard-bare-');
  try {
    assert.doesNotThrow(() => plugin.installGuard(undefined, { worktreeRoot: dir }));
    const guard = plugin.installGuard({}, { worktreeRoot: dir });
    assert.ok(guard instanceof g.GuardPlugin);
    // No contract → no allowed paths → a write is denied, but nothing throws.
    assert.equal(guard.checkFsWrite('src/a.ts'), 'deny');
    assert.equal(plugin.decideToolCall(guard, { toolName: 'write', args: { path: 'src/a.ts' } }).kind, 'deny');

    // apply() is the loader entry and returns nothing: the Cordis runner reads
    // a plugin return value as an effect, so the installer is installGuard.
    // There is no default export — unwrapExports prefers `.default`, and a
    // bare function has no `.inject` (see plugin-entry-contract.test.mjs).
    assert.equal(plugin.apply({}, { worktreeRoot: dir }), undefined);
    assert.equal(plugin.default, undefined);
    assert.equal(typeof plugin.apply, 'function');
  } finally {
    cleanup(dir);
  }
});

test('the plugin re-exports the guard surface and defaultGuardPolicy exposes copies', () => {
  assert.equal(plugin.GuardPlugin, g.GuardPlugin);
  assert.deepEqual(plugin.ORCHESTRATOR_PATHS, g.ORCHESTRATOR_PATHS);
  assert.deepEqual(plugin.PROTECTED_ORCHESTRATOR_PATHS, g.PROTECTED_ORCHESTRATOR_PATHS);

  const policy = g.defaultGuardPolicy();
  assert.deepEqual(Object.keys(policy).sort(), ['forbidden_patterns', 'orchestratorPaths', 'protectedOrchestratorPaths']);
  assert.deepEqual(policy.orchestratorPaths, g.ORCHESTRATOR_PATHS);
  assert.deepEqual(policy.protectedOrchestratorPaths, g.PROTECTED_ORCHESTRATOR_PATHS);
  assert.deepEqual(policy.forbidden_patterns, g.DEFAULT_FORBIDDEN_PATTERNS);
  assert.notEqual(policy.orchestratorPaths, g.ORCHESTRATOR_PATHS, 'defaults are copied, not the shared arrays');
  assert.notEqual(policy.forbidden_patterns, g.DEFAULT_FORBIDDEN_PATTERNS);
});

test('commandPatternToRegExp converts * to .* and escapes regex metacharacters', () => {
  const force = g.commandPatternToRegExp('git push --force*');
  assert.equal(force.test('git push --force origin main'), true);
  assert.equal(force.test('git push origin main'), false);

  const literalDot = g.commandPatternToRegExp('a.b');
  assert.equal(literalDot.test('a.b'), true);
  assert.equal(literalDot.test('axb'), false, 'the dot is escaped');
});

test('normalizeCommand joins arrays, collapses whitespace and applies NFKC', () => {
  assert.equal(g.normalizeCommand('  git   status \n'), 'git status');
  assert.equal(g.normalizeCommand(['git', 'status']), 'git status');
  assert.equal(g.normalizeCommand('ｇｉｔ'), 'git', 'full-width normalises to ASCII');
  assert.equal(g.normalizeCommand(null), '');
  assert.equal(g.normalizeCommand(undefined), '');
});
