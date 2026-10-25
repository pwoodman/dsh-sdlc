/**
 * tests/unit/lead-run-route.test.mjs — POST /api/sdlc.tasks.run (GUI start).
 *
 * The GUI equivalent of `/sdlc run <goal>`: ensures the project, creates one
 * BACKLOG task from the goal, drains the run proposal, and returns the task
 * id for the panel to pick up on its next flow poll. Fail-closed throughout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { core } from '../lib/helpers.mjs';
import { handleTasksRun } from '../../packages/sdlc-client-ui/src/server/handlers.js';

const { Runtime } = await core.runtime();
const { initProject } = await core.project();

function tempWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-run-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedWorkspace(root) {
  initProject({ projectRoot: root, undetected: 'manual', createBranch: false });
  return root;
}

test('missing goal is a 400, not a throw', async (t) => {
  const root = tempWorkspace(t);
  // Minimal project so the handler reaches validation, not setup.
  seedWorkspace(root);
  const res = handleTasksRun(root, {});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'MISSING_GOAL');
});

test('run creates a project row and a BACKLOG task, drained', async (t) => {
  const root = tempWorkspace(t);
  seedWorkspace(root);
  const res = handleTasksRun(root, { goal: 'add JWT auth with refresh tokens' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.ok(res.body.taskId);
  assert.ok(res.body.projectId);
  const { Runtime: RT } = await core.runtime();
  const { loadConfig } = await core.config();
  const { config } = loadConfig(root);
  const runtime = new RT({ projectRoot: root, config, useLock: false });
  runtime.open();
  try {
    const task = runtime.getTask(res.body.taskId);
    assert.ok(task);
    assert.equal(task.state, 'BACKLOG');
    assert.match(task.objective, /JWT auth/);
  } finally { runtime.close(); }
});

test('two runs create two tasks (conversation adds work)', async (t) => {
  const root = tempWorkspace(t);
  seedWorkspace(root);
  const a = handleTasksRun(root, { goal: 'first goal' });
  const b = handleTasksRun(root, { goal: 'second goal' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.body.taskId, b.body.taskId);
});

test('run without a project tree fails closed with NO_PROJECT', async (t) => {
  const root = tempWorkspace(t);
  // No initProject: no .sdlc/sdlc.db at all.
  const res = handleTasksRun(root, { goal: 'hello' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'NO_PROJECT');
});
