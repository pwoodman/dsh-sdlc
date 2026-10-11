/**
 * tests/unit/guard.test.mjs — guard path matching & command policy (spec v3 C.7, G.2.4, K.3).
 *
 * L.3 is explicit: the guard is POLICY, not a security boundary. These tests
 * assert the policy decisions and the documented dialect; the DIFF-based
 * backstop is exercised in tests/adversarial.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, mulberry32, pick } from '../lib/helpers.mjs';

const g = await core.guard();

test('allowed_paths: write inside scope is permitted', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: ['src/auth/**'] });
  assert.equal(guard.checkFsWrite('src/api/users.ts'), 'allow');
});

test('allowed_paths: write outside scope is denied', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: [] });
  assert.equal(guard.checkFsWrite('tests/api.test.ts'), 'deny');
});

test('forbidden_paths: inside forbidden is denied even when inside allowed', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: ['src/auth/**'] });
  assert.equal(guard.checkFsWrite('src/auth/login.ts'), 'deny');
  assert.equal(guard.decideFsWrite('src/auth/login.ts').reason, 'forbidden-path:src/auth/**');
});

test('command policy: destructive commands denied, benign commands allowed', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['**'], forbidden_paths: [], forbidden_commands: ['git push --force', 'rm -rf'] });
  assert.equal(guard.checkCommand('git push --force origin main'), 'deny');
  assert.equal(guard.checkCommand('rm -rf /'), 'deny');
  assert.equal(guard.checkCommand('git status'), 'allow');
  assert.equal(guard.checkCommand('pnpm test'), 'allow');
});

test('default command policy denies destructive git and root rm (H.1 safety list)', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['**'] });
  for (const cmd of ['git push --force origin main', 'git clean -fdx', 'git reset --hard HEAD~5', 'rm -rf /', 'sudo rm -rf /var']) {
    assert.equal(guard.checkCommand(cmd), 'deny', `should deny: ${cmd}`);
  }
  for (const cmd of ['git status', 'git commit -m "x"', 'npm ci', 'pytest -q', 'go test ./...']) {
    assert.equal(guard.checkCommand(cmd), 'allow', `should allow: ${cmd}`);
  }
});

test('glob matching: ** crosses segments, * does not', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: [] });
  assert.equal(guard.checkFsWrite('src/a.ts'), 'allow');
  assert.equal(guard.checkFsWrite('src/deep/nested/a.ts'), 'allow');
  assert.equal(guard.checkFsWrite('other/a.ts'), 'deny');

  const single = new g.GuardPlugin({ allowed_paths: ['src/*'], forbidden_paths: [] });
  assert.equal(single.checkFsWrite('src/a.ts'), 'allow');
  assert.equal(single.checkFsWrite('src/deep/a.ts'), 'deny');
});

test('glob dialect: leading ./ stripped, ? is one non-slash char, matching is positional', () => {
  assert.equal(g.matchGlob('src/**', './src/a.ts'), true);
  assert.equal(g.matchGlob('src/a?.ts', 'src/ab.ts'), true);
  assert.equal(g.matchGlob('src/a?.ts', 'src/abb.ts'), false);
  assert.equal(g.matchGlob('**/*.ts', 'src/deep/a.ts'), true);
  assert.equal(g.matchGlob('**/*.ts', 'a.ts'), true);
});

test('normalization is idempotent (K.3)', () => {
  const once = g.normalizePath('./src//deep/../x.ts');
  assert.equal(once.ok, false, 'traversal is rejected, not normalized away');
  const n1 = g.normalizePath('./src/a/b.ts');
  const n2 = g.normalizePath(n1.path);
  assert.deepEqual(n2, n1);
});

test('traversal, absolute, home-relative and NUL paths are denied', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['**'] });
  for (const p of ['../escape.txt', 'src/../../x.ts', '/etc/passwd', '~/secrets', 'a\0b', 'C:/Windows/system32', '\\\\server\\share']) {
    assert.equal(guard.checkFsWrite(p), 'deny', `should deny: ${JSON.stringify(p)}`);
  }
});

