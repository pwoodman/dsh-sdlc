/**
 * tests/unit/scheduler.test.mjs — scheduling & the no-overlap invariant (spec v3 B.10, §19–21, K.3).
 *
 * The highest-value property in Part K: over randomly generated DAGs, no two
 * concurrently ASSIGNED tasks may have overlapping `allowed_paths` or share a
 * `task_resources` entry. Plus a deliberate negative control.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, mulberry32, intBetween } from '../lib/helpers.mjs';

const s = await core.scheduler();

function task(id, state, allowed, resources = [], depends_on = []) {
  return { id, state, allowed_paths: allowed, resources, depends_on };
}

test('glob overlap: ** covers a deeper path, disjoint roots do not overlap', () => {
  assert.equal(s.globsOverlap('src/a/**', 'src/a/b.ts'), true);
  assert.equal(s.globsOverlap('src/**', 'src/a/b.ts'), true);
  assert.equal(s.globsOverlap('src/a/**', 'src/b/**'), false);
  assert.equal(s.globsOverlap('tests/x.ts', 'src/**'), false);
  assert.equal(s.globsOverlap('**', 'anything/at/all.ts'), true);
  assert.equal(s.globsOverlap('src/a.ts', 'src/a.ts'), true);
});

test('resource serialization: two tasks sharing package.json are never both active', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json']),
    task('B', 'ASSIGNED', ['src/b/**'], ['package.json']),
  ];
  const violations = s.checkNoOverlap(tasks, { maxSharedResourceTasks: 1 });
  assert.equal(violations.some((v) => v.kind === 'resource-collision'), true);
});

test('NEGATIVE CONTROL: the invariant reports nothing when the collision is removed', () => {
  const tasks = [
    task('A', 'ASSIGNED', ['src/a/**'], ['package.json']),
    task('B', 'ASSIGNED', ['src/b/**'], ['tsconfig.json']),
  ];
  assert.deepEqual(s.checkNoOverlap(tasks, { maxSharedResourceTasks: 1 }), []);
});

test('ownership overlap is detected across active tasks', () => {
  const tasks = [
    task('A', 'IN_PROGRESS', ['src/**']),
    task('B', 'VERIFYING', ['src/api/**']),
  ];
  const violations = s.checkNoOverlap(tasks);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'ownership-overlap');
});

test('locksGrantable refuses a second holder for a taken resource', () => {
  const tasks = [task('A', 'ASSIGNED', ['src/a/**'], ['package.json'])];
  const res = s.locksGrantable(task('B', 'READY', ['src/b/**'], ['package.json']), tasks);
  assert.equal(res.ok, false);
  assert.match(res.reason, /resource package\.json locked by A/);
});

test('planStep: dependency ordering — a dependent stays BACKLOG until its dependency is DONE', () => {
  const tasks = [
    task('DB-001', 'BACKLOG', ['src/db/**'], ['package.json']),
    task('API-001', 'BACKLOG', ['src/api/**'], ['package.json'], ['DB-001']),
  ];
  let step = s.planStep({ tasks });
  assert.deepEqual(step.filter((t) => t.to === 'READY').map((t) => t.taskId), ['DB-001']);
  assert.equal(step.some((t) => t.taskId === 'API-001'), false, 'dependent must not become READY');

  step = s.planStep({ tasks: [{ ...tasks[0], state: 'DONE' }, tasks[1]] });
  assert.deepEqual(step.filter((t) => t.to === 'READY').map((t) => t.taskId), ['API-001']);
});

test('planStep: a failed dependency blocks the dependent', () => {
  const tasks = [
    task('DB-001', 'FAILED', ['src/db/**']),
    task('API-001', 'BACKLOG', ['src/api/**'], [], ['DB-001']),
  ];
  const step = s.planStep({ tasks });
  const blocked = step.find((t) => t.taskId === 'API-001');
  assert.equal(blocked.to, 'BLOCKED');
});

test('planStep: concurrency cap is respected', () => {
  const tasks = [
    task('A', 'READY', ['src/a/**']),
    task('B', 'READY', ['src/b/**']),
    task('C', 'READY', ['src/c/**']),
  ];
  const step = s.planStep({ tasks }, { maxParallelWorkers: 2 });
  assert.equal(step.filter((t) => t.to === 'ASSIGNED').length, 2);
});

test('planStep: resource-locked tasks serialize', () => {
  const tasks = [
    task('A', 'READY', ['src/a/**'], ['package.json']),
    task('B', 'READY', ['src/b/**'], ['package.json']),
  ];
  const step = s.planStep({ tasks }, { maxParallelWorkers: 8 });
  assert.equal(step.filter((t) => t.to === 'ASSIGNED').length, 1, 'only one holder of package.json');
});

test('topoSort orders dependencies first and rejects cycles', () => {
  const tasks = [task('C', 'BACKLOG', [], [], ['B']), task('B', 'BACKLOG', [], [], ['A']), task('A', 'BACKLOG', [])];
  assert.deepEqual(s.topoSort(tasks), ['A', 'B', 'C']);
  const cyclic = [task('A', 'BACKLOG', [], [], ['B']), task('B', 'BACKLOG', [], [], ['A'])];
  assert.equal(s.topoSort(cyclic), null);
});

test('effectiveParallelism: min(cores/2, ram/2, provider_limit, configured)', () => {
  assert.equal(s.effectiveParallelism({ maxParallelWorkers: 'auto', cpus: 8, ramGb: 16, providerLimit: 6, configured: 10 }), 4);
  assert.equal(s.effectiveParallelism({ maxParallelWorkers: 'auto', cpus: 8, ramGb: 16, providerLimit: 2, configured: 10 }), 2);
  assert.equal(s.effectiveParallelism({ maxParallelWorkers: 3, cpus: 64, ramGb: 64, providerLimit: Infinity, configured: Infinity }), 3);
  assert.equal(s.effectiveParallelism({ maxParallelWorkers: 'auto', cpus: 1, ramGb: 1, providerLimit: Infinity, configured: Infinity }), 1);
});

test('property (K.3): random DAGs never produce overlapping concurrent assignments', () => {
  const rng = mulberry32(4242);
  const roots = ['src/api', 'src/db', 'src/ui', 'src/auth', 'docs', 'tests'];
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const n = intBetween(rng, 2, 8);
    const tasks = [];
    for (let i = 0; i < n; i += 1) {
      const root = roots[intBetween(rng, 0, roots.length - 1)];
      const depends = i > 0 && rng() > 0.6 ? [tasks[i - 1].id] : [];
      const resources = rng() > 0.6 ? ['package.json'] : [];
      tasks.push(task(`T${i}`, rng() > 0.5 ? 'READY' : 'BACKLOG', [`${root}/**`], resources, depends));
    }
    let state = { tasks };
    for (let step = 0; step < 10; step += 1) {
      const transitions = s.planStep(state, { maxParallelWorkers: intBetween(rng, 1, 4) });
      for (const t of transitions) {
        state = { tasks: state.tasks.map((x) => (x.id === t.taskId ? { ...x, state: t.to } : x)) };
      }
      // Advance in-flight tasks deterministically to free resources.
      state = {
        tasks: state.tasks.map((x) => (x.state === 'ASSIGNED' && rng() > 0.5 ? { ...x, state: 'DONE' } : x)),
      };
      const violations = s.checkNoOverlap(state.tasks, { maxSharedResourceTasks: 1 });
      assert.deepEqual(violations, [], `iteration ${iteration} produced ${JSON.stringify(violations)}`);
    }
  }
});

test('recomputeReadiness derives BACKLOG → READY/BLOCKED from the dependency graph (B.12)', () => {
  const tasks = [
    task('A', 'DONE', ['src/a/**']),
    task('B', 'BACKLOG', ['src/b/**'], [], ['A']),
    task('C', 'BACKLOG', ['src/c/**'], [], ['D']),
    task('D', 'FAILED', ['src/d/**']),
    task('E', 'IN_PROGRESS', ['src/e/**']),
  ];
  const changes = s.recomputeReadiness(tasks);
  assert.deepEqual(changes.sort((a, b) => a.taskId.localeCompare(b.taskId)), [
    { taskId: 'B', from: 'BACKLOG', to: 'READY' },
    { taskId: 'C', from: 'BACKLOG', to: 'BLOCKED' },
  ]);
});
