#!/usr/bin/env node
/**
 * eval/run.mjs — run the A/B evaluation and emit append-only run records.
 *
 *   node eval/run.mjs --tasks eval/tasks --out .eval-out --executor simulate --repeats 3
 *   node eval/run.mjs --out .eval-out --executor dsh --live --repeats 5 \
 *     --provider devpass --model deepseek-v4.1-flash \
 *     --baseline-profile eval-control --treatment-profile eval-treatment
 *
 * Executors:
 *   simulate  Deterministic PLACEBO. Both arms receive the identical fixture and
 *             no simulated edits are applied, so a correct pipeline reports a
 *             null effect. This validates plumbing and statistics; it is NOT
 *             evidence about DSH. Records are marked SIMULATED.
 *   dsh       Real arms. `--live` is required because it spends money.
 *
 * Model pinning: `dsh` has no `--model` flag. `--provider`/`--model` here are
 * written into a DSH patch overlay passed to BOTH arms with `--patch`, so the
 * arms differ only in the composed profile — which is what the protocol claims.
 * The model actually observed in the run's session log is what gets recorded.
 *
 * A run whose executor fails is recorded `status:"invalid"` and a live study
 * stops at the first one: an arm that never ran is not a data point.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTasks } from './lib/manifest.mjs';
import { collectMetrics } from './lib/metrics.mjs';
import { appendRecord, makeRunId, readRecords, ARMS, ARM_LABELS } from './lib/records.mjs';
import { parseJsonl, sumUsage, usageFromSessionLog } from './lib/usage.mjs';
import { defaultDshHome, findSessionForRun } from './lib/session.mjs';
import { collectEnvironment } from './lib/env.mjs';
import { writeModelPatch } from './lib/model-patch.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

/** A flag's string value, or null — never the boolean `true` `flag()` returns. */
function flagStr(name) {
  const v = flag(name, null);
  return typeof v === 'string' ? v : null;
}

/** Deterministic pseudo-random value in [0,1) from a string seed. */
function hashUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

/**
 * Randomised arm order per (task, repeat), derived from the study seed.
 * Protocol §3 requires it so machine-load drift cannot favour one arm; deriving
 * it from a printed seed keeps the order reproducible without being fixed.
 */
export function armOrder(taskId, repeat, studySeed) {
  return hashUnit(`${studySeed}:${taskId}:${repeat}`) < 0.5 ? [...ARMS] : [...ARMS].reverse();
}

/**
 * Check that both arms can actually run one-shot and that they differ only in
 * the plugin. Returns a list of problems (empty = ready).
 */
export function preflightProfiles({ baselineProfile, treatmentProfile, dshHome = defaultDshHome() }) {
  const problems = [];
  for (const [label, name] of [['baseline', baselineProfile], ['treatment', treatmentProfile]]) {
    const dir = join(dshHome, 'profiles', name);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) {
      problems.push(`${label} profile "${name}" does not exist at ${dir} (create it: dsh --profile ${name} --from-default-profile headless --dump-config)`);
      continue;
    }
    let doc = null;
    try {
      doc = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      problems.push(`${label} profile "${name}" has an unreadable package.json`);
      continue;
    }
    const bundles = (doc?.dsh?.profile?.bundles ?? []).map(String);
    if (!bundles.some((b) => /dsh-headless/.test(b))) {
      problems.push(`${label} profile "${name}" is not headless-template (bundles: ${bundles.join(', ') || 'none'}) — a one-shot \`--json\` run needs the headless app`);
    }
    const sdlc = bundles.filter((b) => b.startsWith('@sdlc/'));
    if (label === 'treatment' && sdlc.length === 0) {
      problems.push(`treatment profile "${name}" composes no @sdlc/* bundle — the treatment arm would be the baseline`);
    }
    if (label === 'baseline' && sdlc.length > 0) {
      problems.push(`baseline profile "${name}" already composes ${sdlc.join(', ')} — the control would not be a control`);
    }
  }
  return problems;
}

