/**
 * tests/unit/scheduler-cap.test.mjs — the resource CAP in `checkNoOverlap` (B.10/K.3).
 *
 * Regression guard: `maxSharedResourceTasks` is a CAP. With a cap above 1 the
 * old checker returned no violations at all, so a genuine overrun (three tasks
 * holding one resource against a cap of two) was invisible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const s = await core.scheduler();

function task(id, state, allowed_paths = [], resources = []) {
  return { id, state, allowed_paths, resources };
}

test('cap 1: two holders of one resource is reported with the documented shape', () => {
  const tasks = [
    task('DB-001', 'ASSIGNED', ['src/db/**'], ['package.json']),
    task('API-001', 'IN_PROGRESS', ['src/api/**'], ['package.json']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 1 });
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    kind: 'resource-collision',
    a: 'DB-001',
    b: 'API-001',
    resources: ['package.json'],
  });
});

test('cap 2: two holders is exactly at the cap and is legal', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json']),
    task('B', 'IN_PROGRESS', ['src/b/**'], ['package.json']),
  ];
  assert.deepEqual(s.checkNoOverlap(tasks, { maxSharedResourceTasks: 2 }), []);
});

test('cap 2: three holders exceeds the cap and IS reported (the old blind spot)', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json']),
    task('B', 'IN_PROGRESS', ['src/b/**'], ['package.json']),
    task('C', 'VERIFYING', ['src/c/**'], ['package.json']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 2 });
  assert.equal(violations.length, 1, `expected one cap breach, got ${JSON.stringify(violations)}`);
  assert.equal(violations[0].kind, 'resource-collision');
  assert.deepEqual(violations[0].holders, ['A', 'B', 'C']);
  assert.equal(violations[0].cap, 2);
  assert.deepEqual(violations[0].resources, ['package.json']);
});

test('cap 3: three holders is exactly at the cap and is legal', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json']),
    task('B', 'IN_PROGRESS', ['src/b/**'], ['package.json']),
    task('C', 'VERIFYING', ['src/c/**'], ['package.json']),
  ];
  assert.deepEqual(s.checkNoOverlap(tasks, { maxSharedResourceTasks: 3 }), []);
});

test('path ownership overlap is independent of the resource cap', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/**']),
    task('B', 'IN_PROGRESS', ['src/api/**']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 5 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'ownership-overlap');
});

test('multiple distinct overrun resources each produce their own violation', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json', 'tsconfig.json']),
    task('B', 'IN_PROGRESS', ['src/b/**'], ['package.json', 'tsconfig.json']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 1 });
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.resources[0]).sort(), ['package.json', 'tsconfig.json']);
});
