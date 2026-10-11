/**
 * tests/unit/eval-report.test.mjs — paired reporting and multiplicity control.
 *
 * Synthetic records with a KNOWN effect, so the report must find it — and must
 * not manufacture significance where the effect is null.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, pairDifferences, extractQuantities } from '../../eval/report.mjs';
import { RECORD_VERSION } from '../../eval/lib/records.mjs';

function rec(taskId, arm, repeat, values, extra = {}) {
  const metrics = {};
  for (const [k, v] of Object.entries(values)) metrics[k] = { available: true, value: v, unit: 'x', method: 'test' };
  return {
    recordVersion: RECORD_VERSION,
    runId: `${taskId}-${arm}-r${repeat}`,
    taskId, arm, armLabel: arm,
    executor: extra.executor ?? 'dsh',
    repeat,
    model: 'test-model',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: extra.durationMs ?? 100,
    tokensIn: 10, tokensOut: 5, costUsd: null, exitCode: 0,
    acceptance: extra.acceptance ?? { passed: 1, total: 1, checked: 1, skipped: 0, checks: [] },
    metrics,
    artifacts: {}, notes: [], executorError: null,
  };
}

/** Six tasks × five repeats, all identical within an arm. */
function corpus({ control, treatment, tasks = 6, repeats = 5 }) {
  const out = [];
  for (let t = 0; t < tasks; t += 1) {
    const id = `task-${t}`;
    for (let r = 0; r < repeats; r += 1) {
      out.push(rec(id, 'control', r, control));
      out.push(rec(id, 'treatment', r, treatment));
    }
  }
  return out;
}

test('a strong real effect is detected and survives Holm', () => {
  const records = corpus({
    control: { duplication: 0.6, complexity: 40 },
    treatment: { duplication: 0.1, complexity: 40 },
  });
  const { summary } = buildReport({ records });
  assert.equal(summary.metrics.find((m) => m.metric === 'duplication').n, 30);
  assert.equal(summary.primaryFavouringTreatment.includes('duplication'), true);
  assert.equal(summary.primarySignificant.includes('duplication'), true);
  assert.ok(summary.metrics.find((m) => m.metric === 'duplication').ci.lo > 0, 'CI must exclude 0');
});

test('a null effect is not called significant, and its CI contains 0', () => {
  const records = corpus({
    control: { duplication: 0.2, complexity: 40 },
    treatment: { duplication: 0.2, complexity: 40 },
  });
  const { summary } = buildReport({ records });
  const dup = summary.metrics.find((m) => m.metric === 'duplication');
  assert.equal(dup.meanImprovement, 0);
  assert.equal(dup.p, 1);
  assert.equal(dup.significant, false);
  assert.ok(dup.ci.lo <= 0 && dup.ci.hi >= 0);
  assert.deepEqual(summary.primarySignificant, []);
});

test('orientation: higher-is-better metrics are oriented correctly', () => {
  const records = corpus({ control: { 'test-ratio': 0.2 }, treatment: { 'test-ratio': 0.5 } });
  const { summary } = buildReport({ records });
  const row = summary.metrics.find((m) => m.metric === 'test-ratio');
  assert.equal(row.orientation, 'higher-is-better');
  assert.ok(row.meanImprovement > 0, 'more tests must read as an improvement');
  assert.equal(summary.primaryFavouringTreatment.includes('test-ratio'), true);
});

test('a regression is reported as favouring CONTROL, not hidden', () => {
  const records = corpus({ control: { secrets: 0 }, treatment: { secrets: 5 } });
  const { summary } = buildReport({ records });
  assert.equal(summary.primaryContradicting.includes('secrets'), true);
  assert.equal(summary.primaryFavouringTreatment.includes('secrets'), false);
});

test('pairing is by (task, repeat) and needs both arms', () => {
  const records = [
    rec('a', 'control', 0, { duplication: 0.5 }),
    rec('a', 'treatment', 0, { duplication: 0.1 }),
    rec('a', 'control', 1, { duplication: 0.5 }), // no matching treatment repeat
    rec('b', 'control', 0, { duplication: 0.4 }),
    rec('b', 'treatment', 0, { duplication: 0.2 }),
  ];
  const diffs = pairDifferences(records);
  const dup = diffs.get('duplication');
  assert.equal(dup.length, 2, 'only the two complete pairs count');
  assert.deepEqual(dup.map((d) => d.taskId).sort(), ['a', 'b']);
});