function materializeFixture(task, dir) {
  mkdirSync(dir, { recursive: true });
  if (task.fixture.kind === 'greenfield') {
    for (const [rel, content] of Object.entries(task.fixture.seedFiles ?? {})) {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return { ok: true, method: 'greenfield-seed-files' };
  }
  const clone = spawnSync('git', ['clone', '--quiet', task.fixture.repoUrl, dir], { encoding: 'utf8', timeout: 300_000 });
  if (clone.status !== 0) return { ok: false, error: `git clone failed: ${(clone.stderr || '').slice(0, 300)}` };
  const checkout = spawnSync('git', ['-C', dir, 'checkout', '--quiet', task.fixture.commit], { encoding: 'utf8', timeout: 60_000 });
  if (checkout.status !== 0) return { ok: false, error: `git checkout ${task.fixture.commit} failed` };
  return { ok: true, method: 'git-clone-pinned-commit' };
}

/** Concatenated contents of a file or every file under a directory. */
function readAllUnder(dir, rel) {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return null;
  const st = statSync(abs);
  if (st.isFile()) return readFileSync(abs, 'utf8');
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(readFileSync(join(d, e.name), 'utf8'));
    }
  };
  walk(abs);
  return out.join('\n');
}

/** Evaluate the task's acceptance checks in the workspace. */
export function evaluateAcceptance(task, dir, { spawn = spawnSync } = {}) {
  const checks = [];
  for (const c of task.acceptance.checks) {
    if (c.kind === 'command') {
      const res = spawn(c.command[0], c.command.slice(1), { cwd: dir, encoding: 'utf8', timeout: 300_000 });
      checks.push({ id: c.id, kind: c.kind, ok: res.status === 0, detail: `exit ${res.status}` });
    } else if (c.kind === 'file-exists') {
      checks.push({ id: c.id, kind: c.kind, ok: existsSync(join(dir, c.path)), detail: c.path });
    } else if (c.kind === 'file-contains') {
      const blob = readAllUnder(dir, c.path);
      checks.push({ id: c.id, kind: c.kind, ok: Boolean(blob && blob.includes(c.contains)), detail: `${c.path} contains ${JSON.stringify(c.contains)}` });
    } else {
      // http and rubric need a running service / a blinded jury; never faked.
      checks.push({ id: c.id, kind: c.kind, ok: false, skipped: true, detail: `${c.kind} requires the live toolchain/jury` });
    }
  }
  const total = checks.filter((c) => !c.skipped).length;
  const passed = checks.filter((c) => c.ok).length;
  return { passed, total, skipped: checks.filter((c) => c.skipped).length, checks };
}

/** Deterministic PLACEBO executor: no arm-specific edits at all. */
function runSimulate({ task, arm, workspace }) {
  writeFileSync(join(workspace, 'SIMULATED.md'), `SIMULATED ${task.id} ${arm} — no model ran. NOT EVIDENCE.\n`);
  return {
    exitCode: 0,
    status: 'ok',
    notes: ['SIMULATED — no model ran; this record proves the pipeline, not the hypothesis'],
  };
}

/**
 * Whether a failure looks like provider/transport flake rather than the agent
 * failing the task: PI_AI_ERROR thinking-mode complaints, 429/5xx, timeouts,
 * connection resets. These are worth ONE retry; a second failure is evidence
 * the run did not happen, not a number to average in.
 */
export function isTransientFailure({ error = null, status = null, stderr = '' } = {}) {
  const text = `${error?.message ?? ''}\n${error?.code ?? ''}\n${stderr ?? ''}`;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE/i.test(text)) return true;
  if (/\b429\b|rate.?limit|overloaded|temporarily unavailable/i.test(text)) return true;
  if (/\b5\d\d\b|internal error|PI_AI_ERROR|bad gateway|service unavailable|gateway timeout/i.test(text)) return true;
  if (/timed out|timeout of \d+ms exceeded/i.test(text)) return true;
  if (error && /timeout/i.test(error?.code ?? '')) return true;
  return false;
}

/**
 * Sleep helper — injectable in tests via `sleep`.
 * @param {number} ms
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real arm: one `dsh` one-shot headless invocation.
 *
 * `spawn` and `now` are injectable so the argv contract and the invalid-run
 * detection can be unit-tested without launching a model.
 *
 * Transient provider failures (`isTransientFailure`) are retried up to
 * `maxRetries` times with exponential backoff (`retryBaseMs`, doubled per
 * attempt). Every retry is disclosed in `notes` and the final `attempts`
 * count, so a retried run cannot be mistaken for a clean first-try run.
 */
