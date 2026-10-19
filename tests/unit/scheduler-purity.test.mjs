/**
 * tests/unit/scheduler-purity.test.mjs — planStep must not mutate the caller's
 * task snapshot. A second plan from the same snapshot used to behave as if the
 * first plan had already been applied to the database.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const scheduler = await core.scheduler();

function snapshot() {
  return [
    { id: 'A', state: 'READY', allowed_paths: ['src/a/**'], resources: ['package.json'], depends_on: [] },
    { id: 'B', state: 'READY', allowed_paths: ['src/b/**'], resources: ['package.json'], depends_on: [] },
    { id: 'C', state: 'BACKLOG', allowed_paths: ['src/c/**'], resources: [], depends_on: ['A'] },
  ];
}

test('planStep leaves the input snapshot byte-identical', () => {
  const input = snapshot();
  const before = JSON.stringify(input);
  scheduler.planStep({ tasks: input }, { maxParallelWorkers: 2 });
  assert.equal(JSON.stringify(input), before, 'input was mutated');
});

test('two plans from the same snapshot grant a shared resource only once', () => {
  const input = snapshot();
  const first = scheduler.planStep({ tasks: input }, { maxParallelWorkers: 2 });
  const second = scheduler.planStep({ tasks: input }, { maxParallelWorkers: 2 });
  const assignedFirst = first.filter((t) => t.to === 'ASSIGNED').map((t) => t.taskId);
  const assignedSecond = second.filter((t) => t.to === 'ASSIGNED').map((t) => t.taskId);
  assert.deepEqual(assignedFirst, assignedSecond, 'replaying the same snapshot is deterministic');
  assert.equal(assignedFirst.length, 1, 'package.json has one holder');
});

test('NEGATIVE CONTROL: disjoint resources can both be assigned', () => {
  const input = snapshot();
  input[1].resources = ['tsconfig.json'];
  const transitions = scheduler.planStep({ tasks: input }, { maxParallelWorkers: 2 });
  assert.equal(transitions.filter((t) => t.to === 'ASSIGNED').length, 2);
});
