/**
 * tests/unit/gates.test.mjs — gate detection and execution (spec v3 F.5, B.4.1, G.3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { core, tempDir, cleanup, writeFiles } from '../lib/helpers.mjs';

const gates = await core.gates();

test('stack detection follows F.5, with pnpm before npm', () => {
  assert.equal(gates.detectStack(['pnpm-lock.yaml', 'package.json']), 'pnpm');
  assert.equal(gates.detectStack(['package-lock.json', 'package.json']), 'npm');
  assert.equal(gates.detectStack(['pyproject.toml']), 'python');
  assert.equal(gates.detectStack(['go.mod']), 'go');
  assert.equal(gates.detectStack(['Cargo.toml']), 'cargo');
  assert.equal(gates.detectStack(['README.md']), null);
});

test('detected gate commands are concrete argv arrays (never shell strings)', () => {
  const detected = gates.detectGateCommands({ stack: 'pnpm', playwright: false });
  assert.deepEqual(detected.bootstrap, ['pnpm', 'install', '--prefer-offline']);
  assert.deepEqual(detected.gates.unit.command, ['pnpm', 'test']);
  assert.deepEqual(detected.gates.integration.command, ['pnpm', 'test']);
  assert.deepEqual(detected.gates.build.command, ['pnpm', 'build']);
  assert.ok(Array.isArray(detected.gates.syntax.command));
  assert.deepEqual(detected.skipWhen, { 'no-browser-stack': ['e2e', 'visual'] });
});

test('Playwright presence enables e2e + visual and removes the skip', () => {
  const detected = gates.detectGateCommands({ stack: 'npm', packageJson: { devDependencies: { '@playwright/test': '^1' } }, playwright: true });
  assert.equal(detected.gates.e2e.command[0], 'npx');
  assert.equal(detected.gates.visual.kind, 'playwright');
  assert.deepEqual(detected.skipWhen, {});
});

test('detectPlaywright reads dependencies and devDependencies', () => {
  assert.equal(gates.detectPlaywright({ devDependencies: { playwright: '1' } }), true);
  assert.equal(gates.detectPlaywright({ dependencies: { '@playwright/test': '1' } }), true);
  assert.equal(gates.detectPlaywright({ dependencies: {} }), false);
  assert.equal(gates.detectPlaywright(null), false);
});

test('an unrecognised stack returns null so init fails rather than guessing', () => {
  assert.equal(gates.detectGateCommands({ stack: null }), null);
});

test('runVerification writes a log per gate and passes when every runner call exits 0', () => {
  const dir = tempDir('sdlc-gates-');
  try {
    const logDir = join(dir, '.sdlc', 'verification', 'T-1');
    const result = gates.runVerification({
      cwd: dir,
      logDir,
      config: { verification: { gates: { syntax: { command: ['node', '--check', 'a.js'] }, unit: { command: ['true'] } } } },
      gates: ['syntax', 'unit'],
      runner: () => ({ status: 0, stdout: 'ok', stderr: '' }),
    });
    assert.equal(result.overall, 'pass');
    assert.equal(result.gates.syntax.status, 'pass');
    assert.ok(existsSync(join(logDir, 'syntax.log')));
    assert.match(readFileSync(join(logDir, 'syntax.log'), 'utf8'), /\$ node --check a\.js/);
  } finally { cleanup(dir); }
});

test('a failing gate stops the pipeline (fail-fast, B.4.1) and captures the failure', () => {
  const dir = tempDir('sdlc-gates-');
  try {
    const logDir = join(dir, 'verif');
    const result = gates.runVerification({
      cwd: dir,
      logDir,
      gates: ['syntax', 'lint', 'unit'],
      config: { verification: { gates: { syntax: { command: ['x'] }, lint: { command: ['y'] }, unit: { command: ['z'] } } } },
      runner: (argv) => (argv[0] === 'y' ? { status: 1, stdout: 'lint failed badly', stderr: '' } : { status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(result.overall, 'fail');
    assert.equal(result.firstFailure.gate, 'lint');
    assert.equal(result.gates.unit, undefined, 'later gates must not run after a failure');
    assert.match(readFileSync(join(logDir, 'lint.log'), 'utf8'), /lint failed badly/);
    assert.ok(result.gates.lint.signature.startsWith('lint:'));
  } finally { cleanup(dir); }
});

test('unconfigured gates are recorded as skipped:<reason>, never as passes', () => {
  const dir = tempDir('sdlc-gates-');
  try {
    const result = gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'v'),
      gates: ['syntax', 'visual', 'perf'],
      config: { verification: { gates: { syntax: { command: ['true'] }, visual: { kind: 'playwright' } } } },
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(result.gates.visual.status, 'skipped:playwright');
    assert.equal(result.gates.perf.status, 'skipped:not-configured');
    assert.equal(result.overall, 'pass');
  } finally { cleanup(dir); }
});

test('an explicitly disabled gate carries its configured reason', () => {
  const dir = tempDir('sdlc-gates-');
  try {
    const result = gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'v'),
      gates: ['integration'],
      config: { verification: { gates: { integration: { skip: true, reason: 'no-suite' } } } },
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(result.gates.integration.status, 'skipped:no-suite');
  } finally { cleanup(dir); }
});

test('gatesForTask derives the required gate list from the risk class', () => {
  const required = gates.gatesForTask('R2').filter((g) => g.required).map((g) => g.gate);
  assert.deepEqual(required, ['syntax', 'lint', 'unit', 'integration']);
});

test('readGateLog returns evidence truncated for an elevation packet', () => {
  const dir = tempDir('sdlc-gates-');
  try {
    writeFiles(dir, { 'unit.log': 'x'.repeat(20000) });
    const log = gates.readGateLog(join(dir, 'unit.log'));
    assert.equal(log.length, 8192);
    assert.equal(gates.readGateLog(join(dir, 'missing.log')), null);
  } finally { cleanup(dir); }
});
