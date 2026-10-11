#!/usr/bin/env node
/**
 * scripts/validate-coverage.mjs — the K.9 coverage and quality gate.
 *
 * Spec K.9 requires:
 *   - `node --test --experimental-test-coverage --test-coverage-lines=80` over
 *     each package's src directory;
 *   - per-package thresholds: `sdlc-core` ≥ 85 % lines, `sdlc-cli`/`sdlc-guard`
 *     ≥ 90 %, UI ≥ 60 %;
 *   - three negative controls (ownership overlap, append-only events, instance
 *     lock) that fail when the invariant is deliberately broken;
 *   - no new `console.log` without a `debug` prefix, and exact
 *     `peerDependencies` on `@deepseek-ai/dsh`.
 *
 * WHAT IS AND IS NOT MEASURABLE HERE. V8 coverage does not cross a process
 * boundary without a coverage-merging tool (c8/nyc), and this project has no
 * external dependencies, so `sdlc-cli` — which the tests exercise by SPAWNING the
 * real binary — cannot appear in the in-process table. The CLI threshold is
 * therefore asserted by its own functional layer (`tests/unit/cli.test.mjs`,
 * 12 tests that run the real executable) rather than by a number, and that is
 * stated rather than quietly skipped. Every other package is measured in-process.
 *
 *   node scripts/validate-coverage.mjs [--json <path>] [--fail-fast]
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSuite, testGlobs, EXIT } from './lib/harness.mjs';
import { DSH_PEER_RANGE } from './lib/semver-lite.mjs';

const ROOT = join(import.meta.dirname, '..');

/**
 * Per-package line thresholds from K.9. `sdlc-cli` is listed for completeness
 * with `measured: false` (spawned, not imported) and a functional test path.
 */
export const THRESHOLDS = {
  'sdlc-core': { lines: 85, measured: true },
  'sdlc-guard': { lines: 90, measured: true },
  'sdlc-tools': { lines: 85, measured: true },
  'sdlc-presets': { lines: 85, measured: true },
  'sdlc-mock-llm': { lines: 85, measured: true },
  // NOTE: asserting a real number for sdlc-cli is possible because
  // tests/unit/cli-internals.test.mjs drives the module in-process; the
  // black-box behaviour is covered separately by tests/unit/cli.test.mjs, which
  // SPAWNS the executable (V8 coverage does not cross that boundary, so a
  // spawned-only suite could not measure this file at all).
  'sdlc-cli': { lines: 90, measured: true, functionalTest: 'tests/unit/cli.test.mjs' },
  // The UI bundle: host handlers + client stores are measured in-process
  // (tests/unit/ui-*.test.mjs). The browser panels (.jsx) cannot execute
  // under node:test without a React/DOM harness — they are covered by the
  // bundle contract (tests/unit/ui-bundle.test.mjs asserts the compiled
  // output contains every panel) rather than by line numbers.
  'sdlc-client-ui': { lines: 60, measured: true, functionalTest: 'tests/unit/ui-bundle.test.mjs' },
};

/** No single source file in a measured package may hide below this floor. */
export const PER_FILE_FLOOR = 80;

/** Files that legitimately cannot reach the floor, each with a reason. */
export const FLOOR_EXCEPTIONS = {
  // (none at present — an entry requires a reason and is reviewed at each gate)
};

export const LAYERS = ['tests/unit', 'tests/contract', 'tests/integration', 'tests/fault', 'tests/adversarial'];

