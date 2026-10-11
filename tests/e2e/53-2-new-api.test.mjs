/**
 * tests/e2e/53-2-new-api.test.mjs — §53 Test 2, New API endpoint (spec v3 K.8, D.1).
 *
 * "Add GET /api/customers" must produce a DAG with ≥2 tasks and a dependency,
 * implement sequentially because both tasks share the `package.json` resource,
 * run unit+integration+api gates, and merge into `sdlc/integration` with a
 * `sdlc: accept` merge commit.
 *
 * Runtime evidence asserted: `task_dependencies`, `task_resources`, the
 * `scheduler.planStep` decisions, `test_results`, `tasks.state`, and git.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M, createHarness, addTasks, schedule, planNow, stageTaskWork, runAttempt,
  mergeAcceptedTask, makeMock, modelDecision, gatewayEvidence, dependencyRows, resourceRows,
} from './harness.mjs';
import { git } from '../lib/helpers.mjs';

const { scheduler, presets } = M;

const API_GATE = { api: { command: ['node', '--test', 'api'] } };

test('§53 Test 2: new API endpoint — DAG, resource-serialized impl, api gate, integration merge', async () => {
  const h = await createHarness({ gateCommands: API_GATE });
  try {
    const mock = makeMock();
    const plan = modelDecision(mock, 'mock/plan-api');
    assert.ok(plan.tasks.length >= 2, 'planner must decompose into ≥2 tasks');

    addTasks(h, plan.tasks);

    // ── DAG persisted with a real dependency ───────────────────────────────
    assert.deepEqual(dependencyRows(h), [{ task_id: 'API-001', depends_on: 'DB-001' }]);
    assert.deepEqual(resourceRows(h), [
      { task_id: 'API-001', resource: 'package.json' },
      { task_id: 'DB-001', resource: 'package.json' },
    ]);

    // ── sequential implementation driven by the dependency ─────────────────
    const first = schedule(h);
    const firstTargets = first.map((t) => `${t.taskId}→${t.to}`);
    assert.ok(firstTargets.includes('DB-001→ASSIGNED'), `DB-001 must be dispatched first: ${firstTargets}`);
    assert.ok(!firstTargets.includes('API-001→ASSIGNED'), 'the dependent must not be dispatched before its dep is DONE');
    assert.equal(h.runtime.getTask('API-001').state, 'BACKLOG');

    // ── the same shared resource serializes independent READY tasks ────────
    const projected = [
      { id: 'API-001', state: 'READY', allowed_paths: ['src/api/**'], resources: ['package.json'], depends_on: [] },
      { id: 'DB-001', state: 'READY', allowed_paths: ['src/db/**'], resources: ['package.json'], depends_on: [] },
    ];
    const shared = scheduler.planStep({ tasks: projected }, { maxSharedResourceTasks: 1 });
    const assigned = shared.filter((t) => t.to === 'ASSIGNED');
    assert.equal(assigned.length, 1, `exactly one holder of package.json: ${JSON.stringify(shared)}`);
    const assignedTask = projected.find((t) => t.id === assigned[0].taskId);
    const other = projected.find((t) => t.id !== assigned[0].taskId);
    const held = scheduler.locksGrantable(other, [{ ...assignedTask, state: 'ASSIGNED' }]);
    assert.equal(held.ok, false, JSON.stringify(held));
    assert.match(held.reason, /resource package\.json locked by/);

    // ── DB-001: unit + integration gates, then merge ───────────────────────
    const dbWork = stageTaskWork(h, {
      taskId: 'DB-001',
      files: {
        'migrations/001_customers.sql': 'CREATE TABLE customers (id INTEGER PRIMARY KEY);\n',
        'src/db/customers.test.mjs': "import { test } from 'node:test';\ntest('customers', () => {});\n",
      },
    });
    const dbAttempt = runAttempt(h, {
      taskId: 'DB-001',
      filesChanged: dbWork.filesChanged,
      review: modelDecision(mock, 'mock/review-accept'),
      branch: dbWork.branch,
    });
    assert.equal(dbAttempt.decision.accept, true, JSON.stringify(dbAttempt.decision));
    const dbGates = Object.fromEntries(Object.entries(dbAttempt.gateResults.gates).map(([g, r]) => [g, r.status]));
    assert.equal(dbGates.unit, 'pass');
    assert.equal(dbGates.integration, 'pass');
    mergeAcceptedTask(h, { taskId: 'DB-001', branch: dbWork.branch });

    // ── the dependent becomes schedulable only after DB-001 is DONE ────────
    assert.equal(h.runtime.getTask('DB-001').state, 'DONE');
    const second = schedule(h);
    const secondTargets = second.map((t) => `${t.taskId}→${t.to}`);
    assert.ok(secondTargets.includes('API-001→READY'), `dependent READY after dep DONE: ${secondTargets}`);
    assert.ok(secondTargets.includes('API-001→ASSIGNED'));

    // ── API-001: unit + integration + api gates ────────────────────────────
    const apiTask = h.runtime.getTask('API-001');
    assert.ok(apiTask.verification.includes('api'), 'the task contract requires the api gate');
    const apiWork = stageTaskWork(h, {
      taskId: 'API-001',
      files: {
        'src/api/customers.js': 'export const list = () => [];\n',
        'src/api/customers.test.js': 'test("list", () => {});\n',
      },
    });
    const apiAttempt = runAttempt(h, {
      taskId: 'API-001',
      filesChanged: apiWork.filesChanged,
      review: modelDecision(mock, 'mock/review-accept'),
      branch: apiWork.branch,
    });
    assert.equal(apiAttempt.decision.accept, true, JSON.stringify(apiAttempt.decision));
    const apiGates = Object.fromEntries(Object.entries(apiAttempt.gateResults.gates).map(([g, r]) => [g, r.status]));
    assert.equal(apiGates.unit, 'pass');
    assert.equal(apiGates.integration, 'pass');
    assert.equal(apiGates.api, 'pass', `api gate must have run: ${JSON.stringify(apiAttempt.gateResults.gates)}`);
    mergeAcceptedTask(h, { taskId: 'API-001', branch: apiWork.branch });

    // ── runtime evidence: both tasks DONE, merged with accept commits ──────
    const tasks = h.runtime.listTasks({ projectId: h.projectId });
    assert.ok(tasks.length >= 2);
    assert.deepEqual(tasks.map((t) => t.state), ['DONE', 'DONE']);
    const log = git(['log', '--format=%s', 'sdlc/integration'], h.repo).split('\n');
    assert.equal(log.filter((m) => m.startsWith('sdlc: accept')).length, 2, `merge commits: ${log}`);
    assert.ok(log.includes('sdlc: accept DB-001 (Add customers table)'));
    assert.ok(log.includes('sdlc: accept API-001 (GET /api/customers)'));
    const tags = git(['tag', '--list', 'sdlc/accepted/*'], h.repo).split('\n').filter(Boolean).sort();
    assert.deepEqual(tags, ['sdlc/accepted/API-001', 'sdlc/accepted/DB-001']);
    assert.equal(gatewayEvidence(h, 'API-001').find((r) => r.gate === 'api').status, 'pass');

    // ── team composition: only assigned roles are active ───────────────────
    assert.deepEqual([...new Set(tasks.map((t) => t.role))].sort(), ['api-engineer', 'database-engineer']);
    assert.ok(presets.ROLES.length === 26);
    assert.equal(planNow(h).length, 0, 'the DAG has reached a fixed point');
  } finally {
    h.close();
  }
});
