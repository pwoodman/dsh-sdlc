/**
 * tests/contract/task-contract.test.mjs — L3/B.3.1.
 *
 * The task contract fixture is schema-validated, then round-tripped through the
 * real Runtime (node:sqlite in a temp dir, `useLock:false`) so the contract the
 * planner writes is the contract the runtime reads back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { core, tempDir, cleanup } from '../lib/helpers.mjs';
import { taskContractSchema, validate, formatErrors } from './schemas.mjs';
import { loadFixture } from './fixture-util.mjs';

const fixture = loadFixture('task-contract.valid.json');

function openRuntime() {
  const dir = tempDir('sdlc-contract-');
  return core.runtime().then(({ Runtime }) => {
    const dbPath = join(dir, '.sdlc', 'sdlc.db');
    const runtime = new Runtime({ projectRoot: dir, config: {}, useLock: false, dbPath }).open();
    return { dir, runtime, dbPath };
  });
}

/** Reshape a persisted task row back into the B.3.1 contract surface. */
function asContract(task) {
  return {
    id: task.id,
    title: task.title,
    objective: task.objective,
    role: task.role,
    depends_on: task.depends_on,
    risk_class: task.risk_class,
    acceptance_criteria: task.acceptance_criteria,
    allowed_paths: task.allowed_paths,
    forbidden_paths: task.forbidden_paths,
    verification: task.verification,
    estimate: task.estimate,
  };
}

test('B.3.1 fixture is schema-valid', () => {
  const result = validate(taskContractSchema, fixture);
  assert.ok(result.ok, formatErrors(result, 'task contract fixture'));
});

test('B.3.1 contract shape rejects a string where a glob list belongs', () => {
  const broken = { ...fixture, allowed_paths: 'src/customers/**' };
  const result = validate(taskContractSchema, broken);
  assert.equal(result.ok, false, 'allowed_paths must be an array of globs');
  assert.ok(result.errors.some((e) => e.path.endsWith('.allowed_paths')));
});

test('Runtime.addTask + getTask round-trip a B.3.1 contract', async () => {
  const { dir, runtime } = await openRuntime();
  try {
    runtime.createProject({ id: 'P1', name: 'contract round-trip' });

    // `budgets` omitted: defaults are risk-derived (see the dedicated test below).
    const { budgets, ...contract } = fixture;
    const stored = runtime.addTask({ ...contract, project_id: 'P1', resources: ['package.json'] });
    const read = runtime.getTask('API-042');

    assert.ok(stored, 'addTask returns the stored row');
    assert.ok(read, 'getTask returns the stored row');
    assert.equal(read.id, 'API-042');
    assert.equal(read.project_id, 'P1');
    assert.equal(read.title, fixture.title);
    assert.equal(read.objective, fixture.objective);
    assert.equal(read.role, fixture.role);
    assert.equal(read.state, 'BACKLOG');
    assert.equal(read.risk_class, 'R2');
    assert.deepEqual(read.acceptance_criteria, fixture.acceptance_criteria);
    assert.deepEqual(read.allowed_paths, fixture.allowed_paths);
    assert.deepEqual(read.forbidden_paths, fixture.forbidden_paths);
    assert.deepEqual(read.verification, fixture.verification);
    assert.deepEqual(read.estimate, fixture.estimate);
    assert.deepEqual([...read.depends_on].sort(), [...fixture.depends_on].sort());
    assert.deepEqual(read.resources, ['package.json']);

    // The persisted row, reshaped to the contract surface, is schema-valid.
    const result = validate(taskContractSchema, asContract(read));
    assert.ok(result.ok, formatErrors(result, 'round-tripped contract'));
  } finally {
    runtime.close();
    cleanup(dir);
  }
});

test('B.3.1 budgets: risk-derived default and explicit per-task override', async () => {
  const { dir, runtime } = await openRuntime();
  try {
    // No budgets given: R2 default is maxAttempts 3 (budget.js RISK_BUDGET_DEFAULTS).
    const noBudget = runtime.addTask({ ...fixture, id: 'API-100', budgets: undefined });
    assert.equal(noBudget.retry_budget, 3, 'R2 default maxAttempts is 3');

    // Explicit override uses the Runtime's own camelCase budget shape.
    const overridden = runtime.addTask({ ...fixture, id: 'API-101', budgets: { maxAttempts: 4 } });
    assert.equal(overridden.retry_budget, 4);
    assert.equal(overridden.risk_class, 'R2');
  } finally {
    runtime.close();
    cleanup(dir);
  }
});

test('Runtime persists tasks inside the temp project root only', async () => {
  const { dir, runtime, dbPath } = await openRuntime();
  try {
    runtime.addTask({ ...fixture, id: 'API-200', budgets: undefined });
    assert.ok(existsSync(dbPath), 'db file exists in the temp dir');
    assert.ok(dbPath.startsWith(dir), 'db path is under the temp project root');
  } finally {
    runtime.close();
    cleanup(dir);
  }
});

// ── negative controls ──────────────────────────────────────────────────────

test('negative control: getTask of an unknown id is null, never a fabricated row', async () => {
  const { dir, runtime } = await openRuntime();
  try {
    assert.equal(runtime.getTask('NOPE-999'), null);
  } finally {
    runtime.close();
    cleanup(dir);
  }
});

test('negative control: re-adding the same task id is rejected by the primary key', async () => {
  const { dir, runtime } = await openRuntime();
  try {
    const { budgets, ...contract } = fixture;
    runtime.addTask({ ...contract, id: 'API-300' });
    assert.throws(() => runtime.addTask({ ...contract, id: 'API-300' }), /UNIQUE|constraint|PRIMARY/i);
    assert.equal(runtime.listTasks().filter((t) => t.id === 'API-300').length, 1, 'no duplicate row');
  } finally {
    runtime.close();
    cleanup(dir);
  }
});