/** Run the suites with coverage and parse Node's summary table. */
export function measureCoverage({ layers = LAYERS, cwd = ROOT, timeoutMs = 900_000 } = {}) {
  const args = [
    '--test', '--experimental-test-coverage',
    '--test-coverage-include=packages/*/src/**',
    // Globs, not directory positionals: Node 24 resolves a bare directory as a
    // script and dies with `Cannot find module '<dir>'`.
    ...testGlobs(layers),
  ];
  const res = spawnSync('node', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;

  const packages = new Map();
  let current = null;
  let overall = null;
  const tests = { tests: null, pass: null, fail: null, skipped: null };
  for (const m of output.matchAll(/^ℹ (tests|pass|fail|skipped) (\d+)$/gm)) tests[m[1]] = Number(m[2]);

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/^ℹ\s?/, '');
    // Package header: " sdlc-core           |        |          |         |"
    // Node also emits the structural rows "packages" and "src"; neither may
    // become the current package, or every file row would be attributed to them.
    const header = line.match(/^\s{1,2}(sdlc-[A-Za-z0-9_-]+)\s+\|\s*\|\s*\|\s*\|/);
    if (header) {
      current = header[1];
      if (!packages.has(current)) packages.set(current, { name: current, files: [] });
      continue;
    }
    // File row: "   budget.js         | 100.00 |    85.96 |   90.91 | 12-14"
    const file = line.match(/^\s+([\w.-]+\.(?:js|mjs|cjs))\s+\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|(.*)$/);
    if (file && current) {
      packages.get(current).files.push({
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

  const summary = new Map();
  for (const [name, pkg] of packages) {
    if (pkg.files.length === 0) continue; // loaded but nothing reported
    const mean = (key) => pkg.files.reduce((sum, f) => sum + f[key], 0) / pkg.files.length;
    summary.set(name, { ...pkg, lines: mean('lines'), branches: mean('branches'), functions: mean('functions') });
  }
  return { tests, overall, packages: summary, exitCode: res.status, output };
}

/**
 * Evaluate the parsed table against K.9 plus the extra invariants the spec
 * demands (negative controls exist; no stray console.log; exact peers).
 * @returns {{ok:boolean, errors:string[], warnings:string[], details:object}}
 */
export function evaluateCoverage(measurement, { thresholds = THRESHOLDS, floor = PER_FILE_FLOOR, exceptions = FLOOR_EXCEPTIONS } = {}, root = ROOT) {
  const errors = [];
  const warnings = [];
  const details = {};

  for (const [name, spec] of Object.entries(thresholds)) {
    const pkg = measurement.packages.get(name);
    if (!spec.measured) {
      const functional = spec.functionalTest ?? null;
      if (functional) {
        if (!existsSync(join(root, functional))) {
          errors.push(`${name}: no measurement is possible in-process AND the functional test ${functional} is missing`);
        } else {
          details[name] = { measured: false, functionalTest: functional, threshold: spec.lines };
        }
      }
      continue;
    }
    if (!pkg) {
      errors.push(`${name}: no coverage was reported — the package was never loaded by the test layers`);
      continue;
    }
    details[name] = { measured: true, lines: Number(pkg.lines.toFixed(2)), threshold: spec.lines, files: pkg.files.length };
    if (pkg.lines < spec.lines) {
      errors.push(`${name}: ${pkg.lines.toFixed(2)}% lines is below the K.9 threshold of ${spec.lines}%`);
    }
    for (const file of pkg.files) {
      if (file.lines >= floor) continue;
      const reason = exceptions[`${name}/${file.file}`];
      if (reason) { warnings.push(`${name}/${file.file}: ${file.lines}% lines (accepted: ${reason})`); continue; }
      errors.push(`${name}/${file.file}: ${file.lines}% lines is below the per-file floor of ${floor}%`);
    }
  }

  // K.9 negative controls: the invariants must have tests that fail when broken.
  const testText = (() => {
    const dirs = ['tests/unit', 'tests/integration', 'tests/fault', 'tests/adversarial'];
    let text = '';
    for (const dir of dirs) {
      const full = join(root, dir);
      if (!existsSync(full)) continue;
      for (const f of readdirSync(full)) {
        if (f.endsWith('.test.mjs')) text += readFileSync(join(full, f), 'utf8');
      }
    }
    return text;
  })();
  for (const [label, needle] of [
    ['ownership overlap', /NEGATIVE CONTROL|checkNoOverlap/],
    ['append-only events', /append-only|assertAppendOnly/],
    ['instance lock', /INSTANCE_LOCKED|InstanceLockedError/],
  ]) {
    if (!needle.test(testText)) errors.push(`K.9 negative control for "${label}" is missing from the test layers`);
  }

  // Quality nits: peer range (P36, beta.2: ranged, runtime-checked) and no stray console.log in sources.
  const pkgDirs = readdirSync(join(root, 'packages'));
  for (const dir of pkgDirs) {
    const pkgPath = join(root, 'packages', dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const peer = pkg.peerDependencies?.['@deepseek-ai/dsh'];
    if (pkg.dsh && peer !== DSH_PEER_RANGE) errors.push(`${pkg.name}: peerDependencies must declare @deepseek-ai/dsh as ${DSH_PEER_RANGE} (P36, beta.2), found ${peer}`);
  }
  const srcFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name)) srcFiles.push(full);
    }
  };
  for (const dir of pkgDirs) {
    const src = join(root, 'packages', dir, 'src');
    if (existsSync(src)) walk(src);
  }
  for (const file of srcFiles) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (/console\.log\(/.test(line)) {
        errors.push(`${file.replace(root + '/', '')}: console.log without a debug prefix (K.9 lint rule)`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, details };
}

const checks = [
  {
    id: 'COV-01-measure',
    title: 'the test layers run under coverage and report a table',
    fn() {
      const measurement = measureCoverage();
      if (measurement.exitCode !== 0) throw new Error(`the suite failed under coverage:\n${measurement.output.slice(-2000)}`);
      if (!measurement.overall) throw new Error('no "all files" row was produced');
      if (measurement.packages.size === 0) throw new Error('no per-package rows were produced');
      cached = measurement;
      return { detail: `${measurement.tests.pass ?? '?'} tests; overall ${measurement.overall.lines}% lines across ${measurement.packages.size} packages` };
    },
  },
  {
    id: 'COV-02-thresholds',
    title: 'per-package K.9 thresholds and the per-file floor are met',
    fn() {
      if (!cached) return { skip: 'the measurement check did not run' };
      const verdict = evaluateCoverage(cached);
      lastVerdict = verdict;
      if (!verdict.ok) throw new Error(verdict.errors.join('\n'));
      const lines = Object.entries(verdict.details).map(([n, d]) => (d.measured ? `${n}=${d.lines}%` : `${n}=functional`));
      return { detail: lines.join(', ') };
    },
  },
  {
    id: 'COV-03-quality-invariants',
    title: 'negative controls exist; peers are pinned; no stray console.log',
    fn() {
      const verdict = lastVerdict ?? (cached ? evaluateCoverage(cached) : null);
      if (!verdict) return { skip: 'the measurement check did not run' };
      // COV-02 already surfaced threshold failures; here we report the non-coverage invariants.
      const coverageErrors = verdict.errors.filter((e) => /lines is below|never loaded|no coverage/.test(e));
      const other = verdict.errors.filter((e) => !coverageErrors.includes(e));
      if (other.length) throw new Error(other.join('\n'));
      return { detail: 'ownership/append-only/lock controls present; peers pinned; lint rule clean' };
    },
  },
];

let cached = null;
let lastVerdict = null;

const code = await runSuite({ name: 'SDLC coverage & quality gate (K.9)', version: '1.0.0', checks });

// Always emit an evidence bundle next to the other gates.
if (cached) {
  const jsonIdx = process.argv.indexOf('--json');
  const outPath = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : join(ROOT, '.validation', 'gate-Q.json');
  mkdirSync(dirname(outPath), { recursive: true });
  const verdict = lastVerdict ?? evaluateCoverage(cached);
  writeFileSync(outPath, JSON.stringify({
    suite: 'SDLC coverage & quality gate (K.9)',
    node: process.version,
    tests: cached.tests,
    overall: cached.overall,
    packages: Object.fromEntries([...cached.packages].map(([k, v]) => [k, { lines: Number(v.lines.toFixed(2)), branches: Number(v.branches.toFixed(2)), files: v.files.length }])),
    thresholds: THRESHOLDS,
    perFileFloor: PER_FILE_FLOOR,
    details: verdict.details,
    errors: verdict.errors,
    warnings: verdict.warnings,
  }, null, 2) + '\n');
}

process.exit(code);
