/**
 * Shared check harness for the SDLC orchestrator validation suites.
 *
 * Design rules (these are the fixes to the v2 C.8.1 script):
 *   - ESM only: every import is a static `import`, never `require()`.
 *   - Deterministic by default: a check must not call an LLM, hit the network,
 *     or depend on wall-clock ordering unless it is explicitly tagged `live`.
 *   - Run every check, then report. `--fail-fast` restores stop-at-first-failure.
 *   - Machine-readable: `--json <path>` writes an evidence bundle suitable for
 *     a CI artifact (versions, git SHA, per-check result, durations).
 *   - A check returns `{ ok, detail? }`, throws for failure, or returns
 *     `{ skip: reason }` for an explicitly unavailable prerequisite.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const EXIT = { PASS: 0, FAIL: 1, USAGE: 2 };

/** The offline test layers, in the order the gates run them. */
export const TEST_LAYERS = ['tests/unit', 'tests/contract', 'tests/integration', 'tests/fault', 'tests/adversarial'];

// CONCURRENCY POLICY (TRACK B, B12 — measured, do not "tune" blindly).
// `node --test` runs test FILES concurrently at its default level; the lever
// for this suite is per-test waste, not `--test-concurrency`. Measured on the
// contract layer (121 tests): default 1.36s, `--test-concurrency=1` 2.31s
// (2.1x slower serial), `--test-concurrency=8` 1.36s (no gain — the suite is
// CPU-bound on sqlite + bootstrap resampling, so extra workers only add
// scheduling overhead). Keep the default; fix wasteful tests instead
// (B10 reuses 12 DBs for 1,296 matrix cells; B11 trims bootstrap B 2000→200).

/**
 * Turn test-layer directories into `node --test` arguments.
 *
 * `node --test <dir>` is not portable across the engines this suite supports:
 * Node 24 refuses a directory positional with `Cannot find module '<dir>'` (it
 * is resolved as a script, not as a test path), while an explicit glob is
 * accepted by every Node ≥ 22. Pass a directory only if you also want to depend
 * on the runtime's own discovery rules.
 */
export function testGlobs(layers = TEST_LAYERS) {
  return layers.map((layer) => `${layer.replace(/\/+$/, '')}/**/*.test.mjs`);
}

/** Strip ANSI SGR sequences so a coloured reporter still parses. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001B\[[0-9;]*m/g, '');
}

/**
 * The `node --test` end-of-run summary, whatever shape this engine printed.
 *
 * Node's own reporter writes `ℹ pass 553`, but the same engine also emits the
 * plain TAP-ish form (`# pass 553`) depending on how the run terminated — the
 * bundled Node 24 here always writes the first, while the release runner on Node
 * 22 wrote the second after aborting. A gate that matched only `ℹ` therefore
 * read `fail=?` from a completely green suite and blocked a release. Return the
 * counts from whichever form is present (or `null` when the run printed none).
 *
 * @returns {{tests:number|null,pass:number|null,fail:number|null,skipped:number|null,durationMs:number|null}|null}
 */
export function summaryOf(output) {
  const text = stripAnsi(output);
  const patterns = [
    /^[\u2139#]\s*(tests|pass|fail|skipped|cancelled)\s+(\d+)\s*$/gm,
    /^[\u2139#]\s*duration_ms\s+([\d.]+)\s*$/gm,
  ];
  const counts = { tests: null, pass: null, fail: null, skipped: null, durationMs: null };
  let seen = false;
  for (const m of text.matchAll(patterns[0])) {
    counts[m[1]] = Number(m[2]);
    seen = true;
  }
  for (const m of text.matchAll(patterns[1])) counts.durationMs = Number(m[1]);
  if (!seen && counts.durationMs === null) return null;
  return counts;
}

/** Run a command, never throwing, and return a normalized result. */
export function run(cmd, args = [], opts = {}) {
  // Resolve 'node' to the running binary: PATH may not carry a `node` entry
  // (bundled runtimes), and spawning a bare name would fail or pick a wrong
  // toolchain. Every other command keeps its caller-supplied resolution.
  const bin = cmd === 'node' ? process.execPath : cmd;
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
    ok: res.status === 0,
  };
}

/** Run a command and require exit 0, else throw with the captured output. */
export function must(cmd, args = [], opts = {}) {
  const res = run(cmd, args, opts);
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || String(res.error ?? '')).trim().slice(0, 2000);
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.code}: ${detail}`);
  }
  return res;
}

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function withTempDir(prefix, fn) {
  const dir = tempDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A tiny deterministic PRNG so property tests are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} [spec.version]
 * @param {Array<{id:string,title:string,live?:boolean,fn:() => any}>} spec.checks
 * @param {string[]} [spec.argv]
 */
export async function runSuite({ name, version = '1', checks, argv = process.argv.slice(2) }) {
  const failFast = argv.includes('--fail-fast');
  const jsonIdx = argv.indexOf('--json');
  const jsonPath = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
  const only = argv.filter((a) => !a.startsWith('-') && a !== jsonPath);

  const selected = only.length ? checks.filter((c) => only.some((o) => c.id.includes(o))) : checks;

  process.stdout.write(`\n${name} v${version}\n${'='.repeat(name.length + version.length + 3)}\n\n`);

  const results = [];
  let failed = 0;
  let skipped = 0;

  for (const check of selected) {
    const started = Date.now();
    process.stdout.write(`  ${check.id.padEnd(28)} `);
    let outcome;
    try {
      const value = await check.fn();
      if (value && typeof value === 'object' && value.skip) {
        outcome = { status: 'skip', message: value.skip };
      } else {
        outcome = { status: 'pass', message: value?.detail ?? '' };
      }
    } catch (err) {
      outcome = { status: 'fail', message: err?.message ?? String(err) };
    }
    const ms = Date.now() - started;
    outcome.durationMs = ms;
    outcome.live = Boolean(check.live);
    outcome.title = check.title;
    results.push({ id: check.id, ...outcome });

    const mark = outcome.status === 'pass' ? 'PASS' : outcome.status === 'skip' ? 'SKIP' : 'FAIL';
    process.stdout.write(`${mark}  (${ms}ms)\n`);
    if (outcome.status !== 'pass' && outcome.message) {
      process.stdout.write(`      ${String(outcome.message).split('\n').join('\n      ')}\n`);
    }
    if (outcome.status === 'fail') {
      failed += 1;
      if (failFast) break;
    }
    if (outcome.status === 'skip') skipped += 1;
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  process.stdout.write(
    `\n  ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} run)\n`,
  );

  const bundle = {
    suite: name,
    suiteVersion: version,
    ran: results.length,
    passed,
    failed,
    skipped,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(),
    gitSha: run('git', ['rev-parse', 'HEAD']).stdout.trim() || null,
    startedAt: new Date().toISOString(),
    results,
  };

  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(bundle, null, 2) + '\n');
    process.stdout.write(`  evidence bundle: ${jsonPath}\n`);
  }

  return failed === 0 ? EXIT.PASS : EXIT.FAIL;
}
