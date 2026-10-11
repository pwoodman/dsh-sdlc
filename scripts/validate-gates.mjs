#!/usr/bin/env node
/**
 * scripts/validate-gates.mjs — run every milestone gate in order (spec v3 D.0).
 *
 * Runs P → M0 → M1 → … up to the highest milestone script present, stopping at
 * the first gate that fails (G.5: "a PR that breaks a lower gate is blocked").
 *
 *   node scripts/validate-gates.mjs [--upto M4] [--json-dir .validation] [--quiet]
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
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

mkdirSync(jsonDir, { recursive: true });

const results = [];
let failed = false;

for (const gate of gateList()) {
  if (failed) {
    results.push({ id: gate.id, status: 'skipped', reason: 'a lower gate failed' });
    continue;
  }
  if (upto && gate.id !== 'P' && !isAtOrBelow(gate.id, upto)) {
    results.push({ id: gate.id, status: 'skipped', reason: `--upto ${upto}` });
    continue;
  }
  const jsonPath = join(jsonDir, `gate-${gate.id}.json`);
  const started = Date.now();
  const res = run('node', [gate.script, '--json', jsonPath], { cwd: ROOT, timeoutMs: 900_000 });
  const ms = Date.now() - started;
  let summary = {};
  try {
    summary = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch { /* the gate may have failed before writing a bundle */ }
  const status = res.ok ? 'pass' : 'fail';
  if (status === 'fail') failed = true;
  results.push({
    id: gate.id,
    script: gate.script,
    status,
    ms,
    passed: summary.passed ?? null,
    failedChecks: summary.failed ?? null,
    skipped: summary.skipped ?? null,
    evidence: jsonPath,
  });
  if (!quiet) {
    const counts = summary.passed == null ? '' : ` (${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped)`;
    process.stdout.write(`  gate:${gate.id.padEnd(3)} ${status.toUpperCase().padEnd(5)} ${String(ms).padStart(6)}ms${counts}\n`);
    if (status === 'fail') {
      const tail = `${res.stdout}\n${res.stderr}`.split('\n').slice(-25).join('\n');
      process.stdout.write(`${tail}\n`);
    }
  }
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
