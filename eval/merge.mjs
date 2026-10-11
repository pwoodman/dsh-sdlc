#!/usr/bin/env node
/**
 * eval/merge.mjs — merge sharded study outputs into one analysable directory.
 *
 * Shards (see `--shard-index/--shard-count` in run.mjs) each write their own
 * `<out>/records.jsonl`, `<out>/study.json` and `<out>/work/`. The report
 * analyses ONE records file, so this script concatenates the shard records
 * (verifying they share one study seed, executor and task universe), merges
 * the work trees, and writes a combined study.json:
 *
 *   node eval/run.mjs --executor dsh --live --repeats 5 --seed S \
 *     --shard-index 0 --shard-count 2 --out .eval-out-shard0 …
 *   node eval/run.mjs --executor dsh --live --repeats 5 --seed S \
 *     --shard-index 1 --shard-count 2 --out .eval-out-shard1 …
 *   node eval/merge.mjs --out .eval-out-merged .eval-out-shard0 .eval-out-shard1
 *   node eval/report.mjs --records .eval-out-merged/records.jsonl
 *
 * Merge rules: duplicate runIds are refused (a shard ran twice); mixed study
 * seeds are refused (shards must share --seed); every shard's study.json must
 * name the same executor, repeats, profiles and model pin.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readRecords, findDuplicateRunIds } from './lib/records.mjs';

function fail(message) {
  process.stderr.write(`eval/merge: ${message}\n`);
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  if (outIdx < 0 || !argv[outIdx + 1]) fail('usage: node eval/merge.mjs --out <dir> <shard-dir>…');
  const outDir = resolve(argv[outIdx + 1]);
  const shards = argv.filter((a, i) => i !== outIdx && i !== outIdx + 1 && !a.startsWith('--')).map((d) => resolve(d));
  if (shards.length < 2) fail('need at least two shard dirs to merge');

  const studies = [];
  const allRecords = [];
  for (const shard of shards) {
    const studyPath = join(shard, 'study.json');
    const recordsPath = join(shard, 'records.jsonl');
    if (!existsSync(studyPath)) fail(`${shard}: no study.json — not a study output dir`);
    if (!existsSync(recordsPath)) fail(`${shard}: no records.jsonl — nothing to merge`);
    studies.push({ shard, study: JSON.parse(readFileSync(studyPath, 'utf8')) });
    const { records, malformed } = readRecords(recordsPath);
    if (malformed.length) fail(`${shard}: ${malformed.length} malformed record(s) — fix before merging`);
    for (const r of records) allRecords.push({ ...r, __shard: shard });
  }

  // All shards must be the same study: one seed, one executor, one universe.
  const keys = ['executor', 'repeats', 'studySeed', 'baselineProfile', 'treatmentProfile', 'model', 'provider'];
  const first = studies[0].study;
  for (const { shard, study } of studies.slice(1)) {
    for (const k of keys) {
      if (JSON.stringify(study[k]) !== JSON.stringify(first[k])) {
        fail(`shard mismatch on ${k}: ${JSON.stringify(first[k])} (in ${studies[0].shard}) vs ${JSON.stringify(study[k])} (in ${shard}) — shards must share --seed and the same study flags`);
      }
    }
  }

  const dups = findDuplicateRunIds(allRecords);
  if (dups.length) fail(`${dups.length} duplicate runId(s) across shards (${dups.slice(0, 5).join(', ')}) — a task ran in two shards; check --shard-index/--shard-count`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'records.jsonl'), `${allRecords.map(({ __shard, ...r }) => JSON.stringify(r)).join('\n')}\n`);
  for (const { shard } of studies) {
    const work = join(shard, 'work');
    if (existsSync(work)) cpSync(work, join(outDir, 'work'), { recursive: true, force: true });
    const patch = join(shard, 'model-patch.yml');
    if (existsSync(patch) && !existsSync(join(outDir, 'model-patch.yml'))) cpSync(patch, join(outDir, 'model-patch.yml'));
  }
  writeFileSync(join(outDir, 'study.json'), `${JSON.stringify({
    ...first,
    mergedFrom: shards,
    mergedAt: new Date().toISOString(),
    tasks: [...new Set(allRecords.map((r) => r.taskId))].sort(),
  }, null, 2)}\n`);
  process.stdout.write(`eval/merge: ${allRecords.length} record(s) from ${shards.length} shard(s) → ${join(outDir, 'records.jsonl')}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export default {};
