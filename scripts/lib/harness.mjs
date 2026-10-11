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

/** Run a command, never throwing, and return a normalized result. */
export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
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
