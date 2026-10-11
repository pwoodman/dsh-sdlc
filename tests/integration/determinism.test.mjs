/**
 * tests/integration/determinism.test.mjs — spec v3 K.6 (L4).
 *
 * 1. Plan determinism: the same 2-task drive-to-DONE run twice against
 *    identical fresh state produces byte-equal normalized `events`.
 * 2. Score determinism: 100 runs of `computeComplexity` ⇒ exactly one score.
 * 3. Diff determinism: `deriveWorkerResult` twice ⇒ identical
 *    `files_changed` / `out_of_scope_files`.
 * 4. Routing determinism: the router choice is a pure function of the task
 *    contract (and cannot be moved by a different, equivalent router instance).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir, cleanup, sampleTaskGraph, driveToDone } from '../lib/helpers.mjs';
import { normalizeEvents, eventStreamKey, diffStreams } from '../lib/normalize-events.mjs';

async function driveOnce() {
  const root = tempDir('sdlc-det-');
  const { Runtime } = await core.runtime();
  const rt = new Runtime({ projectRoot: root, config: {}, useLock: true });
  try {
    rt.open();
    rt.createProject({ id: 'P1', name: 'determinism' });
    for (const task of sampleTaskGraph('P1')) rt.addTask(task);
    driveToDone(rt, 'DB-001');
    driveToDone(rt, 'API-001');
    return rt.getEvents();
  } finally {
    rt.close();
    cleanup(root);
  }
}

test('determinism: identical runs produce byte-equal normalized events', async () => {
  const a = eventStreamKey(normalizeEvents(await driveOnce()));
  const b = eventStreamKey(normalizeEvents(await driveOnce()));
  const c = eventStreamKey(normalizeEvents(await driveOnce()));
  if (a !== b) assert.fail(JSON.stringify(diffStreams(a, b).slice(0, 5), null, 2));
  assert.equal(a, b);
  assert.equal(b, c);
  assert.ok(a.split('\n').length >= 15, 'the DAG run emits the expected event volume');
});

test('determinism: computeComplexity is a fixed point (100 runs ⇒ one score)', async () => {
  const { computeComplexity, WEIGHTS, normalizeFeature } = await core.complexity();
  const input = { domains: 2, files: 8, integrations: 1, external_deps: 0, testing: 0.5, db: true, sec: false, ui: false, dep: true };
  const scores = new Set();
  for (let i = 0; i < 100; i += 1) scores.add(computeComplexity(input).score);
  assert.equal(scores.size, 1, `expected exactly one score, got ${scores.size}`);

  const total = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  assert.equal(Number(total.toFixed(6)), 1);
  const { score } = computeComplexity(input);
  assert.ok(score >= 0 && score <= 1);
  assert.equal(normalizeFeature('files', 1), Math.log(2) / Math.log(201));
});

test('determinism: deriveWorkerResult is a pure function of (diff, contract, claims)', async () => {
  const { deriveWorkerResult, scopeVerdict } = await core.workerResult();
  const input = {
    filesChanged: ['src/api/x.ts', '.sdlc/task-outbox.json', 'src/auth/login.ts'],
    contract: { allowed_paths: ['src/api/**'], forbidden_paths: [] },
    claims: { status: 'completed', summary: 'done' },
    runtime: { exitCode: 0, turnEndReason: 'completed' },
  };
  const one = deriveWorkerResult(input);
  const two = deriveWorkerResult(input);
  assert.deepEqual(one.files_changed, two.files_changed);
  assert.deepEqual(one.out_of_scope_files, two.out_of_scope_files);
  assert.deepEqual(one.out_of_scope_files, ['src/auth/login.ts']);
  assert.deepEqual(one.files_changed, ['src/api/x.ts', 'src/auth/login.ts']);
  assert.deepEqual(scopeVerdict(one), scopeVerdict(two));
});

test('determinism: router choice is a pure function of the task contract', async () => {
  const { ModelRouter } = await core.router();
  const options = {
    tiers: {
      cheap: [{ provider: 'p', model: 'cheap-1' }],
      base: [{ provider: 'p', model: 'base-1' }, { provider: 'q', model: 'base-2' }],
      elevated: [{ provider: 'r', model: 'elev-1' }],
    },
    pricing: {
      'p/cheap-1': { input: 0.1, output: 0.1 },
      'p/base-1': { input: 1, output: 1 },
      'q/base-2': { input: 1, output: 1 },
      'r/elev-1': { input: 5, output: 5 },
    },
    history: {},
    capabilities: {},
    config: {},
  };
  const a = new ModelRouter(structuredClone(options));
  const b = new ModelRouter(structuredClone(options));
  const contract = { id: 'T-1', task_class: 'trivial', attempt: 0, task_type: 'impl' };

  const first = a.route(contract);
  assert.deepEqual(first, b.route(structuredClone(contract)));
  assert.deepEqual(a.route(contract), first, 'same router + same contract ⇒ same decision');
  assert.equal(first.tier, 'cheap');
  assert.equal(first.rule, 6);

  const architectural = a.route({ id: 'T-2', task_class: 'architectural', complexity: 0.7, attempt: 0 });
  assert.equal(architectural.tier, 'elevated');
  assert.equal(architectural.rule, 8);

  // NEGATIVE CONTROL: an unsatisfiable capability is NO_ELIGIBLE_MODEL.
  const impossible = a.route({ id: 'T-3', requires: ['quantum-gpu'], task_class: 'normal', attempt: 0 });
  assert.equal(impossible.tier, null);
  assert.equal(impossible.reason, 'NO_ELIGIBLE_MODEL');
});