test('unavailable metrics are excluded rather than treated as zero', () => {
  const c = rec('a', 'control', 0, { duplication: 0.5 });
  const t = rec('a', 'treatment', 0, { duplication: 0.1 });
  t.metrics.coverage = { available: false, value: null, note: 'no artifact' };
  const diffs = pairDifferences([c, t]);
  assert.equal(diffs.has('coverage'), false);
  assert.deepEqual(extractQuantities(t).coverage, undefined);
});

test('the report refuses SIMULATED records unless explicitly allowed', () => {
  const records = corpus({ control: { duplication: 0.5 }, treatment: { duplication: 0.5 }, tasks: 1, repeats: 1 })
    .map((r) => ({ ...r, executor: 'simulate' }));
  assert.throws(() => buildReport({ records }), /SIMULATED/);
  const { summary } = buildReport({ records, allowSimulate: true });
  assert.equal(summary.records, 2);
});

test('every reported row has a defensible orientation and informational metrics stay out', () => {
  const { summary } = buildReport({
    records: corpus({ control: { duplication: 0.5, loc: 900 }, treatment: { duplication: 0.1, loc: 1200 }, tasks: 1, repeats: 2 }),
  });
  for (const m of summary.metrics) {
    assert.ok(['lower-is-better', 'higher-is-better'].includes(m.orientation), `${m.metric} has no orientation`);
  }
  // `loc` is informational: the plugin adding lines is not by itself a loss.
  assert.equal(summary.metrics.some((m) => m.metric === 'loc'), false);
});

test('a failed run is refused, and excluded from every number when forced', () => {
  const records = corpus({ control: { duplication: 0.5 }, treatment: { duplication: 0.1 }, tasks: 1, repeats: 1 });
  records[1] = { ...records[1], status: 'invalid', exitCode: 1, executorError: 'dsh exited 1', metrics: {} };
  assert.throws(() => buildReport({ records }), /INVALID/);
  const { summary } = buildReport({ records, allowInvalid: true });
  assert.equal(summary.integrity.ok, 1);
  assert.equal(summary.integrity.invalid, 1);
  assert.deepEqual(summary.integrity.invalidRunIds, [records[1].runId]);
  assert.equal(summary.records, 1, 'only the valid run is analysed');
  assert.equal(summary.metrics.length, 0, 'a failed run must not produce a metric row');
});

test('a legacy record with a non-zero exit and no status is treated as invalid', () => {
  const records = corpus({ control: { duplication: 0.5 }, treatment: { duplication: 0.5 }, tasks: 1, repeats: 1 });
  records[0] = { ...records[0], exitCode: 1 };
  delete records[0].status;
  assert.throws(() => buildReport({ records }), /INVALID/);
});

test('endpoint coverage names the endpoints that were never measured', () => {
  const { summary } = buildReport({
    records: corpus({ control: { duplication: 0.5 }, treatment: { duplication: 0.1 }, tasks: 1, repeats: 2 }),
  });
  assert.equal(summary.primaryCount, 12);
  // duplication + durationMs + tokens: the synthetic records carry all three.
  assert.equal(summary.primaryMeasured, 3);
  assert.ok(summary.primaryUnmeasured.includes('latency-p95'), 'an unmeasured endpoint must be listed, not implied null');
  assert.ok(summary.primaryUnmeasured.includes('secrets'));
  assert.equal(summary.primaryUnmeasured.includes('tokens'), false, 'tokens is present, so it is measured');
  assert.equal(summary.bootstrapSeed, 0xC0FFEE, 'the analysis seed must be reported so the CI is reproducible');
  assert.equal(summary.endpointCoverage.find((e) => e.metric === 'duplication').measured, true);
});

test('acceptance discloses skipped (unmeasurable) checks alongside the rate', () => {
  const records = corpus({ control: { duplication: 0.5 }, treatment: { duplication: 0.5 }, tasks: 1, repeats: 1 })
    .map((r) => ({ ...r, acceptance: { passed: 1, total: 1, skipped: 2, checks: [] } }));
  const { summary } = buildReport({ records });
  assert.equal(summary.acceptance.control.skipped, 2);
  assert.equal(summary.acceptance.treatment.skipped, 2);
});