export function runDsh({
  task, arm, profile, workspace,
  patchPath = null, dshHome = null, model = null, provider = null,
  maxRetries = 2, retryBaseMs = 15_000,
  spawn = spawnSync, now = Date.now, sleep = null,
}) {
  const argv = ['dsh', '--profile', profile];
  if (patchPath) argv.push('--patch', patchPath);
  argv.push('--json', task.requirement);

  const env = { ...process.env, SDLC_EVAL_ARM: arm, SDLC_EVAL_TASK: task.id, ...(dshHome ? { DSH_HOME: dshHome } : {}) };
  const notes = [];
  let attempts = 0;
  let last = null;

  const maxAttempts = 1 + Math.max(0, maxRetries);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const startedAtMs = now();
    const res = spawn(argv[0], argv.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      timeout: task.budget?.maxWallClockMs ?? 900_000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    const durationMs = now() - startedAtMs;
    last = { res, durationMs, startedAtMs };
    if (attempt < maxAttempts && isTransientFailure({ error: res.error, status: res.status, stderr: res.stderr })) {
      const detail = (String(res.stderr ?? '').split('\n').find((l) => l.trim()) ?? res.error?.message ?? `exit ${res.status}`).slice(0, 160);
      notes.push(`attempt ${attempt}/${maxAttempts} hit a transient failure (${detail}); retrying`);
      const delay = retryBaseMs * 2 ** (attempt - 1);
      if (sleep) sleep(delay);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, 60_000));
      continue;
    }
    break;
  }

  const { res, durationMs, startedAtMs } = last;
  const stderr = String(res.stderr ?? '').slice(0, 4000);
  const { events, malformed } = parseJsonl(res.stdout ?? '');
  const usage = sumUsage(events);

  // The persisted session log is the cross-check and the only source of the
  // model that actually ran. It is consulted after a run that exited cleanly.
  let session = null;
  let sessionUsage = null;
  const ranCleanly = !res.error && res.status === 0;
  if (ranCleanly) {
    try {
      session = findSessionForRun({ home: dshHome || defaultDshHome(), cwd: workspace, sinceMs: startedAtMs });
      if (session && usage.tokensIn == null) sessionUsage = usageFromSessionLog(session.path);
    } catch (err) {
      notes.push(`session-log lookup failed: ${err.message}`);
    }
  }

  const tokensIn = usage.tokensIn ?? sessionUsage?.tokensIn ?? null;
  const tokensOut = usage.tokensOut ?? sessionUsage?.tokensOut ?? null;
  const effectiveModel = session?.info?.model ?? model ?? null;
  const effectiveProvider = session?.info?.provider ?? provider ?? null;

  if (malformed) notes.push(`${malformed} malformed NDJSON line(s) ignored`);
  if (usage.unknown) notes.push(`${usage.unknown} usage object(s) had an unreadable shape and were not counted`);
  if (usage.totalOnly) notes.push(`${usage.totalOnly} usage object(s) were total-only and are excluded from in/out`);
  if (usage.tokensIn == null && tokensIn != null) notes.push('token usage recovered from the persisted session log (the NDJSON stream carried none)');
  if (tokensIn == null) notes.push('token usage absent from both the NDJSON stream and the session log');
  if (sessionUsage?.truncated) notes.push('session log decoded only partially; token totals would under-count and are reported as unreadable');
  if (ranCleanly && session && !session.info?.model) notes.push('session log had no request/header; the effective model was not confirmed');

  let invalidReason = null;
  if (res.error) invalidReason = `spawn failed: ${res.error.message}`;
  else if (res.status !== 0) invalidReason = `dsh exited ${res.status}`;
  else if (events.length === 0) invalidReason = 'dsh exited 0 but emitted no NDJSON events';

  return {
    argv,
    exitCode: res.status ?? null,
    durationMs,
    tokensIn,
    tokensOut,
    model: effectiveModel,
    modelProvider: effectiveProvider,
    attempts,
    status: invalidReason ? 'invalid' : 'ok',
    executorError: invalidReason,
    stderr,
    sessionLog: session?.path ?? null,
    notes,
  };
}

