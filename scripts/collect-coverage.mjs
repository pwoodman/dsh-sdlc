#!/usr/bin/env node
/**
 * scripts/collect-coverage.mjs — run the offline layers ONCE under coverage and
 * persist the parsed table to `.validation/coverage.json` (TRACK B, B8).
 *
 * WHY THIS EXISTS. Before B8 three different commands each re-ran the full
 * offline suite under `--experimental-test-coverage`: `gate:Q`
 * (validate-coverage.mjs), the M8 full-suite check (validate-m8.mjs), and the
 * ad-hoc `test:coverage` script. On a 906-test suite that is three identical
 * ~50s instrumented runs for one number. This script runs the suite exactly
 * once and writes the parseable artifact; `validate-coverage.mjs` (Q) and the
 * M8 coverage consumer read the artifact when it is fresh instead of
 * re-spawning the suite, falling back to the old in-process run when absent.
 *
 * The artifact is advisory, never authoritative: it carries a freshness marker
 * (git SHA + newest mtime of packages/<pkg>/src and the test layers) so a stale
 * file is ignored rather than trusted. "Fresh" means same HEAD and no source
 * or test file newer than the artifact.
 *
 *   node scripts/collect-coverage.mjs [--json .validation/coverage.json]
 *
 * Offline and deterministic: no model, no network.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');

export const LAYERS = ['tests/unit', 'tests/contract', 'tests/integration', 'tests/fault', 'tests/adversarial'];
export const DEFAULT_ARTIFACT = join(ROOT, '.validation', 'coverage.json');

/**
 * Newest mtime (ms) under the source trees and test layers the coverage run
 * instruments. Anything newer than the artifact invalidates it.
 */
export function newestSourceMtime({ root = ROOT } = {}) {
  let newest = 0;
  const consider = (p) => {
    try {
      const st = statSync(p);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* missing path: not newer than anything */ }
  };
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(mjs|js|cjs)$/.test(e.name)) consider(full);
    }
  };
  walk(join(root, 'packages'));
  for (const layer of LAYERS) walk(join(root, layer));
  return newest;
}

export function headSha({ cwd = ROOT } = {}) {
  const res = run('git', ['rev-parse', 'HEAD'], { cwd });
  return res.ok ? res.stdout.trim() : null;
}

/** Parse Node's `--experimental-test-coverage` stdout table (same grammar as validate-coverage.mjs). */
export function parseCoverageTable(output) {
  const lines = String(output ?? '').split('\n');
  const packages = {};
  let current = null;
  let overall = null;
  for (const raw of lines) {
    const line = raw.replace(/^[\u001B\[[0-9;]*m/g, '').replace(/^[ℹ#]\s?/, '');
    const header = line.match(/^\s{1,2}(sdlc-[A-Za-z0-9_-]+)\s+\|\s*\|\s*\|\s*\|/);
    if (header) {
      current = header[1];
      packages[current] ??= { name: current, files: [] };
      continue;
    }
    const file = line.match(/^\s+([\w.-]+\.(?:js|mjs|cjs))\s+\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|(.*)$/);
    if (file && current) {
      packages[current].files.push({
        file: file[1],
        lines: Number(file[2]),
        branches: Number(file[3]),
        functions: Number(file[4]),
        uncovered: file[5].trim(),
      });
      continue;
    }
    const all = line.match(/^all files\s+\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    if (all) overall = { lines: Number(all[1]), branches: Number(all[2]), functions: Number(all[3]) };
  }
  return { packages, overall };
}

export function collectCoverage({ layers = LAYERS, cwd = ROOT, timeoutMs = 900_000 } = {}) {
  const args = [
    '--test', '--experimental-test-coverage',
    '--test-coverage-include=packages/*/src/**',
    ...layers.map((l) => `${l.replace(/\/+$/, '')}/**/*.test.mjs`),
  ];
  const res = spawnSync('node', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const { packages, overall } = parseCoverageTable(output);
  // Summary counts (ℹ and # forms); best effort, informational only.
  let pass = null, fail = null, tests = null;
  for (const m of output.matchAll(/^[ℹ#]\s*(tests|pass|fail)\s+(\d+)\s*$/gm)) {
    if (m[1] === 'tests') tests = Number(m[2]);
    if (m[1] === 'pass') pass = Number(m[2]);
    if (m[1] === 'fail') fail = Number(m[2]);
  }
  return {
    ok: res.status === 0,
    exitCode: res.status,
    overall,
    packages,
    counts: { tests, pass, fail },
    packageCount: Object.keys(packages).length,
    output,
  };
}

export function writeArtifact(path, collected, { root = ROOT } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const artifact = {
    version: 1,
    producedAt: new Date().toISOString(),
    node: process.version,
    headSha: headSha({ cwd: root }),
    newestSourceMtimeMs: newestSourceMtime({ root }),
    overall: collected.overall,
    packages: collected.packages,
    counts: collected.counts,
    exitCode: collected.exitCode,
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n');
  return artifact;
}

/**
 * Read a previously written artifact, or null when it is missing, malformed,
 * or stale (different HEAD, or any source/test file newer than the artifact).
 */
export function readArtifact(path = DEFAULT_ARTIFACT, { root = ROOT } = {}) {
  if (!existsSync(path)) return null;
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!doc || doc.version !== 1 || !doc.overall || !doc.packages) return null;
  try {
    const st = statSync(path);
    if ((doc.newestSourceMtimeMs ?? 0) < newestSourceMtime({ root })) return null;
    if (st.mtimeMs < (doc.newestSourceMtimeMs ?? 0)) return null;
    const sha = headSha({ cwd: root });
    if (sha && doc.headSha && sha !== doc.headSha) return null;
  } catch { return null; }
  return doc;
}

function main() {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf('--json');
  const outPath = jsonIdx >= 0 ? argv[jsonIdx + 1] : DEFAULT_ARTIFACT;
  const collected = collectCoverage();
  const artifact = writeArtifact(outPath, collected);
  if (artifact.overall) {
    process.stdout.write(
      `coverage: ${collected.counts.pass ?? '?'} passed, overall ${artifact.overall.lines}% lines across ${collected.packageCount} packages → ${outPath}\n`,
    );
  } else {
    process.stdout.write(`coverage: no table parsed (exit ${collected.exitCode}); artifact still written → ${outPath}\n`);
  }
  process.exit(collected.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export default { collectCoverage, parseCoverageTable, readArtifact, writeArtifact, LAYERS, DEFAULT_ARTIFACT };
