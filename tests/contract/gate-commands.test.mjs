/**
 * tests/contract/gate-commands.test.mjs — L3/F.5 + B.4.1.
 *
 * Stack detection, gate-command materialization, and runVerification through the
 * injectable `runner` (no real toolchain, no shell, no network). Fail-fast
 * ordering and `skipped:<reason>` evidence are asserted explicitly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { core, tempDir, cleanup, writeFiles, readFileSync, exists } from '../lib/helpers.mjs';
import { normalizeValue } from '../lib/normalize-events.mjs';
import { gateResultSetSchema, validate, formatErrors } from './schemas.mjs';

const gates = await core.gates();

const okRunner = () => ({ status: 0, stdout: 'ok', stderr: '' });

// ── F.5 detection table ────────────────────────────────────────────────────

test('detectStack: each stack marker maps to its stack, order pnpm before npm', () => {
  assert.equal(gates.detectStack(['pnpm-lock.yaml']), 'pnpm');
  assert.equal(gates.detectStack(['package-lock.json']), 'npm');
  assert.equal(gates.detectStack(['package.json']), 'npm');
  assert.equal(gates.detectStack(['pyproject.toml']), 'python');
  assert.equal(gates.detectStack(['setup.py']), 'python');
  assert.equal(gates.detectStack(['go.mod']), 'go');
  assert.equal(gates.detectStack(['Cargo.toml']), 'cargo');
  assert.equal(gates.detectStack(['README.md', 'src']), null, 'no marker recognised');
  assert.equal(gates.detectStack([]), null);
  assert.equal(gates.detectStack(['package-lock.json', 'pnpm-lock.yaml']), 'pnpm', 'pnpm wins over npm');
});

test('detectStack works from the files really present in a project root', () => {
  const dir = tempDir('sdlc-stack-');
  try {
    writeFiles(dir, { 'go.mod': 'module x\n', 'pyproject.toml': '[project]\n' });
    const found = gates.detectStack(gates.listRootFiles(dir));
    assert.equal(found, 'python', 'STACK_ORDER decides ties, not readdir order');
  } finally {
    cleanup(dir);
  }
});

test('detectPlaywright: either dependency name, in deps or devDeps', () => {
  assert.equal(gates.detectPlaywright({ devDependencies: { '@playwright/test': '^1.0.0' } }), true);
  assert.equal(gates.detectPlaywright({ dependencies: { playwright: '^1.0.0' } }), true);
  assert.equal(gates.detectPlaywright({ devDependencies: { vitest: '^1.0.0' } }), false);
  assert.equal(gates.detectPlaywright(null), false);
});

test('detectGateCommands: pnpm materializes argv-based gates (F.5 table)', () => {
  const detected = gates.detectGateCommands({ stack: 'pnpm' });
  assert.deepEqual(detected.bootstrap, ['pnpm', 'install', '--prefer-offline']);
  assert.deepEqual(detected.gates.unit.command, ['pnpm', 'test']);
  assert.deepEqual(detected.gates.build.command, ['pnpm', 'build']);
  assert.deepEqual(detected.gates.lint.command, ['pnpm', 'exec', 'eslint', '.']);
  assert.deepEqual(detected.gates.types.command, ['pnpm', 'exec', 'tsc', '--noEmit']);
  assert.deepEqual(detected.gates.syntax.command, ['node', '--check', '{file}']);
  assert.equal(detected.gates.syntax.scope, 'changed-files');
  assert.deepEqual(detected.gates.integration.command, detected.gates.unit.command, 'integration falls back to unit');
  assert.deepEqual(detected.skipWhen, { 'no-browser-stack': ['e2e', 'visual'] });
  assert.ok(detected.gates.unit.timeoutMs > 0);
});

test('detectGateCommands: npm, python, go and cargo commands match the F.5 table', () => {
  const npm = gates.detectGateCommands({ stack: 'npm' });
  assert.deepEqual(npm.bootstrap, ['npm', 'ci']);
  assert.deepEqual(npm.gates.unit.command, ['npm', 'test']);
  assert.deepEqual(npm.gates.build.command, ['npm', 'run', 'build']);
  assert.deepEqual(npm.gates.lint.command, ['true']);
  assert.deepEqual(npm.gates.lint.skipIf, ['not-configured']);
  assert.equal(npm.gates.types, undefined, 'npm has no type-check command by default');

  const python = gates.detectGateCommands({ stack: 'python' });
  assert.deepEqual(python.bootstrap, ['pip', 'install', '-e', '.']);
  assert.deepEqual(python.gates.unit.command, ['pytest', '-q']);

  const go = gates.detectGateCommands({ stack: 'go' });
  assert.deepEqual(go.bootstrap, ['go', 'mod', 'download']);
  assert.deepEqual(go.gates.build.command, ['go', 'build', './...']);
  assert.deepEqual(go.gates.unit.command, ['go', 'test', './...']);

  const cargo = gates.detectGateCommands({ stack: 'cargo' });
  assert.deepEqual(cargo.bootstrap, ['cargo', 'fetch']);
  assert.deepEqual(cargo.gates.build.command, ['cargo', 'build']);
  assert.deepEqual(cargo.gates.unit.command, ['cargo', 'test']);
});

test('detectGateCommands: no recognised stack ⇒ null (init never guesses)', () => {
  assert.equal(gates.detectGateCommands({ stack: null }), null);
  assert.equal(gates.detectGateCommands({}), null);
});

test('detectGateCommands: Playwright enables e2e + visual, otherwise recorded skipWhen', () => {
  const without = gates.detectGateCommands({ stack: 'pnpm', playwright: false });
  assert.equal(without.gates.e2e, undefined);
  assert.equal(without.gates.visual, undefined);
  assert.deepEqual(without.skipWhen, { 'no-browser-stack': ['e2e', 'visual'] });

  const withPlaywright = gates.detectGateCommands({ stack: 'pnpm', playwright: true });
  assert.deepEqual(withPlaywright.gates.e2e.command, ['npx', 'playwright', 'test']);
  assert.deepEqual(withPlaywright.gates.visual, { kind: 'playwright', config: '.sdlc/visual.config.ts' });
  assert.deepEqual(withPlaywright.skipWhen, {});
});

// ── runVerification (B.4.1) ────────────────────────────────────────────────

function fixtureConfig(gatesSpec) {
  return { verification: { gates: gatesSpec, gateTimeoutMs: 1234 } };
}

test('runVerification passes all selected gates, writes a per-gate log, returns schema-valid results', () => {
  const dir = tempDir('sdlc-gates-');
  try {
    const calls = [];
    const runner = (argv, opts) => { calls.push({ argv, opts }); return { ...okRunner() }; };
    const result = gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'logs'),
      taskId: 'API-042',
      gates: ['syntax', 'lint', 'unit'],
      // `scope: changed-files` + `{file}` ⇒ one run PER changed file (F.5).
      changedFiles: ['src/api/a.js'],
      config: fixtureConfig({
        syntax: { command: ['node', '--check', '{file}'], scope: 'changed-files' },
        lint: { command: ['pnpm', 'exec', 'eslint', '.'] },
        unit: { command: ['pnpm', 'test'], timeoutMs: 900000 },
      }),
      runner,
    });

    assert.equal(result.overall, 'pass');
    assert.equal(result.firstFailure, null, 'no failure ⇒ firstFailure is null');
    assert.deepEqual(Object.keys(result.gates), ['syntax', 'lint', 'unit']);
    for (const [name, entry] of Object.entries(result.gates)) {
      assert.equal(entry.status, 'pass', `${name} passes`);
      assert.equal(entry.exitCode, 0);
      assert.equal(typeof entry.durationMs, 'number');
      assert.ok(exists(entry.logPath), `${name} log exists`);
      const log = readFileSync(entry.logPath, 'utf8');
      assert.match(log, /^# exit 0|^# exit/m);
      assert.match(log, /ok/);
    }

    assert.equal(calls.length, 3);
    // F.5: the `{file}` placeholder is substituted with the changed file — the
    // literal placeholder must never reach the runner.
    assert.deepEqual(calls[0].argv, ['node', '--check', 'src/api/a.js']);
    assert.equal(calls[0].argv.includes('{file}'), false, 'the placeholder leaked to the runner');
    assert.deepEqual(result.gates.syntax.files, ['src/api/a.js']);
    assert.equal(calls[0].opts.timeoutMs, 1234, 'gateTimeoutMs is the default');
    assert.equal(calls[2].opts.timeoutMs, 900000, 'a per-gate timeoutMs wins');

    const schema = validate(gateResultSetSchema, result);
    assert.ok(schema.ok, formatErrors(schema, 'gate result set'));
  } finally {
    cleanup(dir);
  }
});

test('a file-scoped gate with no changed files SKIPS instead of running a literal placeholder', () => {
  const dir = tempDir('sdlc-gates-nofiles-');
  try {
    const calls = [];
    const result = gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'logs'),
      gates: ['syntax'],
      changedFiles: [],
      config: fixtureConfig({ syntax: { command: ['node', '--check', '{file}'], scope: 'changed-files' } }),
      runner: (argv) => { calls.push(argv); return { status: 0 }; },
    });
    assert.equal(result.gates.syntax.status, 'skipped:no-changed-files');
    assert.equal(result.overall, 'pass', 'a skipped gate is not a failure');
    assert.deepEqual(calls, [], 'the runner must not be invoked with a literal {file}');
  } finally {
    cleanup(dir);
  }
});

test('runVerification fails fast: a failing gate stops later gates in GATE_ORDER', () => {
  const dir = tempDir('sdlc-gates-fail-');
  try {
    const calls = [];
    const runner = (argv) => {
      calls.push(argv.join(' '));
      if (argv[0] === 'bad') return { status: 1, stdout: '', stderr: 'boom' };
      return { ...okRunner() };
    };
    const result = gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'logs'),
      gates: ['syntax', 'lint', 'unit'],
      config: fixtureConfig({
        syntax: { command: ['good-syntax'] },
        lint: { command: ['bad'] },
        unit: { command: ['good-unit'] },
      }),
      runner,
    });

    assert.equal(result.overall, 'fail');
    assert.equal(result.gates.syntax.status, 'pass');
    assert.equal(result.gates.lint.status, 'fail:1');
    assert.equal(result.gates.unit, undefined, 'a later gate must not run after a failure');
    assert.equal(calls.length, 2, 'the failing gate is the last command executed');
    assert.equal(result.firstFailure.gate, 'lint');
    assert.match(result.firstFailure.signature, /^lint:/);
    assert.ok(exists(result.gates.lint.logPath));

    const schema = validate(gateResultSetSchema, result);
    assert.ok(schema.ok, formatErrors(schema, 'failed gate result set'));
  } finally {
    cleanup(dir);
  }
});

test('runVerification records skipped:<reason> evidence for every skip path', () => {
  const dir = tempDir('sdlc-gates-skip-');
  try {
    const result = gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'logs'),
      skipGates: ['security'],
      gates: ['lint', 'build', 'visual', 'unit', 'security', 'perf'],
      config: fixtureConfig({
        lint: false,
        build: { skip: true, reason: 'stack-has-no-build' },
        visual: { kind: 'playwright', config: '.sdlc/visual.config.ts' },
        security: { command: ['audit'] },
        // `perf` and `unit` are not configured at all
      }),
      runner: () => ({ ...okRunner() }),
    });

    assert.equal(result.overall, 'pass', 'a skipped gate is not a failed gate');
    assert.equal(result.gates.lint.status, 'skipped:not-configured');
    assert.equal(result.gates.build.status, 'skipped:stack-has-no-build');
    assert.equal(result.gates.visual.status, 'skipped:playwright');
    assert.equal(result.gates.unit.status, 'skipped:not-configured');
    assert.equal(result.gates.perf.status, 'skipped:not-configured');
    assert.equal(result.gates.security.status, 'skipped:policy');

    const schema = validate(gateResultSetSchema, result);
    assert.ok(schema.ok, formatErrors(schema, 'skipped gate result set'));
  } finally {
    cleanup(dir);
  }
});

test('runVerification default selection follows GATE_ORDER, not config key order', () => {
  const dir = tempDir('sdlc-gates-order-');
  try {
    const result = gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'logs'),
      config: fixtureConfig({
        unit: { command: ['unit'] },
        lint: { command: ['lint'] },
        syntax: { command: ['syntax'] },
      }),
      runner: () => ({ ...okRunner() }),
    });
    assert.deepEqual(Object.keys(result.gates), ['syntax', 'lint', 'unit']);
  } finally {
    cleanup(dir);
  }
});

test('defaultRunner executes argv without a shell (real, offline)', () => {
  const passing = gates.defaultRunner(['node', '-e', 'process.stdout.write("hi")']);
  assert.equal(passing.status, 0);
  assert.equal(passing.stdout, 'hi');

  const failing = gates.defaultRunner(['node', '-e', 'process.exit(3)']);
  assert.equal(failing.status, 3);
});

test('negative control: ' + 'a green suite proves the runner ran, not that it was called', () => {
  const dir = tempDir('sdlc-gates-nc-');
  try {
    let called = 0;
    gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'logs'),
      gates: ['unit'],
      config: fixtureConfig({ unit: { command: ['definitely-not-installed-binary-xyz'] } }),
      runner: () => { called += 1; return { status: 127, stdout: '', stderr: 'not found' }; },
    });
    assert.equal(called, 1);
  } finally {
    cleanup(dir);
  }
});

test('negative control: skipped gates keep overall pass but a skipped log is never written', () => {
  const dir = tempDir('sdlc-gates-nc2-');
  try {
    const result = gates.runVerification({
      cwd: dir,
      logDir: join(dir, 'logs'),
      gates: ['lint'],
      config: fixtureConfig({ lint: false }),
      runner: () => ({ ...okRunner() }),
    });
    assert.equal(result.overall, 'pass');
    assert.equal(result.gates.lint.status, 'skipped:not-configured');
    assert.equal(result.gates.lint.logPath, undefined, 'a skip produces evidence, not a log file');
  } finally {
    cleanup(dir);
  }
});

test('K.6 determinism: the same gate inputs normalize to the same evidence', () => {
  const run = () => {
    const dir = tempDir('sdlc-gates-determinism-');
    try {
      return gates.runVerification({
        cwd: dir,
        logDir: join(dir, 'logs'),
        gates: ['syntax', 'unit'],
        config: fixtureConfig({ syntax: { command: ['node', '--check', '{file}'] }, unit: { command: ['pnpm', 'test'] } }),
        runner: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      });
    } finally {
      cleanup(dir);
    }
  };

  const first = run();
  const second = run();
  assert.equal(first.overall, second.overall);
  assert.equal(
    JSON.stringify(normalizeValue(first)),
    JSON.stringify(normalizeValue(second)),
    'durations and temp paths are the only divergence',
  );
});
