#!/usr/bin/env node
/**
 * scripts/validate-gates.mjs — run every milestone gate (spec v3 D.0).
 *
 * Ordering: P → M0 run SEQUENTIALLY with stop-at-first-fail (G.5: "a PR that
 * breaks a lower gate is blocked" — nothing downstream of a broken platform
 * or composition gate is meaningful). M1–M7 then fan out CONCURRENTLY
 * (TRACK B, B14): each is a separate OS process writing its own gate-<ID>.json
 * evidence, so they are independent — the failures are reported together at
 * the end instead of one at a time. M8 and Q stay sequential after the fan-in:
 * M8 asserts the DoD "every item is represented by a lower gate" (its M8-03
 * checks files on disk, but M8-05 re-runs the full offline suite, so it pays
 * to know M1–M7 first), and Q reads the coverage artifact.
 *
 * NOTE — the FIRST sanctioned Promise.all in production-adjacent code (B14).
 * `node --test` file concurrency does not apply here (these are child
 * processes, not test files), and the gates are the one place where wall time
 * is dominated by independent process spawns rather than shared sqlite state.
 * P/M0 stay serial: M0 boots the composed profiles and would race another
 * gate's temp-dir install. M8 stays serial: it re-runs the whole offline
 * suite, which would contend with the M1–M7 children for CPU.
 *
 * Each gate writes its OWN `gate-<ID>.json` (no shared file), and the CLI
 * output shape is unchanged: `{ id, script, status, ms, passed, failedChecks,
 * skipped, evidence }` per gate, plus `{ id, status: 'skipped', reason }` for
 * anything below `--upto` or below a failure.
 *
 *   node scripts/validate-gates.mjs [--upto M4] [--json-dir .validation] [--quiet]
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { run } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const upto = flag('--upto', null);
const jsonDir = flag('--json-dir', join(ROOT, '.validation'));
const quiet = argv.includes('--quiet');

/** P has a different script name; M0..M8 follow the pattern. */
function gateList() {
  const gates = [{ id: 'P', script: 'scripts/validate-platform.mjs' }];
  for (let i = 0; i <= 8; i += 1) {
    const script = `scripts/validate-m${i}.mjs`;
    if (existsSync(join(ROOT, script))) gates.push({ id: `M${i}`, script });
  }
  // Q is the K.9 coverage & quality gate. D.0 defines P and M0–M8; K.9 makes
  // the thresholds normative, so they are enforced as their own gate rather
  // than folded into M8 (which would double its runtime).
  if (existsSync(join(ROOT, 'scripts/validate-coverage.mjs'))) {
    gates.push({ id: 'Q', script: 'scripts/validate-coverage.mjs' });
  }
  return gates;
}

/** Run one gate synchronously (P/M0 prefix + M8/Q suffix path). */
function runGateSync(gate) {
  const jsonPath = join(jsonDir, `gate-${gate.id}.json`);
  const started = Date.now();
  const res = run(process.execPath, [gate.script, '--json', jsonPath], { cwd: ROOT, timeoutMs: 900_000 });
  return finishGate(gate, jsonPath, res, Date.now() - started);
}

/**
 * Spawn one gate as a child process (M1–M7 fan-out path). Resolves to the
 * same result record `runGateSync` returns; the caller preserves order when
 * assembling `results` so `--json` output stays deterministic.
 */
function spawnGate(gate) {
  const jsonPath = join(jsonDir, `gate-${gate.id}.json`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [gate.script, '--json', jsonPath], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      resolve(finishGate(gate, jsonPath, { ok: false, stdout, stderr: `${stderr}\nspawn error: ${err.message}` }, Date.now() - started));
    });
    child.on('close', (code) => {
      resolve(finishGate(gate, jsonPath, { ok: (code ?? 1) === 0, stdout, stderr }, Date.now() - started));
    });
  });
}

