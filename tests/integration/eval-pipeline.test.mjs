/**
 * tests/integration/eval-pipeline.test.mjs — the A/B harness end to end (offline).
 *
 * The `simulate` executor is a deliberate PLACEBO: both arms get the identical
 * fixture, so a correct pipeline must report a null effect. This test proves the
 * plumbing and the statistics — never a claim about DSH.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvaluation } from '../../eval/run.mjs';
import { readRecords } from '../../eval/lib/records.mjs';
import { buildReport } from '../../eval/report.mjs';
import { loadTasks } from '../../eval/lib/manifest.mjs';

const TASKS_DIR = join(import.meta.dirname, '..', '..', 'eval', 'tasks');

test('eval pipeline: simulate runs both arms, records them, and reports a null', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'eval-pipeline-'));
  try {
    const out = runEvaluation({ tasksDir: TASKS_DIR, outDir, executor: 'simulate', repeats: 2, taskFilter: 'refactor-dedupe' });
    assert.equal(out.records.length, 4, 'two arms × two repeats');
    assert.equal(existsSync(out.recordsPath), true);

    const { records, malformed } = readRecords(out.recordsPath);
    assert.equal(malformed.length, 0);
    assert.equal(records.length, 4);
    assert.deepEqual([...new Set(records.map((r) => r.arm))].sort(), ['control', 'treatment']);
    assert.ok(records.every((r) => r.executor === 'simulate'));
    assert.ok(records.every((r) => r.status === 'ok'), 'a clean run is recorded ok');
    assert.ok(records.every((r) => r.environment && r.environment.node), 'the environment identity is recorded per run');
    assert.ok(records.every((r) => r.notes.some((n) => /SIMULATED/.test(n))), 'simulated records must say so');

    // The fixture is real, so a real collector saw real code.
    const sample = records[0];
    assert.equal(sample.metrics.duplication.available, true);
    assert.ok(sample.metrics.duplication.value > 0, 'the triplicated fixture must register as duplication');
    assert.equal(sample.metrics.syntax.available, true);
    assert.equal(sample.metrics.syntax.value, 0);

    // The report refuses simulated data by default and accepts it explicitly.
    assert.throws(() => buildReport({ records }), /SIMULATED/);
    const { summary } = buildReport({ records, allowSimulate: true });
    assert.equal(summary.records, 4);
    const dup = summary.metrics.find((m) => m.metric === 'duplication');
    assert.ok(dup, 'duplication must appear as a metric row');
    assert.equal(dup.meanImprovement, 0, 'a placebo must show no improvement');
    assert.equal(dup.significant, false);
    assert.deepEqual(summary.primarySignificant, []);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('eval pipeline: an unknown task filter fails loudly', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'eval-pipeline-'));
  try {
    assert.throws(
      () => runEvaluation({ tasksDir: TASKS_DIR, outDir, executor: 'simulate', repeats: 1, taskFilter: 'no-such-task' }),
      /no task with id/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('eval pipeline: the shipped manifests all resolve against the runner', () => {
  const { tasks, problems } = loadTasks(TASKS_DIR);
  assert.deepEqual(problems, []);
  for (const t of tasks) {
    assert.ok(t.acceptance.checks.length >= 1);
    assert.ok(t.metrics.length >= 1);
  }
});
