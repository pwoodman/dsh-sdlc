#!/usr/bin/env node
/**
 * eval/report.mjs — turn run records into a paired, multiplicity-corrected report.
 *
 *   node eval/report.mjs --records .eval-out/records.jsonl [--allow-simulate] [--alpha 0.05]
 *
 * The report refuses to summarise `simulate` records unless `--allow-simulate`
 * is passed, because those records are a plumbing placebo and would otherwise be
 * read as evidence about DSH.
 */

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readRecords, isRecordValid, findDuplicateRunIds, recordSeeds } from './lib/records.mjs';
import { loadTasks } from './lib/manifest.mjs';
import { mean, median, bootstrapCI, wilcoxonSignedRank, pairedDominance, cohensDz, holmBonferroni, pairedSampleSize } from './lib/stats.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/** Direction of "better" per metric. `null` = informational, never an endpoint. */
export const METRIC_ORIENTATION = {
  duplication: false,
  complexity: false,
  'module-cycles': false,
  'test-ratio': true,
  'static-a11y': false,
  secrets: false,
  'dangerous-patterns': false,
  'dependency-audit': false,
  'latency-p95': false,
  'error-rate': false,
  'bundle-size': false,
  'api-surface': null,
  loc: null,
  deps: null,
  syntax: false,
  durationMs: false,
  tokens: false,
  costUsd: false,
  coverage: true,
  mutation: true,
};

/** Metrics that constitute the confirmatory family (corrected together). */
export const PRIMARY_METRICS = [
  'duplication', 'complexity', 'module-cycles', 'test-ratio', 'syntax',
  'static-a11y', 'secrets', 'dangerous-patterns',
  'latency-p95', 'error-rate', 'durationMs', 'tokens',
];

function orientation(metric) {
  return METRIC_ORIENTATION[metric] ?? null;
}

/** Flatten one record into the numeric quantities the report compares. */
export function extractQuantities(rec) {
  const out = { durationMs: rec.durationMs };
  if (typeof rec.costUsd === 'number') out.costUsd = rec.costUsd;
  if (typeof rec.tokensIn === 'number' && typeof rec.tokensOut === 'number') out.tokens = rec.tokensIn + rec.tokensOut;
  for (const [id, m] of Object.entries(rec.metrics ?? {})) {
    if (m && m.available && typeof m.value === 'number') out[id] = m.value;
  }
  return out;
}

/** Build oriented per-metric paired differences: positive always means BETTER. */
export function pairDifferences(records) {
  const byTask = new Map();
  for (const r of records) {
    if (!byTask.has(r.taskId)) byTask.set(r.taskId, { control: new Map(), treatment: new Map() });
    byTask.get(r.taskId)[r.arm].set(r.repeat, r);
  }
  const diffs = new Map(); // metric → [{taskId, repeat, improvement, control, treatment}]
  for (const [taskId, arms] of byTask) {
    for (const [repeat, ctrl] of arms.control) {
      const trt = arms.treatment.get(repeat);
      if (!trt) continue;
      const cq = extractQuantities(ctrl);
      const tq = extractQuantities(trt);
      for (const metric of Object.keys(METRIC_ORIENTATION)) {
        if (!(metric in cq) || !(metric in tq)) continue;
        const dir = orientation(metric);
        if (dir === null) continue;
        const improvement = dir ? tq[metric] - cq[metric] : cq[metric] - tq[metric];
        if (!diffs.has(metric)) diffs.set(metric, []);
        diffs.get(metric).push({ taskId, repeat, improvement, control: cq[metric], treatment: tq[metric] });
      }
    }
  }
  return diffs;
}

