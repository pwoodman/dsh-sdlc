/**
 * tests/unit/lead-commands.test.mjs — /sdlc command execution (D22 slice).
 *
 * `/sdlc run` boots the flow (project + first BACKLOG task) instead of
 * returning `{deferred:true}`; authority commands (stop/retry/approve/
 * reject/elevate) execute against the runtime. Everything is fail-closed:
 * no runtime, no DB, no throw — failures resolve to `{ok:false}`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { core } from '../lib/helpers.mjs';
import { executeCommand, executeRun, executeStop, executeRetry, registerCommands } from '../../packages/sdlc-tools/src/plugin.js';
import { getRuntime, closeRuntime as closeSharedRuntime } from '../../packages/sdlc-core/src/services.js';

const { Runtime } = await core.runtime();
const { migrate } = await core.schema();
const { TaskStateService } = await core.stateMachine();

function freshRuntime(projectRoot) {
  const runtime = new Runtime({ projectRoot, config: {}, useLock: false });
  runtime.db = new DatabaseSync(':memory:');
  migrate(runtime.db);
  runtime.state = new TaskStateService(runtime.db);
  return runtime;
}

function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-cmd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('/sdlc run with an empty goal is a usage error, not a throw', () => {
  const runtime = freshRuntime('/tmp/x');
  try {
    const res = executeRun('   ', { runtime, projectRoot: '/tmp/x' });
    assert.equal(res.ok, false);
    assert.match(res.error, /USAGE/);
  } finally { runtime.db.close(); }
});

test('/sdlc run truncates the title to 80 chars but keeps the full goal', (t) => {
  const root = tempRoot(t);
  const runtime = freshRuntime(root);
  try {
    const goal = `x${'y'.repeat(200)}`;
    const res = executeRun(goal, { runtime, projectRoot: root });
    assert.equal(res.ok, true);
    const task = runtime.getTask(res.taskId);
    assert.ok(task.title.length <= 80, `title is ${task.title.length} chars`);
    assert.equal(task.objective, goal);
  } finally { runtime.db.close(); }
});

test('/sdlc run without an injected runtime resolves the project-root singleton', (t) => {
  // Slice merger decision: the live Lead path calls executeRun with a
  // project root but no injected runtime — the singleton MUST serve it.
  // Run in an isolated temp root so the repo DB is never touched.
  const root = tempRoot(t);
  const res = executeRun('build a thing', { projectRoot: root, getRuntime: (cfg) => getRuntime(cfg, { projectRoot: root }) });
  assert.equal(res.ok, true);
  assert.ok(res.taskId);
  closeSharedRuntime(root);
});

test('/sdlc run creates a project and a BACKLOG task, then drains', (t) => {
  const root = tempRoot(t);
  const runtime = freshRuntime(root);
  try {
    const res = executeRun('add JWT auth with refresh tokens', { runtime, projectRoot: root });
    assert.equal(res.ok, true);
    assert.equal(res.command, 'run');
    assert.ok(res.taskId);
    assert.ok(res.projectId);
    const task = runtime.getTask(res.taskId);
    assert.ok(task);
    assert.equal(task.state, 'BACKLOG');
    assert.match(task.objective, /JWT auth/);
    // Drained: nothing left queued.
    assert.equal(runtime.listProposals({ status: 'queued' }).length, 0);
  } finally { runtime.db.close(); }
});

test('/sdlc run twice creates two tasks (conversation adds work)', (t) => {
  const root = tempRoot(t);
  const runtime = freshRuntime(root);
  try {
    const a = executeRun('first goal', { runtime, projectRoot: root });
    const b = executeRun('second goal', { runtime, projectRoot: root });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.taskId, b.taskId);
    assert.equal(runtime.listTasks().length, 2);
  } finally { runtime.db.close(); }
});

test('/sdlc retry moves FAILED back to READY', (t) => {
  const root = tempRoot(t);
  const runtime = freshRuntime(root);
  try {
    runtime.addTask({ id: 'T-R1', title: 't', objective: 'o', role: 'backend-engineer', retry_budget: 3 });
    const toReady = runtime.transition('T-R1', 'READY', 'scheduler', {});
    assert.equal(toReady.ok, true, toReady.reason);
    const res = executeRetry('T-R1', { runtime, projectRoot: root });
    // READY has no FAILED→READY path; retry is a no-op report, not a throw.
    assert.equal(res.ok, false);
    assert.match(res.error, /NOT_FAILED/);
    // A real FAILED task retries via the scheduler row.
    runtime.transition('T-R1', 'ASSIGNED', 'scheduler', {});
    runtime.transition('T-R1', 'IN_PROGRESS', 'worker-mgr', {});
    const failed = runtime.transition('T-R1', 'FAILED', 'worker-mgr', { hardFailure: true });
    assert.equal(failed.ok, true, failed.reason);
    const retry = executeRetry('T-R1', { runtime, projectRoot: root });
    assert.equal(retry.ok, true);
    assert.equal(retry.to, 'READY');
    assert.equal(runtime.getTask('T-R1').state, 'READY');
  } finally { runtime.db.close(); }
});

test('/sdlc stop cancels live tasks', (t) => {
  const root = tempRoot(t);
  const runtime = freshRuntime(root);
  try {
    runtime.addTask({ id: 'T-S1', title: 't', objective: 'o', role: 'backend-engineer' });
    const res = executeStop('', { runtime, projectRoot: root });
    assert.equal(res.ok, true);
    assert.deepEqual(res.stopped, ['T-S1']);
    assert.equal(runtime.getTask('T-S1').state, 'CANCELLED');
  } finally { runtime.db.close(); }
});

test('unknown commands still report deferred (slice 3 owns the rest)', () => {
  const seen = [];
  const fake = {
    get: () => ({ register: (def) => seen.push(def) }),
    logger: {},
  };
  const names = registerCommands(fake, {});
  assert.ok(names.includes('status'));
  assert.ok(names.includes('run'));
  const runDef = seen.find((d) => d.definitionId === 'sdlc.run');
  assert.ok(runDef);
  const res = runDef.handler('');
  assert.equal(res.ok, false);
  assert.match(res.error, /USAGE/);
});

test('executeCommand routes run/stop/retry/approve and defers the rest', (t) => {
  const root = tempRoot(t);
  const runtime = freshRuntime(root);
  try {
    assert.deepEqual(executeCommand('status', 'x', { runtime }), { ok: true, command: 'status', input: 'x', deferred: true });
    assert.equal(executeCommand('run', '', { runtime, projectRoot: root }).ok, false);
    assert.equal(executeCommand('approve', 'T-X', { runtime, projectRoot: root }).ok, false);
  } finally { runtime.db.close(); }
});

test('lead tools enqueue via runtime when provided (D22 phase 1)', async () => {
  const { createHandlers } = await import('../../packages/sdlc-tools/src/index.js');
  const root = mkdtempSync(join(tmpdir(), 'sdlc-tools-'));
  const runtime = freshRuntime(root);
  try {
    const handlers = createHandlers({ runtime, runMeta: { actor: 'lead' } });
    const delta = handlers.sdlc_plan_delta({ tasks: [{ id: 'T-H1', title: 'h', objective: 'o', role: 'backend-engineer' }], reason: 'r' });
    assert.equal(delta.ok, true);
    assert.ok(delta.proposal);
    const decision = handlers.sdlc_record_decision({ question: 'Q?', decision: 'Yes' });
    assert.equal(decision.ok, true);
    // Model-side approve stays denied even with a runtime.
    const denied = handlers.sdlc_approve_transition({ task_id: 'T-H1', to: 'DONE' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /AUTHORITY_DENIED/);
    const dispatch = handlers.sdlc_dispatch_task({ task_id: 'T-H1' });
    assert.equal(dispatch.ok, true);
  } finally {
    runtime.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