function runOne({
  task, arm, repeat, executor, outDir, model, provider, seed, studySeed,
  baselineProfile, treatmentProfile, patchPath, dshHome, environment,
  maxRetries, retryBaseMs, collectArtifacts = false,
  spawn, now,
}) {
  const runId = makeRunId(task.id, arm, repeat, { seed });
  const workspace = join(outDir, 'work', task.id, arm, `r${repeat}`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });

  const startedAt = new Date().toISOString();
  const t0 = now();
  const profile = arm === 'treatment' ? treatmentProfile : baselineProfile;

  // The fixture is materialised for EVERY executor. It used to happen only in
  // the simulate arm, which meant every live run executed against an empty
  // directory — an agent with nothing to fix, and metrics over nothing.
  const fixture = materializeFixture(task, workspace);
  let ex;
  if (!fixture.ok) {
    ex = {
      exitCode: null,
      status: 'invalid',
      executorError: `fixture could not be materialised: ${fixture.error}`,
      notes: ['no arm ran: the fixture is the input both arms are entitled to'],
    };
  } else if (executor === 'simulate') {
    ex = runSimulate({ task, arm, workspace });
  } else {
    ex = runDsh({ task, arm, profile, workspace, patchPath, dshHome, model, provider, maxRetries, retryBaseMs, spawn, now });
  }
  const durationMs = ex.durationMs ?? (now() - t0);
  const valid = (ex.status ?? 'ok') === 'ok' && !ex.executorError;

  // A run that never happened has no acceptance result and no metrics: an empty
  // block cannot be averaged into an endpoint, and a fixture's untouched numbers
  // must never be dressed up as an arm's outcome.
  const acceptance = valid
    ? evaluateAcceptance(task, workspace)
    : { passed: 0, total: 0, skipped: task.acceptance.checks.length, checks: [], invalid: true };
  // Artifact-backed metrics (coverage, dependency-audit) are collected from
  // the finished workspace when requested: the collectors only read an
  // `artifacts.json` the pinned toolchain wrote, and stay unavailable without
  // one. Spawned inline (not a subprocess) so unit tests can disable it.
  let artifacts = { fixtureMethod: fixture.ok ? fixture.method : null, ...(ex.artifacts ?? {}) };
  const artifactNotes = [];
  if (valid && collectArtifacts) {
    try {
      const produced = collectWorkspaceArtifacts(workspace, { task });
      Object.assign(artifacts, produced.artifacts);
      artifactNotes.push(...produced.notes);
    } catch (err) {
      artifactNotes.push(`artifact collection failed (metrics stay unavailable): ${err?.message ?? err}`);
    }
  }
  const metrics = valid ? collectMetrics(workspace, { metrics: task.metrics, artifacts }).metrics : {};

  const record = {
    recordVersion: '1.0.0',
    runId,
    taskId: task.id,
    arm,
    armLabel: ARM_LABELS[arm],
    executor,
    repeat,
    model: ex.model ?? model ?? null,
    modelProvider: ex.modelProvider ?? provider ?? null,
    studySeed: studySeed ?? (seed == null ? null : String(seed)),
    attempts: ex.attempts ?? 1,
    status: valid ? 'ok' : 'invalid',
    startedAt,
    durationMs,
    tokensIn: ex.tokensIn ?? null,
    tokensOut: ex.tokensOut ?? null,
    costUsd: null,
    exitCode: ex.exitCode ?? null,
    stderr: ex.stderr ?? null,
    acceptance,
    metrics,
    artifacts,
    environment: environment ?? null,
    sessionLog: ex.sessionLog ?? null,
    notes: [...(ex.notes ?? []), ...artifactNotes, 'costUsd is null unless a deployment price table is supplied'],
    executorError: ex.executorError ?? null,
  };
  return record;
}

