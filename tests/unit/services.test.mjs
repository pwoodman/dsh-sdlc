/**
 * tests/unit/services.test.mjs — the DSH service wiring (spec v3 C.2, C.4, P23).
 *
 * The runtime is the single writer to sdlc.db; every declared row must share
 * ONE Runtime per project root. These tests drive the host-facing module with
 * a fake ctx — no DSH boot, no network, temp dirs only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, tempDir, cleanup, ROOT } from '../lib/helpers.mjs';

const services = await load('packages/sdlc-core/src/services.js');

const CFG = (projectRoot, extra = {}) => ({
  projectRoot,
  storage: { dbPath: '.sdlc/sdlc.db' },
  safety: { instanceLock: false },
  ...extra,
});

const fakeCtx = () => {
  const provided = [];
  return {
    provided,
    provide: (name, value) => provided.push([name, value]),
    logger: { debug() {}, warn() {}, error() {} },
  };
};

test('apply(service=tasks) opens the db, provides sdlc.tasks and exposes the runtime', () => {
  const dir = tempDir('sdlc-services-apply-');
  try {
    const ctx = fakeCtx();
    // apply() is the loader entry and returns nothing: the Cordis runner
    // interprets a plugin return value as an effect. The runtime handle comes
    // from the same per-project-root singleton apply creates.
    assert.equal(services.apply(ctx, CFG(dir, { service: 'tasks' })), undefined);
    const runtime = services.getRuntime(CFG(dir, { service: 'tasks' }), { projectRoot: dir });

    assert.ok(runtime, 'getRuntime exposes the Runtime apply created');
    assert.equal(runtime.projectRoot, dir);
    assert.ok(runtime.db, 'the runtime opened a database');
    assert.equal(runtime.db.isOpen, true);
    assert.equal(ctx.provided.length, 1);
    assert.equal(ctx.provided[0][0], 'sdlc.tasks');
    assert.equal(ctx.provided[0][1].service, 'tasks');
    assert.equal(ctx.provided[0][1].runtime, runtime);
  } finally {
    services.closeRuntime(dir);
    cleanup(dir);
  }
});

test('a second apply for the same project root reuses the runtime (single writer)', () => {
  const dir = tempDir('sdlc-services-once-');
  try {
    const ctx = fakeCtx();
    const config = CFG(dir, { service: 'tasks' });
    services.apply(ctx, config);
    const first = services.getRuntime(config, { projectRoot: dir });
    const dbBefore = first.db;

    services.apply(ctx, config);
    const second = services.getRuntime(config, { projectRoot: dir });
    assert.equal(second, first, 'the SAME runtime object is reused');
    assert.equal(second.db, dbBefore, 'the database was not reopened');
    assert.equal(second.db.isOpen, true);

    // and getRuntime agrees with apply's cache
    assert.equal(services.getRuntime(config, { projectRoot: dir }), first);
  } finally {
    services.closeRuntime(dir);
    cleanup(dir);
  }
});

test('makeService exposes exactly the documented methods, bound to the runtime', () => {
  const dir = tempDir('sdlc-services-api-');
  try {
    services.apply(fakeCtx(), CFG(dir, { service: 'tasks' }));
    const runtime = services.getRuntime({}, { projectRoot: dir });
    const expected = {
      tasks: ['addTask', 'getTask', 'listTasks', 'projectTasks', 'proposeTransition', 'transition'],
      scheduler: ['canDispatch', 'guardFor', 'spentTotals'],
      router: ['recordModelRun', 'route'],
      verifier: ['ingestResult', 'recordTestResults'],
      integration: ['listTasks'],
      evidence: ['assertIntegrity', 'getEvents'],
      escalation: ['listDecisions', 'recordDecision'],
      'worker-mgr': ['finishWorkerRun', 'getWorkerRun', 'listWorkerRuns', 'startWorkerRun'],
      recovery: ['getEvents', 'listTasks'],
    };

    for (const [name, methods] of Object.entries(expected)) {
      const api = services.makeService(runtime, name);
      assert.equal(api.service, name);
      assert.equal(api.runtime, runtime);
      assert.equal(api.config, runtime.config);
      const exposed = Object.keys(api).filter((k) => !['service', 'runtime', 'config'].includes(k)).sort();
      assert.deepEqual(exposed, methods, `${name} exposes the documented methods`);
      for (const m of methods) assert.equal(typeof api[m], 'function', `${name}.${m} is a function`);
    }

    // Destructuring proves the methods are bound (no `this` loss).
    const { getTask } = services.makeService(runtime, 'tasks');
    assert.equal(getTask('X'), null);

    const { startWorkerRun, getWorkerRun } = services.makeService(runtime, 'worker-mgr');
    const runId = startWorkerRun({ taskId: 'T-X', attempt: 1 });
    assert.equal(typeof runId, 'string');
    assert.equal(getWorkerRun(runId).task_id, 'T-X');
  } finally {
    services.closeRuntime(dir);
    cleanup(dir);
  }
});

test('makeService omits runtime methods that do not exist (no phantom API)', () => {
  const dir = tempDir('sdlc-services-phantom-');
  try {
    services.apply(fakeCtx(), CFG(dir, { service: 'tasks' }));
    const runtime = services.getRuntime({}, { projectRoot: dir });
    const api = services.makeService(runtime, 'not-a-service');
    assert.deepEqual(Object.keys(api).sort(), ['config', 'runtime', 'service']);
  } finally {
    services.closeRuntime(dir);
    cleanup(dir);
  }
});

test('getRuntime caches per project root; closeRuntime closes and evicts', () => {
  const a = tempDir('sdlc-rt-a-');
  const b = tempDir('sdlc-rt-b-');
  try {
    const rtA = services.getRuntime({}, { projectRoot: a });
    assert.equal(services.getRuntime({}, { projectRoot: a }), rtA, 'cached per root');
    const rtB = services.getRuntime({}, { projectRoot: b });
    assert.notEqual(rtB, rtA, 'different roots get different runtimes');

    services.getRuntime(CFG(a), { projectRoot: a }).open();
    services.closeRuntime(a);
    assert.notEqual(services.getRuntime({}, { projectRoot: a }), rtA, 'closeRuntime evicts the cache entry');

    services.closeRuntime(a);
    services.closeRuntime(b);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test('SERVICE_NAMES matches the 9 rows declared in packages/sdlc-core/cordis.patch.yml', () => {
  const text = readFileSync(join(ROOT, 'packages/sdlc-core/cordis.patch.yml'), 'utf8');
  const declared = [...text.matchAll(/^\s*service:\s*([A-Za-z0-9_-]+)\s*$/gm)].map((m) => m[1]);
  assert.equal(declared.length, 9, 'the patch declares exactly nine service rows');
  assert.deepEqual([...services.SERVICE_NAMES].sort(), [...declared].sort());
});

test('apply with no service provides sdlc.runtime and contributes the full service set', () => {
  const dir = tempDir('sdlc-services-runtime-');
  try {
    const ctx = fakeCtx();
    services.apply(ctx, CFG(dir));
    const runtime = services.getRuntime(CFG(dir), { projectRoot: dir });
    assert.equal(ctx.provided.length, 1);
    assert.equal(ctx.provided[0][0], 'sdlc.runtime');
    assert.equal(ctx.provided[0][1], runtime);
    assert.ok(runtime.db.isOpen);
  } finally {
    services.closeRuntime(dir);
    cleanup(dir);
  }
});
