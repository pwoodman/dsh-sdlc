/**
 * tests/unit/eval-report.test.mjs — paired reporting and multiplicity control.
 *
 * Synthetic records with a KNOWN effect, so the report must find it — and must
 * not manufacture significance where the effect is null.
 *
 * Also the regression suite for the third-arm crash: `pairDifferences` used to
 * hardcode `control`/`treatment` and threw
 * `Cannot read properties of undefined (reading 'set')` on any records carrying
 * another arm. `tests/fixtures/eval-third-arm-records.jsonl` is the fixture
 * that reproduces it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildReport, pairDifferences, extractQuantities } from '../../eval/report.mjs';
// Namespace import so this file still LOADS against the pre-fix module: the
// regression must fail on the crash it reproduces, not on a missing export.
import * as evalReport from '../../eval/report.mjs';
import { RECORD_VERSION } from '../../eval/lib/records.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const THIRD_ARM_FIXTURE = join(ROOT, 'tests', 'fixtures', 'eval-third-arm-records.jsonl');

/** The fixture parsed as raw records — the crash input, nothing filtered. */
function thirdArmRecords() {
  return readFileSync(THIRD_ARM_FIXTURE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

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

// ── regression: a third arm used to crash pairDifferences ───────────────────

test('REGRESSION: a records set with a third arm must not crash the report', () => {
  const records = thirdArmRecords();
  assert.equal(records.filter((r) => r.arm === 'placebo').length, 2, 'the fixture must carry a third arm');
  const oldError = "Cannot read properties of undefined (reading 'set')";
  assert.doesNotThrow(() => pairDifferences(records), `pairDifferences threw ${oldError} on a third arm`);
  assert.doesNotThrow(() => buildReport({ records }), `buildReport threw ${oldError} on a third arm`);
  // Total over ANY arm name, not just the fixture's `placebo`.
  assert.doesNotThrow(() => pairDifferences([...records, { ...records[0], runId: 'x', taskId: 'task-delta', repeat: 0, arm: 'sideways' }]));
  assert.doesNotThrow(() => buildReport({ records: [...records, { ...records[0], runId: 'x', taskId: 'task-delta', repeat: 0, arm: 'sideways' }] }));
  assert.deepEqual(evalReport.pairingDisclosure(records).unknownArms, ['placebo']);
});

test('an unknown arm is disclosed per (task, repeat) pair, never analysed', () => {
  const records = thirdArmRecords();
  const { summary } = buildReport({ records });
  const p = summary.pairing;
  assert.deepEqual(p.analysedArms, ['control', 'treatment']);
  assert.deepEqual(p.unknownArms, ['placebo']);
  assert.equal(p.pairsTotal, 3);
  assert.equal(p.pairsAnalysed, 2);
  assert.equal(p.recordsOutsidePair, 2, 'both placebo records must be counted as outside the pair');

  // task-alpha × 0: a complete control × treatment pair PLUS the third arm.
  const alpha = p.disclosedPairs.find((d) => d.taskId === 'task-alpha');
  assert.ok(alpha, 'the pair carrying the third arm must be disclosed PER PAIR');
  assert.equal(alpha.repeat, 0);
  assert.deepEqual(alpha.arms, ['control', 'placebo', 'treatment']);
  assert.deepEqual(alpha.unknownArms, ['placebo']);
  assert.equal(alpha.paired, true);
  assert.deepEqual(alpha.missingArms, []);

  // task-gamma × 0: ONLY the third arm — disclosed, not silently dropped.
  const gamma = p.disclosedPairs.find((d) => d.taskId === 'task-gamma');
  assert.ok(gamma);
  assert.equal(gamma.paired, false);
  assert.deepEqual(gamma.missingArms, ['control', 'treatment']);
  assert.deepEqual(gamma.unknownArms, ['placebo']);

  // task-beta × 0 is a clean pair: no disclosure row.
  assert.equal(p.disclosedPairs.some((d) => d.taskId === 'task-beta'), false, 'a clean pair needs no disclosure');
});

test('the third arm changes no paired number (control × treatment only)', () => {
  const records = thirdArmRecords();
  const { summary } = buildReport({ records });
  const dup = summary.metrics.find((m) => m.metric === 'duplication');
  assert.equal(dup.n, 2, 'only the two complete pairs produce differences');
  // fixture values are dyadic, so these assertions are exact:
  // alpha 0.5→0.125 (improvement 0.375), beta 0.375→0.25 (improvement 0.125).
  assert.equal(dup.controlMedian, 0.4375);
  assert.equal(dup.treatmentMedian, 0.1875);
  const rows = pairDifferences(records).get('duplication')
    .map((d) => [d.taskId, d.control, d.treatment]).sort((a, b) => a[0].localeCompare(b[0]));
  // Exactly the two control × treatment pairs — the placebo's 0.875 (alpha) and
  // 0.75 (gamma) appear nowhere, so the third arm entered no paired value.
  assert.deepEqual(rows, [['task-alpha', 0.5, 0.125], ['task-beta', 0.375, 0.25]]);
});

test('the markdown report discloses the third arm per pair', () => {
  const { markdown } = buildReport({ records: thirdArmRecords() });
  assert.ok(markdown.includes('## Pairing disclosure'), 'the report needs a pairing disclosure section');
  assert.match(markdown, /\| task-alpha × 0 \| control, placebo, treatment \| complete \| placebo \|/);
  assert.match(markdown, /\| task-gamma × 0 \| placebo \| missing control, treatment \| placebo \|/);
  assert.equal(/\| task-beta × 0 \|/.test(markdown), false, 'a clean pair carries no disclosure row');
});

test('a records FILE with a third arm reports per-pair disclosure end-to-end (regression)', () => {
  const res = spawnSync(process.execPath, [join(ROOT, 'eval', 'report.mjs'), '--records', THIRD_ARM_FIXTURE], { encoding: 'utf8' });
  assert.equal(res.status, 0, `the report must not fail on a third arm (stderr: ${res.stderr})`);
  assert.ok(!res.stderr.includes('TypeError'), `the report must not crash (stderr: ${res.stderr})`);
  assert.match(res.stderr, /carry an arm outside the record schema/, 'the salvaged records must be noted on stderr');
  assert.ok(res.stdout.includes('## Pairing disclosure'), 'the file path must disclose, not silently drop');
  assert.match(res.stdout, /\| task-alpha × 0 \| control, placebo, treatment \| complete \| placebo \|/);
  assert.match(res.stdout, /\| task-gamma × 0 \| placebo \| missing control, treatment \| placebo \|/);
});
