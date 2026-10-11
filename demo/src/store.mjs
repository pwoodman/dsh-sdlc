/**
 * demo/src/store.mjs — tiny JSON-file datastore (the demo backend's "database").
 *
 * Zero dependencies, synchronous, file-backed. The demo API is a task tracker:
 * create tasks, list them, mark them done. Every write is atomic
 * (write-temp + rename) so a crashed run cannot leave a half-written file.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function dbPath(root = process.cwd()) {
  return join(root, 'data', 'tasks.json');
}

export function loadAll(root = process.cwd()) {
  const path = dbPath(root);
  if (!existsSync(path)) return [];
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(doc) ? doc : [];
  } catch {
    return [];
  }
}

export function saveAll(root, items) {
  const path = dbPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n');
  renameSync(tmp, path);
  return path;
}

export function createTask(root, { title }) {
  const clean = String(title ?? '').trim();
  if (!clean) throw new Error('title is required');
  if (clean.length > 200) throw new Error('title is too long (max 200)');
  const items = loadAll(root);
  const task = {
    id: `t-${Date.now().toString(36)}-${String(items.length + 1).padStart(3, '0')}`,
    title: clean,
    done: false,
    createdAt: new Date().toISOString(),
  };
  items.push(task);
  saveAll(root, items);
  return task;
}

export function setDone(root, id, done = true) {
  const items = loadAll(root);
  const task = items.find((t) => t.id === id);
  if (!task) return null;
  task.done = Boolean(done);
  saveAll(root, items);
  return task;
}