export function buildReport({ records, tasks = [], alpha = 0.05, seed = 0xC0FFEE, bootstrapB = 10000, allowSimulate = false, allowInvalid = false, allowMixedSeeds = false, allowDuplicates = false } = {}) {
  if (!allowSimulate && records.some((r) => r.executor === 'simulate')) {
    throw new Error('records contain SIMULATED runs; pass allowSimulate to report them (they are not evidence about DSH)');
  }
  // A records file that mixes two studies (two seeds, or the same runId twice)
  // is refused: the doubled placebo n (42 → 84) proved this happens silently.
  const seeds = recordSeeds(records);
  if (seeds.length > 1 && !allowMixedSeeds) {
    throw new Error(`records mix ${seeds.length} study seeds (${seeds.join(', ')}); a report over two studies is not one study — pass allowMixedSeeds to proceed regardless, or re-run into a fresh --out dir`);
  }
  const dups = findDuplicateRunIds(records);
  if (dups.length > 0 && !allowDuplicates) {
    throw new Error(`records contain ${dups.length} duplicate runId(s) (${dups.slice(0, 5).join(', ')}${dups.length > 5 ? '…' : ''}); the file was appended onto twice — pass allowDuplicates to analyse the first occurrence of each, or re-run into a fresh --out dir`);
  }
  const deduped = dups.length
    ? records.filter((r, i) => records.findIndex((o) => o.runId === r.runId) === i)
    : records;
  // A record where the executor failed is disclosed but NEVER analysed: an arm
  // that did not run is not a paired observation, and its empty metric block
  // would otherwise be averaged in as if it were a null result.
  const invalidRecords = deduped.filter((r) => !isRecordValid(r));
  if (invalidRecords.length && !allowInvalid) {
    throw new Error(`records contain ${invalidRecords.length} INVALID run(s) where the executor failed; pass allowInvalid to report around them (a failed run is not evidence)`);
  }
  const valid = deduped.filter(isRecordValid);
  const diffs = pairDifferences(valid);
  const metrics = [];
  for (const [metric, rows] of [...diffs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const values = rows.map((r) => r.improvement);
    if (!values.length) continue;
    const controls = rows.map((r) => r.control);
    const treatments = rows.map((r) => r.treatment);
    const w = wilcoxonSignedRank(values);
    const ci = bootstrapCI(values, { statistic: 'median', alpha, seed, B: bootstrapB });
    const dz = cohensDz(values);
    const tasksSeen = [...new Set(rows.map((r) => r.taskId))];
    metrics.push({
      metric,
      orientation: orientation(metric) ? 'higher-is-better' : 'lower-is-better',
      n: values.length,
      tasks: tasksSeen.length,
      controlMedian: median(controls),
      treatmentMedian: median(treatments),
      meanImprovement: mean(values),
      medianImprovement: median(values),
      ci,
      p: w.p,
      pMethod: w.method,
      exact: w.exact,
      dominance: pairedDominance(values),
      dz,
      requiredPairsForDz: Number.isFinite(dz) && dz !== 0 ? pairedSampleSize(Math.abs(dz), { alpha, power: 0.8 }) : null,
    });
  }

  const primaryItems = metrics.filter((m) => PRIMARY_METRICS.includes(m.metric)).map((m) => ({ label: m.metric, p: m.p }));
  const holm = holmBonferroni(primaryItems, alpha);
  const holmByLabel = new Map(holm.map((h) => [h.label, h]));
  for (const m of metrics) {
    const h = holmByLabel.get(m.metric);
    m.holmThreshold = h?.threshold ?? null;
    m.significant = h?.rejected ?? false;
  }

  const acceptanceOf = (arm) => {
    const rs = valid.filter((r) => r.arm === arm);
    const passed = rs.reduce((a, r) => a + r.acceptance.passed, 0);
    const total = rs.reduce((a, r) => a + r.acceptance.total, 0);
    const skipped = rs.reduce((a, r) => a + (r.acceptance.skipped ?? 0), 0);
    return { passed, total, skipped, rate: total ? passed / total : null, runs: rs.length };
  };
  const acceptance = { control: acceptanceOf('control'), treatment: acceptanceOf('treatment') };

  // Which pre-registered endpoints actually produced data, so a "0/12" cannot
  // be read as "twelve null results" when most were never measured at all.
  const endpointCoverage = PRIMARY_METRICS.map((id) => {
    const row = metrics.find((m) => m.metric === id);
    return { metric: id, measured: Boolean(row && row.n > 0), n: row?.n ?? 0 };
  });

  const summary = {
    records: valid.length,
    totalRecords: records.length,
    dedupedRecords: deduped.length,
    integrity: { ok: valid.length, invalid: invalidRecords.length, invalidRunIds: invalidRecords.map((r) => r.runId) },
    tasks: [...new Set(valid.map((r) => r.taskId))].length,
    arms: [...new Set(valid.map((r) => r.arm))].sort(),
    model: [...new Set(valid.map((r) => r.model ?? 'unspecified'))],
    providers: [...new Set(valid.map((r) => r.modelProvider ?? 'unspecified'))],
    repeatsPerArm: [...new Set(valid.map((r) => r.repeat))].length,
    alpha,
    bootstrapSeed: seed,
    metrics,
    acceptance,
    endpointCoverage,
    primaryMeasured: endpointCoverage.filter((e) => e.measured).length,
    primaryUnmeasured: endpointCoverage.filter((e) => !e.measured).map((e) => e.metric),
    primarySignificant: metrics.filter((m) => m.significant).map((m) => m.metric),
    // "Favouring" requires the whole 95% CI above zero, not merely a positive
    // mean — a noisy mean with a CI straddling zero is not a win.
    primaryFavouringTreatment: metrics.filter((m) => PRIMARY_METRICS.includes(m.metric) && m.ci.lo > 0).map((m) => m.metric),
    primaryContradicting: metrics.filter((m) => PRIMARY_METRICS.includes(m.metric) && m.ci.hi < 0).map((m) => m.metric),
    primaryCount: PRIMARY_METRICS.length,
  };
  return { summary, markdown: renderMarkdown(summary, tasks) };
}

function fmt(x, digits = 4) {
  if (x == null || Number.isNaN(x)) return '—';
  if (typeof x === 'number') return Number.isInteger(x) ? String(x) : x.toFixed(digits);
  return String(x);
}

export function renderMarkdown(summary, tasks = []) {
  const dimOf = new Map();
  for (const t of tasks) for (const d of t.dimension ?? []) dimOf.set(t.id, d);
  const lines = [];
  lines.push('# SDLC plugin A/B evaluation report');
  lines.push('');
  lines.push(`Records: **${summary.records}** · tasks: **${summary.tasks}** · repeats/arm: **${summary.repeatsPerArm}** · model(s): **${summary.model.join(', ')}**`);
  lines.push('');
  lines.push(`Model provider(s): **${summary.providers.join(', ')}** · bootstrap seed: **${summary.bootstrapSeed}**`);
  lines.push('');
  lines.push(`Run integrity: **${summary.integrity.ok} ok / ${summary.integrity.invalid} invalid**${summary.integrity.invalid ? ` (excluded from every number below: ${summary.integrity.invalidRunIds.join(', ')})` : ''}`);
  lines.push('');
  lines.push('> Pre-registered protocol: `EVAL_PROTOCOL.md`. Paired design; per-metric differences are oriented so **positive = treatment better**.');
  lines.push('> The confirmatory family is Holm–Bonferroni corrected at α = ' + summary.alpha + '.');
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(`- Primary endpoints favouring treatment (95% CI above 0): **${summary.primaryFavouringTreatment.length}/${summary.primaryCount}**${summary.primaryFavouringTreatment.length ? ` (${summary.primaryFavouringTreatment.join(', ')})` : ''}`);
  lines.push(`- Primary endpoints favouring CONTROL (95% CI below 0 — the plugin lost): **${summary.primaryContradicting.length ? summary.primaryContradicting.join(', ') : 'none'}**`);
  lines.push(`- Statistically significant after Holm: **${summary.primarySignificant.length ? summary.primarySignificant.join(', ') : 'none'}**`);
  lines.push(`- Primary endpoints actually measured: **${summary.primaryMeasured}/${summary.primaryCount}**${summary.primaryUnmeasured.length ? ` — never measured: ${summary.primaryUnmeasured.join(', ')}` : ''}`);
  lines.push(`- Acceptance checks — control ${summary.acceptance.control.passed}/${summary.acceptance.control.total} (skipped ${summary.acceptance.control.skipped}), treatment ${summary.acceptance.treatment.passed}/${summary.acceptance.treatment.total} (skipped ${summary.acceptance.treatment.skipped})`);
  lines.push('');
  lines.push('## Endpoint coverage');
  lines.push('');
  lines.push('| Primary endpoint | Measured | n |');
  lines.push('|---|---|---|');
  for (const e of summary.endpointCoverage) lines.push(`| ${e.metric} | ${e.measured ? 'yes' : 'NO DATA'} | ${e.n} |`);
  lines.push('');
  lines.push('_A `NO DATA` endpoint is not a null result; it was never measured (typically: no pinned toolchain artifact, or a check that requires the live service/jury)._');
  lines.push('');
  lines.push('## Metric results');
  lines.push('');
  lines.push('| Metric | Better | n | Control (median) | Treatment (median) | Improvement (median) | 95% CI | p | Holm | Significant | dz |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of summary.metrics) {
    lines.push(`| ${m.metric} | ${m.orientation === 'higher-is-better' ? 'higher' : 'lower'} | ${m.n} | ${fmt(m.controlMedian)} | ${fmt(m.treatmentMedian)} | ${fmt(m.medianImprovement)} | [${fmt(m.ci.lo)}, ${fmt(m.ci.hi)}] | ${fmt(m.p, 5)} | ${fmt(m.holmThreshold, 5)} | ${m.significant ? 'yes' : 'no'} | ${fmt(m.dz, 3)} |`);
  }
  lines.push('');
  lines.push('_`dz` is Cohen\'s dz for the paired improvement. A metric whose improvement CI contains 0 is not distinguishable from noise at this n._');
  lines.push('');
  lines.push('## Threats to validity (must be read with the numbers)');
  lines.push('');
  lines.push('1. A small n makes the exact Wilcoxon test the only defensible one; the approximation is flagged per row.');
  lines.push('2. Regex-based metrics (`static-a11y`, `secrets`, `dangerous-patterns`, `complexity`, `duplication`) are proxies; the protocol mandates the real toolchain before any public claim.');
  lines.push('3. The plugin changes the prompt and tool surface as well as the orchestration; the protocol isolates this with an extra placebo-plugin arm.');
  lines.push('4. A single model snapshot is not evidence about other models.');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
  };
  const recordsPath = resolve(flag('--records', join(ROOT, '.eval-out', 'records.jsonl')));
  const allowSimulate = argv.includes('--allow-simulate');
  const allowInvalid = argv.includes('--allow-invalid');
  const allowMixedSeeds = argv.includes('--allow-mixed-seeds');
  const allowDuplicates = argv.includes('--allow-duplicates');
  const alpha = Number(flag('--alpha', 0.05));
  const { records, malformed } = readRecords(recordsPath);
  if (malformed.length) process.stderr.write(`eval: ${malformed.length} malformed record line(s) ignored\n`);
  const { tasks } = loadTasks(join(ROOT, 'eval', 'tasks'));
  try {
    const { summary, markdown } = buildReport({ records, tasks, alpha, allowSimulate, allowInvalid, allowMixedSeeds, allowDuplicates });
    const outPath = flag('--out', null);
    if (outPath) {
      writeFileSync(resolve(outPath), markdown);
      process.stdout.write(`eval: report → ${resolve(outPath)}\n`);
    } else {
      process.stdout.write(`${markdown}\n`);
    }
    process.stdout.write(`eval: ${summary.integrity.ok} ok / ${summary.integrity.invalid} invalid run(s), ${summary.metrics.length} metric rows, ${summary.primaryMeasured}/${summary.primaryCount} primary endpoints measured, ${summary.primarySignificant.length} significant after Holm\n`);
  } catch (err) {
    process.stderr.write(`eval: ${err.message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export default { buildReport, pairDifferences, extractQuantities, METRIC_ORIENTATION, PRIMARY_METRICS };