/**
 * Run the pinned offline toolchain over a finished arm workspace and return
 * the artifacts `collectMetrics` reads: line coverage (when the workspace has
 * tests/) and a dependency audit (when it has a package.json). Best-effort —
 * a missing tool or an unrunnable workspace yields notes, never numbers.
 */
export function collectWorkspaceArtifacts(workspace, { task = null, spawn = spawnSync } = {}) {
  const artifacts = {};
  const notes = [];
  const wants = new Set(task?.metrics ?? []);
  const needCoverage = wants.has('coverage');
  const needAudit = wants.has('dependency-audit');
  if (!needCoverage && !needAudit) return { artifacts, notes };
  if (needCoverage) {
    const testsDir = join(workspace, 'tests');
    if (!existsSync(testsDir)) {
      notes.push('coverage unavailable: the arm produced no tests/ directory');
    } else {
      // NOTE: never `node --test` here. Under `node --test` the runner warns
      // "run() is being called recursively within a test file. skipping
      // running files" and the child prints NOTHING (exit 0, empty output) —
      // so coverage must be measured by running each test file directly with
      // `node --experimental-test-coverage <file>`, one spawn per file.
      // Each spawn runs a single file outside the test-runner hierarchy, so
      // the recursion guard never fires.
      const testFiles = [];
      try {
        const walkTests = (rel) => {
          const abs = join(workspace, rel);
          for (const e of readdirSync(abs, { withFileTypes: true })) {
            const sub = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walkTests(sub);
            else if (e.isFile() && /\.m?js$/.test(e.name)) testFiles.push(sub);
          }
        };
        walkTests('tests');
      } catch { /* tests/ vanished mid-run */ }
      if (testFiles.length === 0) {
        notes.push('coverage unavailable: the arm produced no runnable test files under tests/');
      } else {
        const rows = [];
        let ran = 0;
        // The child must NOT inherit the parent's NODE_TEST_CONTEXT: under a
        // `node --test` parent the runner refuses ("run() is being called
        // recursively … skipping running files") and the child prints nothing.
        // Deleting the two vars makes the child a fresh root runner.
        const childEnv = { ...process.env };
        delete childEnv.NODE_TEST_CONTEXT;
        delete childEnv.NODE_TEST_WORKER_ID;
        for (const f of testFiles) {
          // --test-reporter=spec: human-readable text with the | table (the
          // default TAP framing is binary under capture and buries it).
          const res = spawn('node', ['--experimental-test-coverage', '--test-reporter=spec', f], { cwd: workspace, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024, env: childEnv });
          if (res.status === 0) ran += 1;
          const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
          for (const rawLine of text.split('\n')) {
            const line = String(rawLine).replace(/^ℹ\s*/, '');
            if (!line.includes('|')) continue;
            const cells = line.split('|').map((c) => c.trim());
            if (cells.length < 2) continue;
            const name = cells[0];
            if (!name || name === 'file' || /^all files$/i.test(name) || !name.includes('.')) continue;
            const pct = Number(cells[1]);
            if (!Number.isFinite(pct)) continue;
            if (/(^|\/)tests?\//i.test(name) || /\.(test|spec)\.[a-z0-9]+$/i.test(name)) continue;
            rows.push(pct);
          }
        }
        if (rows.length) {
          artifacts.coverage = { value: Number((rows.reduce((a, b) => a + b, 0) / rows.length).toFixed(2)), note: `node --experimental-test-coverage over ${ran}/${testFiles.length} test file(s), ${rows.length} source row(s)` };
        } else {
          notes.push(`coverage unavailable: the coverage reporter produced no per-file rows (${ran}/${testFiles.length} test file(s) exited 0)`);
        }
      }
    }
  }
  if (needAudit) {
    if (!existsSync(join(workspace, 'package.json'))) {
      notes.push('dependency-audit unavailable: the arm produced no package.json');
    } else if (!existsSync(join(workspace, 'package-lock.json')) && !existsSync(join(workspace, 'npm-shrinkwrap.json'))) {
      // npm audit requires a lockfile; most agent workspaces have none, and
      // `npm install` would phone home. Zero installable deps still means zero
      // known vulns only when there is nothing to install — report it as a
      // real zero with the reason, not as unavailable.
      try {
        const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
        const depCount = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.peerDependencies ?? {}).length + Object.keys(pkg.optionalDependencies ?? {}).length;
        if (depCount === 0) artifacts.audit = { value: 0, note: 'no lockfile but no runtime dependencies to audit' };
        else notes.push('dependency-audit unavailable: the arm produced no lockfile (npm audit needs one)');
      } catch {
        notes.push('dependency-audit unavailable: the arm produced no lockfile (npm audit needs one)');
      }
    } else {
      const res = spawn('npm', ['audit', '--json'], { cwd: workspace, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
      try {
        const doc = JSON.parse(res.stdout ?? '');
        const total = doc?.metadata?.vulnerabilities?.total;
        if (typeof total === 'number') artifacts.audit = { value: total, note: 'npm audit --json metadata.vulnerabilities.total' };
        else notes.push('dependency-audit unavailable: npm audit --json had no metadata.vulnerabilities');
      } catch {
        notes.push(`dependency-audit unavailable: npm audit output was not JSON (exit ${res.status})`);
      }
    }
  }
  return { artifacts, notes };
}

export function runEvaluation({
  tasksDir = join(ROOT, 'eval', 'tasks'),
  outDir = join(ROOT, '.eval-out'),
  executor = 'simulate',
  repeats = 1,
  taskFilter = null,
  model = null,
  provider = null,
  seed = null,
  baselineProfile = process.env.SDLC_BASELINE_PROFILE ?? 'eval-control',
  treatmentProfile = process.env.SDLC_TREATMENT_PROFILE ?? 'eval-treatment',
  dshHome = process.env.DSH_HOME ?? defaultDshHome(),
  continueOnError = false,
  maxRetries = 2,
  retryBaseMs = 15_000,
  append = false,
  resume = false,
  collectArtifacts = false,
  jobs = 1,
  shardIndex = null,
  shardCount = null,
  spawn = spawnSync,
  now = Date.now,
  environment = null,
  log = (line) => process.stdout.write(line),
} = {}) {
  const { tasks, problems } = loadTasks(tasksDir);
  if (problems.length) throw new Error(`task manifests are invalid:\n${problems.join('\n')}`);
  let selected = taskFilter ? tasks.filter((t) => t.id === taskFilter) : tasks;
  if (taskFilter && selected.length === 0) throw new Error(`no task with id ${taskFilter}`);

  // Sharding: split the task list across parallel workers. Every shard shares
  // the study seed (pass the same --seed), so the arm order per (task, repeat)
  // is identical to a single-process run and the records merge cleanly.
  // Shard k owns tasks where (index mod shardCount) === shardIndex.
  if ((shardIndex ?? null) !== null || (shardCount ?? null) !== null) {
    if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardIndex < 0 || shardIndex >= shardCount || shardCount < 2) {
      throw new Error(`--shard-index and --shard-count must satisfy 0 <= index < count with count >= 2 (got ${shardIndex}/${shardCount})`);
    }
    // Load-bearing: `selected` is already sorted by id (loadTasks), so every
    // shard agrees on the assignment without further coordination.
    selected = selected.filter((_, i) => i % shardCount === shardIndex);
    if (selected.length === 0) throw new Error(`shard ${shardIndex}/${shardCount} owns no tasks`);
  }

  if (executor === 'dsh') {
    const profiles = preflightProfiles({ baselineProfile, treatmentProfile, dshHome });
    if (profiles.length) throw new Error(`live run is not configured:\n  - ${profiles.join('\n  - ')}`);
  }
  if (executor === 'dsh' && !provider && !model) {
    log('eval: WARNING — no --provider/--model pin; the arms will run whatever the profile defaults to.\n');
  }

  mkdirSync(outDir, { recursive: true });
  const recordsPath = join(outDir, 'records.jsonl');

  // Fresh-by-default output: silently appending a new study onto an old
  // records.jsonl doubled the placebo n (42 → 84 duplicate runIds) while
  // study.json described only the second half. Refuse unless --append or
  // --resume is explicit; --resume only skips already-recorded runIds.
  const existing = existsSync(recordsPath) ? readRecords(recordsPath) : { records: [], malformed: [] };
  // Resume skips only runs that SUCCEEDED before: an `invalid` record is proof
  // the run never happened, so re-running it is the point of --resume.
  const completedIds = new Set(existing.records.filter((r) => r.status === 'ok').map((r) => r.runId));
  const existingIds = new Set(existing.records.map((r) => r.runId));
  if (existing.records.length > 0 && !append && !resume) {
    throw new Error(
      `refusing to append ${selected.length * repeats * ARMS.length} new run(s) onto ${existing.records.length} existing record(s) at ${recordsPath} — ` +
      `pass --append to mix studies (not recommended) or --resume to skip completed runIds, or use a fresh --out dir`,
    );
  }
  const resumed = { skipped: 0 };

  const patch = executor === 'dsh' ? writeModelPatch(outDir, { provider, model }) : null;
  const env = environment ?? collectEnvironment({ spawn });
  const studySeed = seed == null ? String(now()) : String(seed);
  // --resume continues an aborted study under its ORIGINAL seed so the arm
  // order stays identical; otherwise the seed fixes the randomised order.
  let effectiveSeed = studySeed;
  if (resume && existing.records.length > 0) {
    const prior = [...new Set(existing.records.map((r) => r.studySeed).filter(Boolean))];
    if (prior.length === 1) {
      effectiveSeed = prior[0];
      log(`eval: resuming study ${effectiveSeed} — ${existing.records.length} record(s) already present, completed runIds will be skipped\n`);
    } else if (prior.length > 1) {
      throw new Error(`cannot --resume: ${recordsPath} mixes ${prior.length} study seeds (${prior.join(', ')})`);
    }
  }
  const runCount = selected.length * repeats * ARMS.length;

  const jobsNote = jobs > 1
    ? `\n  eval/run.mjs runs one process: launch ${jobs} shards in parallel, e.g.\n${Array.from({ length: jobs }, (_, k) => `    node eval/run.mjs --executor ${executor} --live --repeats ${repeats} --seed ${effectiveSeed} --shard-index ${k} --shard-count ${jobs} --out .eval-out-shard${k} …`).join('\n')}\n  then merge with: node eval/merge.mjs --out <merged> .eval-out-shard0 .eval-out-shard1 …`
    : '';
  if (executor === 'dsh') {
    // Protocol §10: print what is about to be spent, before spending it.
    log(`eval: LIVE plan — ${selected.length} task(s) × ${repeats} repeat(s) × ${ARMS.length} arms = ${runCount} run(s)${shardCount ? ` [shard ${shardIndex}/${shardCount}]` : ''}\n`);
    log(`eval:   baseline profile   ${baselineProfile}\n`);
    log(`eval:   treatment profile  ${treatmentProfile}\n`);
    log(`eval:   model pin          ${provider || model ? `${provider ?? '(profile provider)'} / ${model ?? '(profile model)'} → ${patch?.path}` : '(none — profile default, recorded from the session log)'}\n`);
    log(`eval:   DSH_HOME           ${dshHome}\n`);
    log(`eval:   study seed         ${effectiveSeed}\n`);
    log(`eval:   retries            up to ${maxRetries} per run on transient provider failures\n`);
    log(`eval:   output             ${outDir}${resume ? ' (resume)' : append ? ' (append)' : ''}${jobsNote}\n`);
  }

  writeFileSync(
    join(outDir, 'study.json'),
    `${JSON.stringify({
      executor, repeats, tasks: selected.map((t) => t.id),
      model, provider, baselineProfile, treatmentProfile, dshHome: executor === 'dsh' ? dshHome : null,
      studySeed: effectiveSeed, armOrder: 'seeded-random-per-task-repeat', patch: patch?.path ?? null,
      maxRetries, retryBaseMs, shardIndex, shardCount, collectArtifacts,
      startedAt: new Date().toISOString(), environment: env,
    }, null, 2)}\n`,
  );

  const written = [];
  let invalid = 0;
  for (const task of selected) {
    for (let r = 0; r < repeats; r += 1) {
      for (const arm of armOrder(task.id, r, effectiveSeed)) {
        // The runId is keyed by the EFFECTIVE seed (the --seed flag, or the
        // resumed study's original seed), never the raw flag: otherwise a
        // --resume without --seed mints different runIds and skips nothing.
        const runId = makeRunId(task.id, arm, r, { seed: effectiveSeed });
        // --resume skips runs that already SUCCEEDED; --append re-runs
        // everything (explicit mixing — duplicates refused at report time).
        if (resume && completedIds.has(runId)) {
          resumed.skipped += 1;
          continue;
        }
        const rec = runOne({
          task, arm, repeat: r, executor, outDir, model, provider, seed: effectiveSeed, studySeed: effectiveSeed,
          baselineProfile, treatmentProfile, patchPath: patch?.path ?? null,
          dshHome, environment: env, maxRetries, retryBaseMs, collectArtifacts,
          spawn, now,
        });
        appendRecord(recordsPath, rec);
        existingIds.add(rec.runId);
        if (rec.status === 'ok') completedIds.add(rec.runId);
        written.push(rec);
        if (rec.status !== 'invalid') continue;
        invalid += 1;
        const detail = (rec.stderr ?? '').split('\n').find((l) => l.trim()) ?? '';
        if (executor === 'dsh' && !continueOnError) {
          throw new Error(
            `live run ABORTED after an invalid run — ${rec.runId}: ${rec.executorError}` +
            (detail ? `\n  first stderr line: ${detail}` : '') +
            `\n  ${written.length} record(s) kept at ${recordsPath}; the invalid record says so in-band.` +
            `\n  Fix the executor, then re-run with --resume to continue. Use --continue-on-error to press on regardless.`,
          );
        }
      }
    }
  }
  return { recordsPath, records: written, tasks: selected.length, invalid, studySeed: effectiveSeed, resumed: resumed.skipped, patchPath: patch?.path ?? null, environment: env };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const executor = flag('--executor', 'simulate');
  const repeats = Number(flag('--repeats', 1));
  const live = Boolean(flag('--live', false));
  if (executor === 'dsh' && !live) {
    process.stderr.write('eval: refusing to run the `dsh` executor without --live (it spends money).\n');
    process.exit(2);
  }
  const outDir = resolve(flag('--out', join(ROOT, '.eval-out')));
  const tasksDir = resolve(flag('--tasks', join(ROOT, 'eval', 'tasks')));
  try {
    const out = runEvaluation({
      tasksDir,
      outDir,
      executor,
      repeats,
      taskFilter: flag('--task', null),
      model: flagStr('--model'),
      provider: flagStr('--provider'),
      seed: flagStr('--seed'),
      baselineProfile: flagStr('--baseline-profile') ?? undefined,
      treatmentProfile: flagStr('--treatment-profile') ?? undefined,
      dshHome: flagStr('--dsh-home') ? resolve(flagStr('--dsh-home')) : undefined,
      continueOnError: Boolean(flag('--continue-on-error', false)),
      maxRetries: Number(flag('--max-retries', 2)),
      retryBaseMs: Number(flag('--retry-base-ms', 15000)),
      append: Boolean(flag('--append', false)),
      resume: Boolean(flag('--resume', false)),
      jobs: Number(flag('--jobs', 1)),
      shardIndex: flag('--shard-index', null) == null ? null : Number(flag('--shard-index', null)),
      shardCount: flag('--shard-count', null) == null ? null : Number(flag('--shard-count', null)),
      collectArtifacts: Boolean(flag('--collect-artifacts', false)),
    });
    const resumedNote = out.resumed ? ` (${out.resumed} resumed/skipped)` : '';
    process.stdout.write(`eval: ${out.records.length} record(s)${resumedNote} → ${out.recordsPath}\n`);
    if (out.invalid) process.stdout.write(`eval: ${out.invalid} INVALID record(s) — a failed run is not evidence.\n`);
    if (executor === 'simulate') process.stdout.write('eval: SIMULATED placebo run — these records are NOT evidence about DSH.\n');
  } catch (err) {
    process.stderr.write(`eval: ${err.message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export default { runEvaluation, evaluateAcceptance, runDsh, preflightProfiles, armOrder, isTransientFailure, materializeFixture, collectWorkspaceArtifacts };
