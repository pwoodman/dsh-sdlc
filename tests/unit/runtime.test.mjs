/**
 * tests/unit/runtime.test.mjs — the orchestrator runtime (spec v3 C.2, C.5, B.2/B.3).
 *
 * Exercises the Runtime methods that the integration layer does NOT already
 * drive, on a fresh temp-dir project with a real `node:sqlite` database:
 * projects, tasks (both budget spellings), transitions, worker runs, result
 * ingestion (the RESULT_MALFORMED and `suspect` paths), model runs / spend
 * totals, dispatch budgets, the guard plugin, decisions, requirements, test
 * results, the event log, integrity, the instance lock, and router history
 * folding from persisted `model_runs` rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const { Runtime, RuntimeLockedError } = await core.runtime();
const { buildOutbox } = await core.workerResult();

function baseConfig(overrides = {}) {
  return {
    storage: { dbPath: '.sdlc/sdlc.db', requireQuickCheckOnOpen: true },
    safety: { instanceLock: false },
    budgets: {},
    tiers: {},
    pricing: {},
    ...overrides,
  };
}

function freshRuntime(prefix, config = baseConfig()) {
  const root = tempDir(prefix);
  const rt = new Runtime({ projectRoot: root, config });
  rt.open();
  return { root, rt };
}

// ── projects ────────────────────────────────────────────────────────────────

test('createProject / getProject / setProjectState round-trip a project row', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-project-');
  try {
    const created = rt.createProject({
      id: 'P1', name: 'demo project', complexity: { score: 5 }, budget: { maxCostUsd: 10 },
    });
    assert.equal(created.id, 'P1');
    assert.equal(created.name, 'demo project');
    assert.equal(created.state, 'DISCOVERY');
    assert.equal(created.repo_path, root);
    assert.equal(created.complexity_json, '{"score":5}');
    assert.equal(created.budget_json, '{"maxCostUsd":10}');

    assert.equal(rt.getProject('P1').id, 'P1');
    assert.equal(rt.getProject('missing'), null);

    // default name falls back to the id.
    rt.createProject({ id: 'P2' });
    assert.equal(rt.getProject('P2').name, 'P2');

    rt.setProjectState('P1', 'REQUIREMENTS');
    assert.equal(rt.getProject('P1').state, 'REQUIREMENTS');
    assert.equal(rt.getProject('P1').blocked_state, null);

    rt.setProjectState('P1', 'BLOCKED', { blockedState: 'PLANNING' });
    assert.equal(rt.getProject('P1').state, 'BLOCKED');
    assert.equal(rt.getProject('P1').blocked_state, 'PLANNING');
  } finally {
    rt.close();
    cleanup(root);
  }
});

// ── tasks ───────────────────────────────────────────────────────────────────

test('addTask accepts camelCase and snake_case budgets and persists derived fields', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-task-');
  try {
    rt.createProject({ id: 'P1', name: 'p' });

    const snake = rt.addTask({
      id: 'T-snake', project_id: 'P1', title: 'snake', objective: 'o', role: 'api-engineer',
      risk_class: 'R2', budgets: { max_attempts: 4, max_cost_usd: 2.5 },
      allowed_paths: ['src/**'], forbidden_paths: ['secret/**'], verification: ['unit'],
      acceptance_criteria: [{ id: 'AC1' }], depends_on: ['T0'], resources: ['package.json'],
      estimate: { hours: 1 }, plan_hash: 'ph-1',
    });
    assert.equal(snake.state, 'BACKLOG');
    assert.equal(snake.retry_budget, 4);
    assert.deepEqual(snake.allowed_paths, ['src/**']);
    assert.deepEqual(snake.forbidden_paths, ['secret/**']);
    assert.deepEqual(snake.verification, ['unit']);
    assert.deepEqual(snake.acceptance_criteria, [{ id: 'AC1' }]);
    assert.deepEqual(snake.depends_on, ['T0']);
    assert.deepEqual(snake.resources, ['package.json']);
    assert.deepEqual(snake.estimate, { hours: 1 });
    assert.equal(snake.plan_hash, 'ph-1');

    const camel = rt.addTask({
      id: 'T-camel', project_id: 'P1', risk_class: 'R1', budgets: { maxAttempts: 5, maxTokens: 123 },
    });
    assert.equal(camel.retry_budget, 5);

    // an unknown budget key fails closed with the contract guidance.
    assert.throws(
      () => rt.addTask({ id: 'T-bad', project_id: 'P1', budgets: { wibble: 1 } }),
      /unknown budget key.*wibble/,
    );

    assert.equal(rt.getTask('missing'), null);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('listTasks({state}) filters by state; projectTasks projects the documented shape', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-list-');
  try {
    rt.createProject({ id: 'P1', name: 'p' });
    rt.addTask({ id: 'T1', project_id: 'P1', allowed_paths: ['src/**'], resources: ['package.json'], risk_class: 'R2' });
    rt.addTask({ id: 'T2', project_id: 'P1', allowed_paths: ['api/**'], risk_class: 'R1' });

    assert.deepEqual(rt.listTasks().map((t) => t.id), ['T1', 'T2']);
    assert.deepEqual(rt.listTasks({ state: 'READY' }), []);
    assert.deepEqual(rt.listTasks({ state: 'BACKLOG' }).map((t) => t.id), ['T1', 'T2']);

    const moved = rt.transition('T1', 'READY', 'scheduler', { depStates: {} });
    assert.equal(moved.ok, true, moved.reason);
    assert.deepEqual(rt.listTasks({ state: 'READY' }).map((t) => t.id), ['T1']);
    assert.deepEqual(rt.listTasks({ state: 'BACKLOG' }).map((t) => t.id), ['T2']);

    assert.deepEqual(rt.projectTasks('P1'), [
      { id: 'T1', state: 'READY', allowed_paths: ['src/**'], resources: ['package.json'], depends_on: [], risk_class: 'R2' },
      { id: 'T2', state: 'BACKLOG', allowed_paths: ['api/**'], resources: [], depends_on: [], risk_class: 'R1' },
    ]);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('proposeTransition returns the current row on an illegal proposal', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-propose-');
  try {
    rt.createProject({ id: 'P1' });
    rt.addTask({ id: 'T1', project_id: 'P1' });

    const legal = rt.proposeTransition('T1', 'READY', 'scheduler', { depStates: {} });
    assert.equal(legal.ok, true);
    assert.equal(legal.from, 'BACKLOG');
    assert.equal(legal.to, 'READY');

    const illegal = rt.proposeTransition('T1', 'DONE', 'scheduler', {});
    assert.equal(illegal.ok, false);
    assert.equal(illegal.error, 'INVALID_TRANSITION');
    assert.ok(illegal.row, 'the illegal proposal carries the current row (L.1)');
    assert.equal(illegal.row.state, 'READY');
  } finally {
    rt.close();
    cleanup(root);
  }
});

// ── worker runs ─────────────────────────────────────────────────────────────

test('startWorkerRun / finishWorkerRun / getWorkerRun / listWorkerRuns round-trip a run', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-runs-');
  try {
    rt.createProject({ id: 'P1' });
    rt.addTask({ id: 'T1', project_id: 'P1' });

    const runId = rt.startWorkerRun({
      taskId: 'T1', attempt: 1, id: 'run-1', sessionId: 'sess-1', pid: 4242,
      model: { provider: 'openai', id: 'gpt-x' }, worktreePath: '/tmp/wt-1', contextManifest: { tier: 'cheap' },
    });
    assert.equal(runId, 'run-1');

    const running = rt.getWorkerRun('run-1');
    assert.equal(running.status, 'running');
    assert.equal(running.task_id, 'T1');
    assert.equal(running.attempt, 1);
    assert.equal(running.session_id, 'sess-1');
    assert.equal(running.pid, 4242);
    assert.equal(running.model_provider, 'openai');
    assert.equal(running.model_id, 'gpt-x');
    assert.equal(running.worktree_path, '/tmp/wt-1');
    assert.deepEqual(running.context_manifest, { tier: 'cheap' });
    assert.equal(running.result, null);

    rt.finishWorkerRun('run-1', {
      exitCode: 0, status: 'completed', result: { summary: 'done' }, durationMs: 1234, tokens: { in: 5, out: 7 }, costUsd: 0.25,
    });
    const finished = rt.getWorkerRun('run-1');
    assert.equal(finished.status, 'completed');
    assert.equal(finished.exit_code, 0);
    assert.equal(finished.duration_ms, 1234);
    assert.equal(finished.tokens_in, 5);
    assert.equal(finished.tokens_out, 7);
    assert.equal(finished.cost_usd, 0.25);
    assert.deepEqual(finished.result, { summary: 'done' });
    assert.ok(finished.finished_at, 'finished_at is stamped');

    const autoId = rt.startWorkerRun({ taskId: 'T1', attempt: 2 });
    assert.match(autoId, /^T1-a2-[0-9a-f]{8}$/);
    assert.equal(rt.getWorkerRun('missing'), null);

    assert.equal(rt.listWorkerRuns({ taskId: 'T1' }).length, 2);
    assert.equal(rt.listWorkerRuns().length, 2);
    assert.equal(rt.listWorkerRuns({ taskId: 'other' }).length, 0);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('ingestResult resolves a valid outbox into an IN_SCOPE result', async () => {
  const { root, rt } = freshRuntime('sdlc-runtime-ingest-');
  try {
    const { buildOutbox } = await core.workerResult();
    rt.createProject({ id: 'P1' });
    rt.addTask({ id: 'T1', project_id: 'P1', allowed_paths: ['src/**'] });
    rt.startWorkerRun({ taskId: 'T1', attempt: 1, id: 'run-1' });

    const outbox = buildOutbox({
      runId: 'run-1', taskId: 'T1', attempt: 1, nonce: 'nonce-abc',
      claims: { status: 'completed', summary: 'did the thing', tests_run: ['unit'] },
    });
    const ingested = rt.ingestResult({
      runId: 'run-1',
      filesChanged: ['src/a.js'],
      contract: { allowed_paths: ['src/**'] },
      outboxRaw: outbox,
      runMeta: { runId: 'run-1', taskId: 'T1', attempt: 1, nonce: 'nonce-abc' },
      runtime: { exitCode: 0, turnEndReason: 'completed', durationMs: 9, tokens: { in: 1, out: 2 }, costUsd: 0.1 },
    });

    assert.equal(ingested.claimsSource, 'outbox');
    assert.equal(ingested.result.result_malformed, false);
    assert.equal(ingested.result.suspect, false);
    assert.equal(ingested.result.summary, 'did the thing');
    assert.deepEqual(ingested.result.files_changed, ['src/a.js']);
    assert.deepEqual(ingested.scope, { ok: true, code: 'IN_SCOPE' });

    const row = rt.getWorkerRun('run-1');
    assert.equal(row.status, 'completed');
    assert.equal(row.exit_code, 0);
    assert.equal(JSON.parse(row.result_json).claims_source, 'outbox');
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('ingestResult marks mismatched provenance as suspect (B.3.2)', async () => {
  const { root, rt } = freshRuntime('sdlc-runtime-suspect-');
  try {
    const { buildOutbox } = await core.workerResult();
    rt.createProject({ id: 'P1' });
    rt.addTask({ id: 'T1', project_id: 'P1', allowed_paths: ['src/**'] });
    rt.startWorkerRun({ taskId: 'T1', attempt: 1, id: 'run-1' });

    const outbox = buildOutbox({
      runId: 'run-1', taskId: 'T1', attempt: 1, nonce: 'nonce-abc',
      claims: { status: 'completed', summary: 'suspicious' },
    });
    const ingested = rt.ingestResult({
      runId: 'run-1',
      filesChanged: ['src/a.js'],
      contract: { allowed_paths: ['src/**'] },
      outboxRaw: outbox,
      runMeta: { runId: 'run-1', taskId: 'T1', attempt: 1, nonce: 'nonce-DIFFERENT' },
      runtime: { exitCode: 0 },
    });

    assert.equal(ingested.claimsSource, 'outbox');
    assert.equal(ingested.result.suspect, true);
    assert.equal(ingested.result.summary, 'suspicious');
    assert.deepEqual(ingested.scope, { ok: true, code: 'IN_SCOPE' });
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('ingestResult with no valid channel yields RESULT_MALFORMED', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-malformed-');
  try {
    rt.createProject({ id: 'P1' });
    rt.addTask({ id: 'T1', project_id: 'P1', allowed_paths: ['src/**'] });
    rt.startWorkerRun({ taskId: 'T1', attempt: 1, id: 'run-1' });

    const ingested = rt.ingestResult({
      runId: 'run-1',
      filesChanged: ['src/a.js'],
      contract: { allowed_paths: ['src/**'] },
      outboxRaw: '{ this is not json',
      runMeta: { runId: 'run-1', taskId: 'T1', attempt: 1, nonce: 'n' },
      runtime: { exitCode: 0 },
    });

    assert.equal(ingested.claimsSource, 'none');
    assert.equal(ingested.result.result_malformed, true);
    assert.deepEqual(ingested.scope, { ok: false, code: 'RESULT_MALFORMED' });
    assert.equal(rt.getWorkerRun('run-1').status, 'completed', 'status is still derived from the runtime exit code');
  } finally {
    rt.close();
    cleanup(root);
  }
});

// ── model runs, spend totals, dispatch ──────────────────────────────────────

test('recordModelRun inserts a row and folds the outcome into the router', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-modelrun-');
  try {
    rt.recordModelRun({
      id: 'mr-1', model_id: 'm1', task_id: 'T1', task_type: 'normal', complexity: 3,
      duration_ms: 50, tokens: 100, cost_usd: 0.5, attempts: 2, outcome: 'success', escalated: 1,
    });
    rt.recordModelRun({ id: 'mr-2', model_id: 'm2', outcome: 'success' });

    const rows = rt.db.prepare('SELECT * FROM model_runs ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model_id, 'm1');
    assert.equal(rows[0].task_type, 'normal');
    assert.equal(rows[0].outcome, 'success');
    assert.equal(rows[0].escalated, 1);
    assert.equal(rows[1].task_id, null, 'task_type/model_id are optional');

    // recordModelRun also records on the live router.
    assert.equal(rt.router.history['m1:normal'].successes, 1);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('spentTotals sums cost, duration and tokens from finished worker runs', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-spend-');
  try {
    assert.deepEqual(rt.spentTotals(), { costUsd: 0, durationMs: 0, tokens: 0 });

    rt.startWorkerRun({ taskId: 'T1', attempt: 1, id: 'run-1' });
    rt.finishWorkerRun('run-1', { status: 'completed', durationMs: 300, tokens: { in: 10, out: 20 }, costUsd: 1.5 });
    rt.startWorkerRun({ taskId: 'T2', attempt: 1, id: 'run-2' });
    rt.finishWorkerRun('run-2', { status: 'failed', durationMs: 100, tokens: { in: 1, out: 2 }, costUsd: 0.5 });

    assert.deepEqual(rt.spentTotals(), { costUsd: 2, durationMs: 400, tokens: 33 });
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('canDispatch allows a fresh task and blocks on project and token exhaustion', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-dispatch-', baseConfig({
    budgets: {
      perProject: { maxCostUsd: 1, maxDurationMs: 1e12 },
      perTask: { R2: { maxAttempts: 1, maxDurationMs: 1e12, maxCostUsd: 1e9, maxTokens: 1000 } },
    },
  }));
  try {
    rt.addTask({ id: 'T1', risk_class: 'R2' });
    assert.deepEqual(rt.canDispatch(rt.getTask('T1')), { ok: true });

    // token exhaustion for the task budget (spent ≥ cumulative maxTokens).
    rt.startWorkerRun({ taskId: 'T1', attempt: 1, id: 'run-tok' });
    rt.finishWorkerRun('run-tok', { status: 'completed', tokens: { in: 1500, out: 700 }, costUsd: 0.1 });
    const byTokens = rt.canDispatch(rt.getTask('T1'));
    assert.equal(byTokens.ok, false);
    assert.match(byTokens.reason, /tokens/);

    // project cost exhaustion takes precedence.
    rt.startWorkerRun({ taskId: 'T1', attempt: 1, id: 'run-cost' });
    rt.finishWorkerRun('run-cost', { status: 'completed', costUsd: 5 });
    const byProject = rt.canDispatch(rt.getTask('T1'));
    assert.equal(byProject.ok, false);
    assert.match(byProject.reason, /project-cost/);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('guardFor builds a GuardPlugin from the task and config policy', async () => {
  const { root, rt } = freshRuntime('sdlc-runtime-guard-');
  try {
    const { GuardPlugin } = await core.guard();
    rt.addTask({ id: 'T1', allowed_paths: ['src/**'], forbidden_paths: ['secrets/**'] });

    const guard = rt.guardFor(rt.getTask('T1'));
    assert.ok(guard instanceof GuardPlugin);
    assert.deepEqual(guard.policy.allowed_paths, ['src/**']);
    assert.deepEqual(guard.policy.forbidden_paths, ['secrets/**']);
    assert.equal(guard.decideFsWrite('src/a.js').kind, 'allow');
    assert.equal(guard.decideFsWrite('other/a.js').kind, 'deny');
    assert.equal(guard.decideFsWrite('secrets/key.txt').kind, 'deny');
  } finally {
    rt.close();
    cleanup(root);
  }
});

// ── decisions / requirements ────────────────────────────────────────────────

test('recordDecision / listDecisions filter by project and parse JSON columns', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-decisions-');
  try {
    rt.recordDecision({
      id: 'D1', project_id: 'P1', question: 'Which DB?', decision: 'SQLite', reason: 'embedded',
      alternatives: ['Postgres'], consequences: ['single-writer'], tags: ['storage'],
    });
    rt.recordDecision({ id: 'D2', project_id: 'P2', question: 'Which UI?' });

    const p1 = rt.listDecisions('P1');
    assert.equal(p1.length, 1);
    assert.equal(p1[0].decision, 'SQLite');
    assert.deepEqual(p1[0].alternatives, ['Postgres']);
    assert.deepEqual(p1[0].consequences, ['single-writer']);
    assert.deepEqual(p1[0].tags, ['storage']);

    const all = rt.listDecisions();
    assert.deepEqual(all.map((d) => d.id), ['D1', 'D2']);
    assert.deepEqual(all[1].alternatives, [], 'missing JSON columns fall back to []');
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('addRequirement / listRequirements filter by project', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-requirements-');
  try {
    rt.addRequirement({
      id: 'R1', project_id: 'P1', statement: 'must list customers', source: 'user',
      acceptance: [{ id: 'AC1' }], status: 'open',
    });
    rt.addRequirement({ id: 'R2', project_id: 'P2', statement: 'other' });

    const p1 = rt.listRequirements('P1');
    assert.equal(p1.length, 1);
    assert.equal(p1[0].statement, 'must list customers');
    assert.equal(p1[0].acceptance_json, '[{"id":"AC1"}]');
    assert.equal(p1[0].status, 'open');

    assert.equal(rt.listRequirements().length, 2);
    assert.equal(rt.listRequirements('P1')[0].id, 'R1');
  } finally {
    rt.close();
    cleanup(root);
  }
});

// ── evidence + events + integrity ───────────────────────────────────────────

test('recordTestResults persists one row per gate', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-testresults-');
  try {
    rt.recordTestResults('T1', 'run-1', {
      unit: { status: 'pass', logPath: '/logs/unit', signature: 'sig-1' },
      lint: { status: 'fail' },
    });
    rt.recordTestResults('T1', 'run-1', {});

    const rows = rt.db.prepare('SELECT * FROM test_results ORDER BY gate').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].gate, 'lint');
    assert.equal(rows[0].status, 'fail');
    assert.equal(rows[0].log_path, null);
    assert.equal(rows[1].gate, 'unit');
    assert.equal(rows[1].status, 'pass');
    assert.equal(rows[1].log_path, '/logs/unit');
    assert.equal(rows[1].signature, 'sig-1');
    assert.equal(rows[1].run_id, 'run-1');
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('getEvents serves task, project and global views plus a limit', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-events-');
  try {
    rt.createProject({ id: 'P1', name: 'p' });
    rt.addTask({ id: 'T1', project_id: 'P1' });
    rt.transition('T1', 'READY', 'scheduler', { depStates: {} });

    const taskEvents = rt.getEvents({ taskId: 'T1' });
    assert.equal(taskEvents.length, 2, 'task-created + READY transition');
    assert.deepEqual(taskEvents.map((e) => e.action), ['task-created', 'BACKLOG→READY']);

    const projectEvents = rt.getEvents({ projectId: 'P1' });
    assert.equal(projectEvents.length, 1);
    assert.equal(projectEvents[0].action, 'project-created');

    assert.equal(rt.getEvents().length, 3);
    assert.equal(rt.getEvents({ limit: 2 }).length, 2);
    assert.equal(rt.getEvents({ taskId: 'missing' }).length, 0);
  } finally {
    rt.close();
    cleanup(root);
  }
});

test('assertIntegrity passes quick_check on a healthy database', () => {
  const { root, rt } = freshRuntime('sdlc-runtime-integrity-');
  try {
    rt.createProject({ id: 'P1' });
    rt.addTask({ id: 'T1', project_id: 'P1' });
    assert.equal(rt.assertIntegrity(), 'ok');
  } finally {
    rt.close();
    cleanup(root);
  }
});

// ── instance lock ───────────────────────────────────────────────────────────

test('open with useLock twice raises RuntimeLockedError; close releases the lock file', () => {
  const root = tempDir('sdlc-runtime-lock-');
  const config = baseConfig({ safety: { instanceLock: true } });
  const lockFile = join(root, '.sdlc', 'sdlc.lock');
  let a = null;
  let b = null;
  try {
    a = new Runtime({ projectRoot: root, config });
    a.open();
    assert.equal(existsSync(lockFile), true, 'the lock file is written on open');

    b = new Runtime({ projectRoot: root, config });
    assert.throws(() => b.open(), (err) => {
      assert.ok(err instanceof RuntimeLockedError);
      assert.equal(err.code, 'INSTANCE_LOCKED');
      assert.equal(err.holder.pid, process.pid);
      assert.match(err.message, /INSTANCE_LOCKED/);
      return true;
    });

    // releaseLock:false keeps the lock file held.
    a.close({ releaseLock: false });
    assert.equal(existsSync(lockFile), true, 'releaseLock:false must not release');

    // a second instance still cannot open while the lock is held.
    const c = new Runtime({ projectRoot: root, config });
    assert.throws(() => c.open(), RuntimeLockedError);

    a.close();
    assert.equal(existsSync(lockFile), false, 'close() releases the lock file');
  } finally {
    a?.close();
    b?.close();
    cleanup(root);
  }
});

// ── router history folding ──────────────────────────────────────────────────

test('buildRouter folds existing model_runs rows into router history', () => {
  const root = tempDir('sdlc-runtime-router-');
  const config = baseConfig();
  let first = null;
  let second = null;
  try {
    first = new Runtime({ projectRoot: root, config });
    first.open();
    for (let i = 0; i < 5; i += 1) {
      first.recordModelRun({ id: `mr-${i}`, model_id: 'm-fold', task_type: 'normal', outcome: 'success' });
    }
    first.recordModelRun({ id: 'mr-fail', model_id: 'm-fail', task_type: 'normal', outcome: 'failure' });
    first.close();
    first = null;

    second = new Runtime({ projectRoot: root, config });
    second.open();
    assert.deepEqual(second.router.history['m-fold:normal'], { successes: 5, failures: 0 });
    assert.deepEqual(second.router.history['m-fail:normal'], { successes: 0, failures: 1 });
    // n ≥ 5 uses the raw success rate, proving the persisted rows are visible.
    assert.equal(second.router.histSuccess('m-fold', 'normal'), 1);
    assert.equal(second.router.histSuccess('m-fail', 'normal'), 1 / 3);
    assert.equal(second.router.histSuccess('never-seen', 'normal'), 0.5);
  } finally {
    first?.close();
    second?.close();
    cleanup(root);
  }
});

test('guardFor honours safety.guardMode (regression: warn mode was silently ignored)', async () => {
  // GuardPlugin reads `policy.mode`. Runtime used to pass `guardMode`, so a
  // `safety.guardMode: warn` deployment silently fell back to fail-closed
  // 'deny' — safe, but wrong and invisible.
  const dir = tempDir('sdlc-runtime-guardmode-');
  try {
    const config = {
      storage: { dbPath: '.sdlc/sdlc.db', requireQuickCheckOnOpen: true },
      safety: { instanceLock: false, guardMode: 'warn', guardForbiddenPatterns: ['rm -rf /'] },
      budgets: {}, tiers: {}, pricing: {},
    };
    const runtime = new Runtime({ projectRoot: dir, config, useLock: false });
    runtime.open();
    try {
      runtime.createProject({ id: 'P1', name: 'g' });
      runtime.addTask({ id: 'T-1', project_id: 'P1', title: 't', role: 'r', allowed_paths: ['src/**'] });
      const guard = runtime.guardFor(runtime.getTask('T-1'));
      assert.equal(guard.policy.mode, 'warn');
      // In warn mode an out-of-scope write is allowed but RECORDED.
      assert.equal(guard.checkFsWrite('other/a.ts'), 'allow');
      assert.equal(guard.denials.length, 1);
      assert.equal(guard.denials[0].subject, 'other/a.ts');
      // The command policy is still applied from config.
      assert.equal(guard.policy.forbidden_patterns[0], 'rm -rf /');
    } finally { runtime.close({ releaseLock: false }); }
  } finally { cleanup(dir); }
});


test('a stored run nonce makes outbox provenance non-optional', () => {
  const rt = new Runtime({ projectRoot: tempDir('sdlc-provenance-'), config: { storage: { dbPath: '.sdlc/sdlc.db' }, safety: { instanceLock: false } } });
  rt.open();
  try {
    rt.createProject({ id: 'P1', name: 'p' });
    rt.addTask({ id: 'T1', project_id: 'P1', title: 't', risk_class: 'R1' });
    rt.state._setState('T1', 'IN_PROGRESS');
    const runId = rt.startWorkerRun({ taskId: 'T1', attempt: 0, nonce: 'nonce-real' });
    const forged = buildOutbox({ runId: 'other', taskId: 'T1', attempt: 0, nonce: 'nonce-forged', claims: { status: 'completed' } });
    const ingested = rt.ingestResult({ runId, filesChanged: [], outboxRaw: forged, contract: { allowed_paths: ['src/**'] }, runtime: { exitCode: 0, costUsd: 0, tokens: { in: 0, out: 0 } } });
    assert.equal(ingested.claimsSource, 'outbox');
    assert.equal(ingested.result.suspect, true);

    const run2 = rt.startWorkerRun({ taskId: 'T1', attempt: 1, nonce: 'nonce-real-2' });
    const good = buildOutbox({ runId: run2, taskId: 'T1', attempt: 1, nonce: 'nonce-real-2', claims: { status: 'completed' } });
    const ok = rt.ingestResult({ runId: run2, filesChanged: [], outboxRaw: good, contract: { allowed_paths: ['src/**'] }, runtime: { exitCode: 0, costUsd: 0, tokens: { in: 0, out: 0 } } });
    assert.equal(ok.result.suspect, false, 'the stored full tuple matches');
  } finally {
    rt.close();
  }
});
