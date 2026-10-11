/**
 * tests/contract/path-policy.test.mjs — L3/C.7.3.
 *
 * The published schema `packages/sdlc-guard/schema/path-policy.schema.json` is
 * parsed and used to validate representative `.sdlc/config.yml` safety policies
 * (H.1 shape). The schema is versioned (`x-dialect-version: 1.0.0`) and the glob
 * dialect it describes is exercised against the real matcher.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { core, ROOT } from '../lib/helpers.mjs';
import { validate, formatErrors } from './schemas.mjs';
import { loadFixture } from './fixture-util.mjs';

const SCHEMA_PATH = join(ROOT, 'packages', 'sdlc-guard', 'schema', 'path-policy.schema.json');

function publishedSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

test('the published path-policy schema file parses and declares the fixed dialect', () => {
  const schema = publishedSchema();
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, 'https://sdlc.dev/schemas/path-policy.schema.json');
  assert.equal(schema['x-dialect-version'], '1.0.0', 'C.7.3 publishes a versioned dialect');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false, 'unknown policy keys must be rejected');
  assert.ok(schema.$defs?.glob, '$defs.glob is the published glob definition');
  assert.equal(schema.$defs.glob.type, 'string');
  assert.equal(schema.$defs.glob.minLength, 1);
  assert.ok(schema.properties.guardMode.enum.includes('deny'));
  assert.ok(schema.properties.guardMode.enum.includes('warn'));
});

test('the valid H.1-shaped policy fixture validates against the published schema', () => {
  const result = validate(publishedSchema(), loadFixture('path-policy.valid.json'));
  assert.ok(result.ok, formatErrors(result, 'path-policy.valid.json'));
});

test('the invalid policy fixture is rejected (guardMode, empty glob, non-string command)', () => {
  const result = validate(publishedSchema(), loadFixture('path-policy.invalid.json'));
  assert.equal(result.ok, false);
  const paths = result.errors.map((e) => e.path);
  assert.ok(paths.some((p) => p.endsWith('.guardMode')), formatErrors(result, 'guardMode'));
  assert.ok(paths.some((p) => p.endsWith('.allowed_paths[0]')), formatErrors(result, 'empty glob'));
  assert.ok(paths.some((p) => p.endsWith('.forbidden_commands[0]')), formatErrors(result, 'non-string command'));
});

test('representative policies validate: minimal, deny, warn, and the command alias', () => {
  const schema = publishedSchema();
  const cases = {
    minimal: {},
    'H.1 safety block': {
      allowed_paths: ['src/**'],
      forbidden_patterns: ['git push --force*', 'rm -rf /'],
      orchestratorPaths: ['.sdlc/**', '.dsh/**'],
      protectedOrchestratorPaths: ['.sdlc/sdlc.db', '.sdlc/backup/**'],
      guardMode: 'deny',
    },
    'warn mode': { allowed_paths: ['**'], guardMode: 'warn', worktreeRoot: '/tmp/wt' },
    'forbidden_commands alias': { allowed_paths: ['src/**'], forbidden_commands: ['sudo rm -rf*'] },
  };
  for (const [label, policy] of Object.entries(cases)) {
    const result = validate(schema, policy);
    assert.ok(result.ok, formatErrors(result, label));
  }
});

// ── negative controls ──────────────────────────────────────────────────────

test('negative control: a policy cannot opt out of the guard by inventing a mode', () => {
  const schema = publishedSchema();
  for (const guardMode of ['allow', 'off', 'bypass', 'block']) {
    const result = validate(schema, { guardMode });
    assert.equal(result.ok, false, `guardMode ${guardMode} must be rejected`);
  }
});

test('negative control: unknown policy keys are rejected (additionalProperties:false)', () => {
  const result = validate(publishedSchema(), { allowed_paths: ['src/**'], disableGuard: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes('additional property')));
});

test('the validated dialect behaves as documented (C.7.3) in the real matcher', async () => {
  const guard = await core.guard();
  // `*` stays within a segment; `**` crosses segments, including zero.
  assert.equal(guard.matchGlob('src/*.js', 'src/a.js'), true);
  assert.equal(guard.matchGlob('src/*.js', 'src/deep/a.js'), false);
  assert.equal(guard.matchGlob('src/**', 'src/deep/a.js'), true);
  assert.equal(guard.matchGlob('**/*.pem', 'a/b/c.pem'), true);
  assert.equal(guard.matchGlob('**/x.js', 'x.js'), true, 'leading **/ matches zero segments');
  assert.equal(guard.matchGlob('a/**/b.js', 'a/b.js'), true, 'embedded **/ matches zero segments');
  // a leading ./ is stripped; backslashes normalize to POSIX.
  assert.equal(guard.matchGlob('src/**', './src/a.js'), true);
  assert.equal(guard.matchGlob('src/**', 'src\\a.js'), true);
  // traversal and absolute paths never match.
  assert.equal(guard.matchGlob('**', '../escape'), false);
  assert.equal(guard.matchGlob('**', '/etc/passwd'), false);
  assert.equal(guard.matchGlob('**', 'a\0b'), false);
});

test('a validated policy drives real guard decisions (forbidden wins over allowed)', async () => {
  const { GuardPlugin } = await core.guard();
  const policy = loadFixture('path-policy.valid.json');
  assert.ok(validate(publishedSchema(), policy).ok);

  // The published key is `guardMode`; GuardPlugin consumes it as `mode`.
  const guard = new GuardPlugin({
    allowed_paths: policy.allowed_paths,
    forbidden_paths: policy.forbidden_paths,
    forbidden_patterns: policy.forbidden_patterns,
    orchestratorPaths: policy.orchestratorPaths,
    protectedOrchestratorPaths: policy.protectedOrchestratorPaths,
    mode: policy.guardMode,
    worktreeRoot: policy.worktreeRoot,
  });

  assert.equal(guard.checkFsWrite('src/customers/api.py'), 'allow');
  assert.equal(guard.checkFsWrite('src/customers/notes.md'), 'allow');
  assert.equal(guard.checkFsWrite('src/auth/login.py'), 'deny', 'forbidden beats allowed');
  assert.equal(guard.checkFsWrite('certs/prod.pem'), 'deny');
  assert.equal(guard.checkFsWrite('src/../etc/passwd'), 'deny');
  assert.equal(guard.checkFsWrite('/etc/passwd'), 'deny');
  assert.equal(guard.checkFsWrite('.sdlc/task-outbox.json'), 'allow', 'outbox channel stays writable');
  assert.equal(guard.checkFsWrite('.sdlc/sdlc.db'), 'deny', 'protected orchestrator path');
  assert.equal(guard.checkCommand('git push --force origin main'), 'deny');
  assert.equal(guard.checkCommand('rm -rf /'), 'deny');
  assert.equal(guard.checkCommand('git status'), 'allow');
});
