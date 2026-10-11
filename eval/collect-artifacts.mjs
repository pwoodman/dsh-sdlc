#!/usr/bin/env node
/**
 * eval/collect-artifacts.mjs — produce the pinned-toolchain artifacts that turn
 * dark endpoints into measured ones.
 *
 * The offline collectors are honest proxies (regex scans, window clone ratios);
 * the protocol (§5) requires the authoritative tools before any public claim:
 * line coverage, dependency audit, and load numbers. This script runs those
 * tools over finished arm workspaces and writes the artifacts metrics.mjs
 * already knows how to read:
 *
 *   node eval/collect-artifacts.mjs --dir <workspace> [--coverage] [--audit] [--load <url>] [--out <artifacts.json>]
 *
 *   --coverage   per-file node --experimental-test-coverage over tests/
 *                (needs node ≥22; writes {coverage:{value:<line pct>}}; never
 *                `node --test`, which a parent `node --test` runner refuses)
 *   --audit      npm audit --json (needs network + package.json; writes
 *                {audit:{value:<vuln count>}})
 *   --load <url> k6 if present, else autocannon if present, else node:http
 *                smoke (writes {load:{value:<p95 ms>}} — error-rate lives in
 *                the sibling {errorRate} key the runner maps to `error-rate`)
 *
 * Every probe is best-effort: a missing tool writes nothing and is reported on
 * stderr, never as a zero. The JSON file it writes (default
 * `<workspace>/artifacts.json`) is picked up by `evaluateAcceptance`'s callers
 * via `collectMetrics(dir, {artifacts})`, or merged by hand into a record.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

function run(cmd, args, { cwd, timeout = 300_000, env = undefined } = {}) {
  try {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error ?? null };
  } catch (err) {
    return { status: null, stdout: '', stderr: '', error: err };
  }
}

function hasCommand(cmd) {
  const probe = run(cmd, ['--version'], { timeout: 20_000 });
  return probe.status === 0;
}

/** Coverage: run each test file directly under node's coverage reporter. */
function collectCoverage(dir) {
  const testsDir = join(dir, 'tests');
  if (!existsSync(testsDir)) return { ok: false, reason: 'no tests/ directory — nothing to cover' };
  // NOTE: never `node --test` here. Under a parent `node --test` the runner
  // refuses ("run() is being called recursively … skipping running files")
  // and the child prints nothing — the same call works fine from a plain
  // `node` process, but per-file `node --experimental-test-coverage <file>`
  // works in BOTH, so use that everywhere.
  const testFiles = [];
  try {
    const walk = (rel) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const sub = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(sub);
        else if (e.isFile() && /\.m?js$/.test(e.name)) testFiles.push(sub);
      }
    };
    walk('tests');
  } catch { /* tests/ vanished mid-run */ }
  if (!testFiles.length) return { ok: false, reason: 'no runnable test files under tests/' };
  const rows = [];
  let ran = 0;
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  for (const f of testFiles) {
    // --test-reporter=spec: human-readable text with the | table (the
    // default TAP framing is binary under capture and buries it).
    const res = run('node', ['--experimental-test-coverage', '--test-reporter=spec', f], { cwd: dir, timeout: 300_000, env: childEnv });
    if (res.status === 0) ran += 1;
    for (const rawLine of `${res.stdout}\n${res.stderr}`.split('\n')) {
      const line = rawLine.replace(/^ℹ\s*/, '');
      if (!line.includes('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 2) continue;
      const name = cells[0];
      if (!name || name === 'file' || /^all files$/i.test(name)) continue;
      const linePct = Number(cells[1]);
      if (!Number.isFinite(linePct)) continue; // directory row
      if (!name.includes('.')) continue; // not a file row
      if (/(^|\/)tests?\//i.test(name) || /\.(test|spec)\.[a-z0-9]+$/i.test(name)) continue;
      rows.push({ file: name.trim(), linePct });
    }
  }
  if (rows.length) {
    const mean = rows.reduce((a, r) => a + r.linePct, 0) / rows.length;
    return { ok: true, artifact: { value: Number(mean.toFixed(2)), note: `node --experimental-test-coverage over ${ran}/${testFiles.length} test file(s), ${rows.length} source row(s)` } };
  }
  return { ok: false, reason: `coverage reporter produced no per-file rows (${ran}/${testFiles.length} test file(s) exited 0)` };
}

/** Audit: npm audit --json, reduced to a count via metadata.vulnerabilities. */
function collectAudit(dir) {
  if (!existsSync(join(dir, 'package.json'))) return { ok: false, reason: 'no package.json — nothing to audit' };
  if (!hasCommand('npm')) return { ok: false, reason: 'npm is not installed' };
  if (!existsSync(join(dir, 'package-lock.json')) && !existsSync(join(dir, 'npm-shrinkwrap.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const depCount = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.peerDependencies ?? {}).length + Object.keys(pkg.optionalDependencies ?? {}).length;
      if (depCount === 0) return { ok: true, artifact: { value: 0, note: 'no lockfile but no runtime dependencies to audit' } };
    } catch { /* fall through to the unavailable reason */ }
    return { ok: false, reason: 'no lockfile — npm audit needs package-lock.json (and dependency-free packages report 0 without network)' };
  }
  const res = run('npm', ['audit', '--json'], { cwd: dir, timeout: 300_000 });
  try {
    const doc = JSON.parse(res.stdout);
    const total = doc?.metadata?.vulnerabilities?.total;
    if (typeof total === 'number') return { ok: true, artifact: { value: total, note: `npm audit --json metadata.vulnerabilities.total` } };
    const v = doc?.metadata?.vulnerabilities;
    if (v && typeof v === 'object') {
      const total2 = ['info', 'low', 'moderate', 'high', 'critical'].reduce((n, k) => n + (Number(v[k]) || 0), 0);
      return { ok: true, artifact: { value: total2, note: 'npm audit --json summed severities' } };
    }
    return { ok: false, reason: 'npm audit --json had no metadata.vulnerabilities' };
  } catch {
    return { ok: false, reason: `npm audit output was not JSON (exit ${res.status})` };
  }
}

/** Load: k6 > autocannon > node:http smoke, reporting p95 + error rate. */
function collectLoad(url) {
  if (hasCommand('k6')) {
    const script = `import http from 'k6/http';\nimport { check } from 'k6';\nexport const options = { vus: 10, duration: '20s' };\nexport default function () { const r = http.get(${JSON.stringify(url)}); check(r, { ok: (x) => x.status < 500 }); }\n`;
    const tmp = join(ROOT, '.eval-load-k6.js');
    writeFileSync(tmp, script);
    const res = run('k6', ['run', '--quiet', tmp], { cwd: ROOT, timeout: 300_000 });
    const m = /http_req_duration[^|]*p\(95\)=([0-9.]+)(ms|s)?/.exec(res.stdout);
    if (m) {
      const p95 = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
      return { ok: true, artifact: { value: Number(p95.toFixed(1)), note: 'k6 http_req_duration p(95), 10 VUs × 20s' } };
    }
    return { ok: false, reason: 'k6 ran but reported no p(95)' };
  }
  // Fallback: 200 sequential node:http GETs; honest about being a smoke test.
  return collectLoadSmoke(url);
}

function collectLoadSmoke(url) {
  const probe = run('node', ['-e', `
const t0 = Date.now();
const lat = [];
let errors = 0;
const N = 50;
let done = 0;
for (let i = 0; i < N; i++) {
  const s = Date.now();
  fetch(${JSON.stringify(url)}).then(async (r) => {
    lat.push(Date.now() - s);
    if (r.status >= 500) errors += 1;
    await r.arrayBuffer().catch(() => {});
  }).catch(() => { errors += 1; }).finally(() => {
    if (++done === N) {
      lat.sort((a, b) => a - b);
      const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null;
      console.log(JSON.stringify({ p95, errors, n: N }));
    }
  });
}
  `.trim()], { timeout: 120_000 });
  try {
    const doc = JSON.parse(probe.stdout.trim().split('\n').pop());
    if (typeof doc.p95 === 'number') {
      return { ok: true, artifact: { value: doc.p95, note: `node:http smoke: 50 sequential GETs, ${doc.errors} errors`, errorRate: doc.errors / doc.n } };
    }
    return { ok: false, reason: 'smoke probe produced no p95' };
  } catch {
    return { ok: false, reason: `smoke probe failed: ${(probe.stderr || '').slice(0, 200)}` };
  }
}

function main() {
  const dir = resolve(flag('--dir', null) ?? (() => { process.stderr.write('eval: --dir <workspace> is required\n'); process.exit(2); })());
  const wantCoverage = process.argv.includes('--coverage');
  const wantAudit = process.argv.includes('--audit');
  const loadUrl = flag('--load', null);
  const outPath = resolve(flag('--out', join(dir, 'artifacts.json')));
  if (!wantCoverage && !wantAudit && !loadUrl) {
    process.stderr.write('eval: nothing requested — pass --coverage, --audit, or --load <url>\n');
    process.exit(2);
  }
  const artifacts = {};
  if (wantCoverage) {
    const r = collectCoverage(dir);
    if (r.ok) artifacts.coverage = r.artifact;
    else process.stderr.write(`eval: coverage unavailable: ${r.reason}\n`);
  }
  if (wantAudit) {
    const r = collectAudit(dir);
    if (r.ok) artifacts.audit = r.artifact;
    else process.stderr.write(`eval: audit unavailable: ${r.reason}\n`);
  }
  if (loadUrl) {
    const r = collectLoad(loadUrl);
    if (r.ok) {
      artifacts.load = r.artifact;
      if (typeof r.artifact.errorRate === 'number') artifacts.errorRate = { value: r.artifact.errorRate, note: r.artifact.note };
    } else process.stderr.write(`eval: load unavailable: ${r.reason}\n`);
  }
  mkdirSync(join(outPath, '..'), { recursive: true });
  let merged = { ...artifacts };
  if (existsSync(outPath)) {
    try {
      merged = { ...JSON.parse(readFileSync(outPath, 'utf8')), ...artifacts };
    } catch { /* overwrite */ }
  }
  writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
  process.stdout.write(`eval: artifacts → ${outPath} (${Object.keys(artifacts).join(', ') || 'none collected'})\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

// `hasCommand` is exported so tests can branch on the tool being present
// instead of asserting a value only an npm/k6-equipped host can produce.
export { collectCoverage, collectAudit, collectLoad, hasCommand };
export default { collectCoverage, collectAudit, collectLoad, hasCommand };