test('ORCHESTRATOR_PATHS are writable, except the protected files (B.3.2/E7)', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'] });
  assert.equal(guard.checkFsWrite('.sdlc/task-outbox.json'), 'allow', 'the outbox is the worker result channel');
  assert.equal(guard.checkFsWrite('.sdlc/verification/T/unit.log'), 'allow');
  assert.equal(guard.checkFsWrite('.sdlc/sdlc.db'), 'deny');
  assert.equal(guard.checkFsWrite('.sdlc/sdlc.lock'), 'deny');
  assert.equal(guard.checkFsWrite('.sdlc/task-contract.json'), 'deny');
  // forbidden still wins inside the orchestrator set
  const forbidding = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: ['.sdlc/**'] });
  assert.equal(forbidding.checkFsWrite('.sdlc/task-outbox.json'), 'deny');
});

test('reads are not scoped by allowed_paths; unsafe and forbidden reads are denied', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: ['vendor/**'] });
  assert.equal(guard.checkFsRead('README.md'), 'allow');
  assert.equal(guard.checkFsRead('vendor/x.js'), 'deny');
  assert.equal(guard.checkFsRead('../outside'), 'deny');
});

test('warn mode records the denial but allows it (guardMode: warn)', () => {
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], mode: 'warn' });
  assert.equal(guard.checkFsWrite('tests/x.ts'), 'allow');
  assert.equal(guard.denials.length, 1);
  assert.equal(guard.denials[0].subject, 'tests/x.ts');
});

test('property: every path outside allowed_paths is denied (seeded PRNG)', () => {
  const rng = mulberry32(77);
  const allowed = ['src/**', 'tests/**'];
  const guard = new g.GuardPlugin({ allowed_paths: allowed, forbidden_paths: ['src/auth/**'] });
  const inside = ['src/a.ts', 'src/b/c.ts', 'tests/x.test.ts', 'src/deep/z.js'];
  const outside = ['docs/a.md', 'vendor/x.js', 'other/z.ts', 'src/auth/login.ts'];
  for (let i = 0; i < 400; i += 1) {
    const p = pick(rng, rng() > 0.5 ? inside : outside);
    const expected = outside.includes(p) ? 'deny' : 'allow';
    assert.equal(guard.checkFsWrite(p), expected, `${p} should be ${expected}`);
  }
});

test('property: forbidden beats allowed for every generated overlap (K.3)', () => {
  const rng = mulberry32(1234);
  const segments = ['api', 'auth', 'users', 'db', 'x'];
  for (let i = 0; i < 300; i += 1) {
    const a = pick(rng, segments);
    const b = pick(rng, segments);
    const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: [`src/${b}/**`] });
    const path = `src/${a}/f.ts`;
    const expected = a === b ? 'deny' : 'allow';
    assert.equal(guard.checkFsWrite(path), expected, `${path} with forbidden src/${b}/**`);
  }
});

test('tool-call decisions: bash uses command policy, others use path policy', async () => {
  const plugin = await core.guardPlugin();
  const guard = new g.GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: [] });
  assert.deepEqual(plugin.decideToolCall(guard, { toolName: 'bash', args: { command: 'rm -rf /' } }).kind, 'deny');
  assert.deepEqual(plugin.decideToolCall(guard, { toolName: 'write', args: { path: 'src/a.ts' } }).kind, 'allow');
  const denied = plugin.decideToolCall(guard, { toolName: 'write', args: { path: 'other/a.ts' } });
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /outside-allowed-paths/);
});

test('orchestrator-managed paths are exported and consistent with worker-result', async () => {
  const wr = await core.workerResult();
  assert.deepEqual(g.ORCHESTRATOR_PATHS, ['.sdlc/**', '.dsh/**']);
  assert.deepEqual(wr.ORCHESTRATOR_PATHS, g.ORCHESTRATOR_PATHS);
  assert.deepEqual(g.PROTECTED_ORCHESTRATOR_PATHS, wr.PROTECTED_ORCHESTRATOR_PATHS);
});
