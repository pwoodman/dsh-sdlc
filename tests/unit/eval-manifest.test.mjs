/**
 * tests/unit/eval-manifest.test.mjs — task manifests + run records.
 *
 * The manifest is the contract that makes the A/B auditable, so a malformed one
 * must be rejected loudly rather than silently skipped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTasks, validateTask, TASK_SCHEMA, METRIC_IDS } from '../../eval/lib/manifest.mjs';
import { appendRecord, readRecords, validateRecord, makeRunId, RECORD_VERSION } from '../../eval/lib/records.mjs';

const TASKS_DIR = join(import.meta.dirname, '..', '..', 'eval', 'tasks');

function goodTask(over = {}) {
  return {
    id: 'sample-task',
    title: 'A sample task',
    dimension: ['code-quality'],
    requirement: 'Do the thing properly and add tests.',
    fixture: { kind: 'greenfield', seedFiles: { 'package.json': '{}' } },
    acceptance: { checks: [{ id: 'c1', kind: 'file-exists', path: 'package.json' }] },
    metrics: ['duplication'],
    strata: { risk: 'R2', size: 'S' },
    ...over,
  };
}

test('the shipped task suite is valid and includes exactly one negative control', () => {
  const { tasks, problems } = loadTasks(TASKS_DIR);
  assert.deepEqual(problems, []);
  assert.equal(tasks.length, 7);
  assert.deepEqual(tasks.map((t) => t.id), [...tasks.map((t) => t.id)].sort(), 'tasks are id-sorted');
  const controls = tasks.filter((t) => t.control === true);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].id, 'control-docs-typo');
  for (const t of tasks) {
    assert.deepEqual(validateTask(t), { ok: true, problems: [] });
    assert.ok(t.metrics.every((m) => METRIC_IDS.includes(m)));
  }
});

test('validateTask rejects every malformed shape with a specific problem', () => {
  assert.equal(validateTask(goodTask()).ok, true);
  const cases = [
    [goodTask({ id: 'BAD ID' }), /id must be kebab-case/],
    [goodTask({ dimension: ['nonsense'] }), /unknown dimension/],
    [goodTask({ requirement: 'short' }), /requirement must be a prompt/],
    [goodTask({ metrics: ['not-a-metric'] }), /unknown metric/],
    [goodTask({ fixture: { kind: 'repo' } }), /need repoUrl/],
    [goodTask({ acceptance: { checks: [] } }), /non-empty array/],
    [goodTask({ acceptance: { checks: [{ id: 'x', kind: 'teleport' }] } }), /unknown kind/],
    [goodTask({ strata: { risk: 'R9', size: 'S' } }), /strata.risk/],
  ];
  for (const [task, re] of cases) {
    const v = validateTask(task);
    assert.equal(v.ok, false, `expected rejection for ${JSON.stringify(task).slice(0, 60)}`);
    assert.ok(v.problems.some((p) => re.test(p)), `no problem matched ${re}: ${v.problems.join('; ')}`);
  }
});

test('validateTask reports duplicate acceptance-check ids', () => {
  const v = validateTask(goodTask({ acceptance: { checks: [{ id: 'c1', kind: 'file-exists', path: 'a' }, { id: 'c1', kind: 'file-exists', path: 'b' }] } }));
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /duplicate check id/.test(p)));
});

test('TASK_SCHEMA documents the same required keys the validator enforces', () => {
  assert.ok(TASK_SCHEMA.required.includes('requirement'));
  assert.ok(TASK_SCHEMA.required.includes('metrics'));
  assert.deepEqual(TASK_SCHEMA.properties.metrics.items.enum, METRIC_IDS);
});

test('every rubric a task references exists and is a real, weighted rubric', () => {
  const { tasks } = loadTasks(TASKS_DIR);
  const referenced = tasks.flatMap((t) => t.acceptance.checks.filter((c) => c.kind === 'rubric').map((c) => c.expect));
  assert.ok(referenced.length >= 2, 'the UI tasks must reference blinded rubrics');
  for (const rel of referenced) {
    const path = join(import.meta.dirname, '..', '..', 'eval', rel);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(Array.isArray(doc.criteria) && doc.criteria.length >= 4, `${rel} needs ≥4 criteria`);
    assert.ok(doc.criteria.every((c) => typeof c.weight === 'number' && c.anchors), `${rel} criteria need weights and anchors`);
    assert.ok(doc.reliability && doc.reliability.min > 0, `${rel} must pre-register an inter-rater reliability floor`);
    assert.ok(Array.isArray(doc.slopChecklist) && doc.slopChecklist.length > 0, `${rel} needs a slop checklist`);
    assert.ok(doc.procedure?.blinding, `${rel} must specify blinding`);
  }
});

test('run records round-trip and invalid records are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-records-'));
  try {
    const path = join(dir, 'records.jsonl');
    const rec = {
      recordVersion: RECORD_VERSION,
      runId: makeRunId('t1', 'control', 0),
      taskId: 't1', arm: 'control', executor: 'simulate', repeat: 0, model: null,
      startedAt: new Date().toISOString(), durationMs: 1, exitCode: 0,
      acceptance: { passed: 1, total: 1, checks: [] }, metrics: {},
    };
    assert.deepEqual(validateRecord(rec), { ok: true, problems: [] });
    appendRecord(path, rec);
    assert.throws(() => appendRecord(path, { ...rec, arm: 'sideways' }), /refusing to append an invalid record/);

    // A malformed line is reported, never silently dropped.
    writeFileSync(path, `${JSON.stringify(rec)}\nnot json\n`);
    const { records, malformed } = readRecords(path);
    assert.equal(records.length, 1);
    assert.equal(malformed.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