function finishGate(gate, jsonPath, res, ms) {
  let summary = {};
  try {
    summary = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch { /* the gate may have failed before writing a bundle */ }
  const status = res.ok ? 'pass' : 'fail';
  return {
    record: {
      id: gate.id,
      script: gate.script,
      status,
      ms,
      passed: summary.passed ?? null,
      failedChecks: summary.failed ?? null,
      skipped: summary.skipped ?? null,
      evidence: jsonPath,
    },
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function printResult(record, stdout, stderr) {
  if (quiet) return;
  const counts = record.passed == null ? '' : ` (${record.passed} passed, ${record.failedChecks} failed, ${record.skipped} skipped)`;
  process.stdout.write(`  gate:${record.id.padEnd(3)} ${record.status.toUpperCase().padEnd(5)} ${String(record.ms).padStart(6)}ms${counts}\n`);
  if (record.status === 'fail') {
    const tail = `${stdout}\n${stderr}`.split('\n').slice(-25).join('\n');
    process.stdout.write(`${tail}\n`);
  }
}

mkdirSync(jsonDir, { recursive: true });

const results = [];
let failed = false;

// ── Phase 1 (serial, stop-at-first-fail): P → M0 ────────────────────────────
const all = gateList();
const prefix = all.filter((g) => g.id === 'P' || g.id === 'M0');
const middle = all.filter((g) => /^M[1-7]$/.test(g.id));
const suffix = all.filter((g) => !prefix.includes(g) && !middle.includes(g));

for (const gate of prefix) {
  if (failed) {
    results.push({ id: gate.id, status: 'skipped', reason: 'a lower gate failed' });
    continue;
  }
  if (upto && gate.id !== 'P' && !isAtOrBelow(gate.id, upto)) {
    results.push({ id: gate.id, status: 'skipped', reason: `--upto ${upto}` });
    continue;
  }
  const { record, stdout, stderr } = runGateSync(gate);
  if (record.status === 'fail') failed = true;
  results.push(record);
  printResult(record, stdout, stderr);
}

// ── Phase 2 (concurrent fan-out): M1–M7 ─────────────────────────────────────
// B14: the FIRST sanctioned Promise.all in production-adjacent code (see the
// header note). Each child writes only its own gate-<ID>.json, so there is no
// shared mutable state; order is restored when assembling `results`.
if (!failed) {
  const runnable = middle.filter((gate) => !(upto && !isAtOrBelow(gate.id, upto)));
  for (const gate of middle) {
    if (upto && !isAtOrBelow(gate.id, upto)) {
      results.push({ id: gate.id, status: 'skipped', reason: `--upto ${upto}` });
    }
  }
  // Promise.all over promise-wrapped spawns: every child runs to completion
  // (no fail-fast inside the fan-out), and M1–M7 failures are reported
  // together. A P/M0 failure above skips this phase entirely.
  const settled = await Promise.all(runnable.map((gate) => spawnGate(gate)));
  for (const { record, stdout, stderr } of settled) {
    if (record.status === 'fail') failed = true;
    results.push(record);
    printResult(record, stdout, stderr);
  }
} else {
  for (const gate of middle) {
    results.push({ id: gate.id, status: 'skipped', reason: 'a lower gate failed' });
  }
}

// ── Phase 3 (serial): M8, Q — after the M1–M7 fan-in ─────────────────────────
for (const gate of suffix) {
  if (failed) {
    results.push({ id: gate.id, status: 'skipped', reason: 'a lower gate failed' });
    continue;
  }
  if (upto && gate.id !== 'P' && !isAtOrBelow(gate.id, upto)) {
    results.push({ id: gate.id, status: 'skipped', reason: `--upto ${upto}` });
    continue;
  }
  const { record, stdout, stderr } = runGateSync(gate);
  if (record.status === 'fail') failed = true;
  results.push(record);
  printResult(record, stdout, stderr);
}

if (!quiet) {
  const ran = results.filter((r) => r.status !== 'skipped');
  const passed = ran.filter((r) => r.status === 'pass').length;
  process.stdout.write(`\n  ${passed}/${ran.length} gates passed\n`);
  process.stdout.write(`  evidence: ${jsonDir}\n`);
}

if (argv.includes('--json')) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
process.exit(failed ? 1 : 0);

function isAtOrBelow(id, limit) {
  const n = Number(String(id).replace(/^M/, ''));
  const m = Number(String(limit).replace(/^M/, ''));
  if (Number.isNaN(n) || Number.isNaN(m)) return true;
  return n <= m;
}
