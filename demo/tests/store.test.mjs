/**
 * demo/tests/store.test.mjs — datastore unit tests (pure, no server).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll, createTask, setDone } from '../src/store.mjs';

test('empty store loads as []', () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-store-'));
  assert.deepEqual(loadAll(root), []);
});

test('create validates the title', () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-store-'));
  assert.throws(() => createTask(root, { title: '  ' }), /title is required/);
  assert.throws(() => createTask(root, { title: 'x'.repeat(201) }), /too long/);
  const task = createTask(root, { title: 'hello' });
  assert.equal(task.title, 'hello');
  assert.equal(loadAll(root).length, 1);
});

test('setDone toggles and returns null for unknown ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-store-'));
  const task = createTask(root, { title: 't' });
  assert.equal(setDone(root, 'nope'), null);
  assert.equal(setDone(root, task.id, true).done, true);
  assert.equal(loadAll(root)[0].done, true);
});
