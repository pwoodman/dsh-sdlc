/**
 * tests/integration/verification-pipeline.test.mjs — spec v3 G.3.3, F.5, B.4.1 (L4).
 *
 * `gates.runVerification` over a temp project with the injectable `runner`:
 *   - all-pass produces one log per gate under `.sdlc/verification/<task>/`;
 *   - a failing gate stops the pipeline (fail-fast in GATE_ORDER) and the
 *     failure is captured in the gate log;
 *   - a skipped gate is recorded as `skipped:<reason>`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

function configFor(gates) {
  return { verification: { gateTimeoutMs: 1000, gates } };
}

const CONFIGURED = {
  syntax: { command: ['node', '--check', '{file}'] },
  lint: { command: ['npm', 'run', 'lint'] },
  unit: { command: ['npm', 'test'] },
  integration: { command: ['npm', 'run', 'test:integration'] },
};

test('verification-pipeline: all gates pass and each writes a log', async () => {
  const { runVerification } = await core.gates();
  const cwd = tempDir('sdlc-gates-');
  try {
    const calls = [];
    const runner = (argv) => { calls.push(argv.join(' ')); return { status: 0, stdout: 'ok', stderr: '' }; };
    const result = runVerification({
      cwd,
      gates: ['syntax', 'lint', 'unit', 'integration'],
      config: configFor(CONFIGURED),
      runner,
      taskId: 'TEST-001',
      // `node --check {file}` with `scope: changed-files` runs once per file.
      changedFiles: ['src/api/a.ts', 'src/api/b.ts'],
    });

    assert.equal(result.overall, 'pass');
    assert.equal(result.firstFailure, null);
    assert.deepEqual(calls, [
      'node --check src/api/a.ts', 'node --check src/api/b.ts',
      'npm run lint', 'npm test', 'npm run test:integration',
    ]);
    for (const gate of ['syntax', 'lint', 'unit', 'integration']) {
      assert.equal(result.gates[gate].status, 'pass');
      const logPath = join(cwd, '.sdlc', 'verification', 'TEST-001', `${gate}.log`);
      assert.equal(result.gates[gate].logPath, logPath);
      assert.ok(existsSync(logPath), `${gate}.log must exist`);
    }
  } finally {
    cleanup(cwd);
  }
});

test('verification-pipeline: a failing gate stops the pipeline and is captured in its log', async () => {
  const { runVerification, readGateLog } = await core.gates();
  const cwd = tempDir('sdlc-gates-fail-');
  try {
    const calls = [];
    const runner = (argv) => {
      calls.push(argv.join(' '));
      if (argv.join(' ').includes('lint')) {
        return { status: 2, stdout: 'linting...', stderr: 'FAIL src/api/x.ts: unexpected token' };
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const result = runVerification({
      cwd,
      gates: ['syntax', 'lint', 'unit', 'integration'],
      config: configFor(CONFIGURED),
      runner,
      taskId: 'TEST-002',
      changedFiles: ['src/api/a.ts'],
    });

    assert.equal(result.overall, 'fail');
    assert.equal(result.gates.syntax.status, 'pass');
    assert.equal(result.gates.lint.status, 'fail:2');
    assert.equal(result.gates.lint.exitCode, 2);
    assert.equal(result.gates.unit, undefined, 'fail-fast: later gates are not run');
    assert.equal(result.gates.integration, undefined);
    assert.deepEqual(calls, ['node --check src/api/a.ts', 'npm run lint']);
    assert.equal(result.firstFailure.gate, 'lint');
    assert.match(result.gates.lint.signature, /^lint:[0-9a-f]{40}$/);

    const log = readGateLog(join(cwd, '.sdlc', 'verification', 'TEST-002', 'lint.log'));
    assert.match(log, /FAIL src\/api\/x\.ts: unexpected token/);
    assert.match(log, /# exit 2/);

    // NEGATIVE CONTROL: the verifier rejects a run with a failing gate.
    const { decideAcceptance } = await core.verifier();
    const decision = decideAcceptance({
      riskClass: 'R2',
      gateResults: result.gates,
      scope: { ok: true, code: 'IN_SCOPE' },
      review: { verdict: 'accept' },
      filesChanged: ['src/api/x.ts', 'tests/api.test.ts'],
    });
    assert.equal(decision.accept, false);
    assert.equal(decision.code, 'GATE_FAILED');
  } finally {
    cleanup(cwd);
  }
});

test('verification-pipeline: skipped gates are recorded as `skipped:<reason>`', async () => {
  const { runVerification } = await core.gates();
  const cwd = tempDir('sdlc-gates-skip-');
  try {
    const result = runVerification({
      cwd,
      gates: ['syntax', 'lint', 'unit', 'visual'],
      config: configFor({
        syntax: { command: ['node', '--check', '{file}'] },
        lint: false,
        unit: { command: ['npm', 'test'], skip: true, reason: 'no-tests' },
        visual: { kind: 'playwright' },
      }),
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
      skipGates: ['syntax'],
      taskId: 'TEST-003',
    });
    assert.equal(result.gates.syntax.status, 'skipped:policy');
    assert.equal(result.gates.lint.status, 'skipped:not-configured');
    assert.equal(result.gates.unit.status, 'skipped:no-tests');
    assert.equal(result.gates.visual.status, 'skipped:playwright');
    assert.equal(result.overall, 'pass', 'skipped gates are not failures');
  } finally {
    cleanup(cwd);
  }
});
