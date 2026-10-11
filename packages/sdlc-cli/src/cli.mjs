/**
 * packages/sdlc-cli/src/cli.mjs — the deterministic control plane (spec v3 C.2, F, I.2–I.4).
 *
 * The `sdlc` CLI reads on-disk state and never calls a model. It is the
 * automation surface for headless deployments precisely because slash commands
 * do not exist in one-shot runs (E3).
 *
 * Deployment modes (C.2):
 *   interactive lead   `dsh --profile sdlc-web`        slash commands, approvals, long-lived
 *   headless one-shot  `dsh --profile sdlc-worker "…"`  no approvals (fail-closed)
 *   deterministic CLI  `sdlc status|tasks|…`            read/ops only
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Runtime } from '../../sdlc-core/src/runtime.js';
import { initProject, describeProject } from '../../sdlc-core/src/project.js';
import { loadConfig, validateConfig, deepMerge, DEFAULT_CONFIG, dumpConfigYaml } from '../../sdlc-core/src/config.js';
import { readLock, isStale } from '../../sdlc-core/src/instance-lock.js';
import { runVerification } from '../../sdlc-core/src/gates.js';
import { compareRuns, renderSideBySide, tracePathFor } from '../../sdlc-core/src/debug.js';
import { exportMetrics } from '../../sdlc-core/src/metrics.js';
import { parseYaml } from '../../sdlc-core/src/yaml-lite.js';

export const CLI_NAME = 'sdlc';

export function projectRootOf(argv = process.argv) {
  const idx = argv.indexOf('--root');
  return resolve(idx >= 0 ? argv[idx + 1] : (process.env.SDLC_PROJECT_ROOT ?? process.cwd()));
}

// ── argument helpers ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) { args.flags[a.slice(2)] = argv[i + 1]; i += 1; }
      else args.flags[a.slice(2)] = true;
    } else args._.push(a);
  }
  return args;
}

export function jsonOut(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// ── commands ───────────────────────────────────────────────────────────────

export function cmdInit(root, args) {
  const result = initProject({
    projectRoot: root,
    force: Boolean(args.flags.force),
    reconfigure: Boolean(args.flags.reconfigure),
  });
  if (args.flags.json) { jsonOut(result); return result.ok ? 0 : 1; }
  process.stdout.write(`${describeProject(result)}\n`);
  return result.ok ? 0 : 1;
}

function openRuntime(root, { useLock = true } = {}) {
  const { config } = loadConfig(root);
  const runtime = new Runtime({ projectRoot: root, config, useLock });
  runtime.open();
  return { runtime, config };
}

export function cmdStatus(root, args, { allowNoDb = true } = {}) {
  const dbPath = join(root, '.sdlc', 'sdlc.db');
  if (!existsSync(dbPath)) {
    const report = { ok: false, error: 'NO_PROJECT', detail: 'run `sdlc init` first', root };
    if (args.flags.json) jsonOut(report); else process.stdout.write(`${report.detail}\n`);
    return allowNoDb ? 0 : 1;
  }
  const { runtime } = openRuntime(root, { useLock: false });
  try {
    const projects = runtime.db.prepare('SELECT * FROM projects ORDER BY created_at').all();
    const taskRows = runtime.listTasks();
    const byState = {};
    for (const t of taskRows) byState[t.state] = (byState[t.state] ?? 0) + 1;
    const runs = runtime.listWorkerRuns();
    const events = runtime.getEvents({ limit: 10 }).reverse();
    const report = {
      ok: true,
      dbPath,
      projects: projects.map((p) => ({ id: p.id, name: p.name, state: p.state, blocked_state: p.blocked_state })),
      tasks: { total: taskRows.length, byState },
      workerRuns: { total: runs.length, orphaned: runs.filter((r) => r.orphaned).length },
      spend: runtime.spentTotals(),
      recentEvents: events.map((e) => ({ ts: e.ts, actor: e.actor, action: e.action, task_id: e.task_id })),
    };
    // observability.metricsExport (audit #5): `--metrics` renders the same
    // snapshot to .sdlc/metrics.prom when the flag is enabled in config.
    if (args.flags.metrics) {
      const exported = exportMetrics(runtime, { projectRoot: root });
      report.metrics = exported;
    }
    if (args.flags.json) jsonOut(report);
    else {
      process.stdout.write(renderStatus(report));
      if (report.metrics) {
        process.stdout.write(report.metrics.enabled
          ? `  metrics    : exported → ${report.metrics.path}\n`
          : '  metrics    : disabled (observability.metricsExport: false)\n');
      }
    }
    return 0;
  } finally { runtime.close({ releaseLock: false }); }
}

function renderStatus(r) {
  const lines = [`SDLC status — ${r.dbPath}`, ''];
  if (r.projects.length === 0) lines.push('  (no project initialised — run `sdlc init` then `/sdlc run`)');
  for (const p of r.projects) lines.push(`  project ${p.id}  state=${p.state}${p.blocked_state ? ` (blocked from ${p.blocked_state})` : ''}`);
  lines.push('', `  tasks      : ${r.tasks.total}`);
  for (const [state, n] of Object.entries(r.tasks.byState).sort()) lines.push(`    ${state.padEnd(12)} ${n}`);
  lines.push(`  worker runs: ${r.workerRuns.total}${r.workerRuns.orphaned ? ` (${r.workerRuns.orphaned} orphaned)` : ''}`);
  lines.push(`  spend      : $${Number(r.spend.costUsd).toFixed(4)} (estimate) · ${r.spend.tokens} tokens · ${Math.round(r.spend.durationMs / 1000)}s`);
  if (r.recentEvents.length) {
    lines.push('', '  recent events:');
    for (const e of r.recentEvents) lines.push(`    ${e.ts ?? ''} ${String(e.actor).padEnd(14)} ${e.action ?? ''} ${e.task_id ?? ''}`);
  }
  return lines.join('\n') + '\n';
}

export function cmdTasks(root, args) {
  const { runtime } = openRuntime(root, { useLock: false });
  try {
    const tasks = runtime.listTasks(args.flags.state ? { state: args.flags.state } : {});
    if (args.flags.json) { jsonOut(tasks); return 0; }
    if (!tasks.length) { process.stdout.write('no tasks\n'); return 0; }
    process.stdout.write(`${'id'.padEnd(16)}${'state'.padEnd(13)}${'role'.padEnd(26)}risk  calls\n`);
    for (const t of tasks) {
      process.stdout.write(`${String(t.id).padEnd(16)}${String(t.state).padEnd(13)}${String(t.role ?? '-').padEnd(26)}${String(t.risk_class ?? '-').padEnd(6)}${t.attempt ?? 0}\n`);
    }
    return 0;
  } finally { runtime.close({ releaseLock: false }); }
}

export function cmdExplain(root, args) {
  const [taskId] = args._;
  if (!taskId) { process.stderr.write('usage: sdlc explain <task-id> [--model|--gates|--events]\n'); return 2; }
  const { runtime } = openRuntime(root, { useLock: false });
  try {
    const task = runtime.getTask(taskId);
    if (!task) { process.stderr.write(`no such task: ${taskId}\n`); return 1; }
    const detail = {
      task,
      events: runtime.getEvents({ taskId }),
      workerRuns: runtime.listWorkerRuns({ taskId }),
      modelRuns: runtime.db.prepare('SELECT * FROM model_runs WHERE task_id = ?').all(taskId),
      routing: task.model_tier ? runtime.route({ attempt: task.attempt ?? 0, task_class: 'normal', task_type: task.role }) : null,
    };
    if (args.flags.json) { jsonOut(detail); return 0; }
    process.stdout.write(`task ${task.id} — ${task.state}\n`);
    process.stdout.write(`  role=${task.role} risk=${task.risk_class} complexity=${task.complexity} attempt=${task.attempt}\n`);
    process.stdout.write(`  allowed_paths: ${task.allowed_paths.join(', ') || '(none)'}\n`);
    process.stdout.write(`  verification : ${task.verification.join(', ') || '(none)'}\n`);
    if (args.flags.model && detail.routing) process.stdout.write(`  routed       : ${detail.routing.tier}/${detail.routing.model ?? '-'} (${detail.routing.reason})\n`);
    if (args.flags.events) {
      process.stdout.write('  events:\n');
      for (const e of detail.events) process.stdout.write(`    ${e.ts} ${e.actor} ${e.action}\n`);
    }
    if (args.flags.gates) {
      process.stdout.write('  gate results:\n');
      for (const row of runtime.db.prepare('SELECT gate, status, log_path FROM test_results WHERE task_id = ?').all(taskId)) {
        process.stdout.write(`    ${String(row.gate).padEnd(12)} ${row.status}  ${row.log_path ?? ''}\n`);
      }
    }
    return 0;
  } finally { runtime.close({ releaseLock: false }); }
}

export function cmdConfig(root, args) {
  const [sub = 'show'] = args._;
  const path = join(root, '.sdlc', 'config.yml');
  if (sub === 'validate') {
    const { config } = loadConfig(root, { configPath: path });
    const result = validateConfig(config, { projectRoot: root });
    if (args.flags.json) { jsonOut(result); return result.ok ? 0 : 1; }
    if (result.ok) process.stdout.write('config: ok\n');
    else { process.stdout.write('config: FAILED\n'); for (const e of result.errors) process.stdout.write(`  error:   ${e}\n`); }
    for (const w of result.warnings) process.stdout.write(`  warning: ${w}\n`);
    return result.ok ? 0 : 1;
  }
  if (sub === 'show') {
    const { config } = loadConfig(root, { configPath: path });
    process.stdout.write(dumpConfigYaml(config));
    return 0;
  }
  if (sub === 'set') {
    const [key, value] = args._.slice(1);
    if (!key || value === undefined) { process.stderr.write('usage: sdlc config set <dotted.key[index]> <value>\n'); return 2; }
    const base = existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) ?? {}) : {};
    const merged = deepMerge(base, setPath({}, key, coerce(value)));
    writeFileSync(path, dumpConfigYaml(deepMerge(DEFAULT_CONFIG, merged)));
    process.stdout.write(`config set ${key} = ${value}\n`);
    return 0;
  }
  if (sub === 'get') {
    const [key] = args._.slice(1);
    const { config } = loadConfig(root, { configPath: path });
    jsonOut(getPath(config, key));
    return 0;
  }
  process.stderr.write(`unknown config subcommand: ${sub}\n`);
  return 2;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function tokenizeKey(key) {
  const parts = [];
  for (const seg of String(key).split('.')) {
    const m = seg.match(/^([^[\]]+)((\[[^\]]*\])*)$/);
    parts.push(m[1]);
    for (const idx of seg.matchAll(/\[([^\]]*)\]/g)) parts.push(idx[1] === '' ? '[]' : (Number.isNaN(Number(idx[1])) ? idx[1] : Number(idx[1])));
  }
  return parts;
}

/**
 * Set a dotted/indexed key. Container kind is decided by the NEXT segment
 * (a numeric index or `[]` means array); an existing container of the right
 * kind is REUSED, never replaced.
 *
 * The reuse rule matters in practice: spec v3's own Quick Start runs
 * `sdlc config set tiers.cheap[0].provider …` and then
 * `sdlc config set tiers.cheap[0].model …`. Replacing the container on the
 * second call silently erased the provider.
 */
export function setPath(obj, key, value) {
  const parts = tokenizeKey(key);
  let cursor = obj;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const next = parts[i + 1];
    if (isLast) {
      if (part === '[]') {
        if (!Array.isArray(cursor)) throw new Error(`${key}: "[]" can only append to an array`);
        cursor.push(value);
      } else if (typeof part === 'number') {
        // Backfill with explicit nulls: a SPARSE array serializes badly through
        // YAML (holes render as blank lines and disappear on re-read), so
        // `config set tiers.cheap[1].provider x` must produce [null, {…}].
        for (let k = cursor.length; k < part; k += 1) cursor[k] = null;
        cursor[part] = value;
      } else {
        cursor[part] = value;
      }
      break;
    }
    const wantArray = typeof next === 'number' || next === '[]';
    const current = cursor[part];
    const wrongKind = wantArray ? !Array.isArray(current) : (typeof current !== 'object' || current === null || Array.isArray(current));
    if (current === undefined || current === null || wrongKind) {
      if (typeof part === 'number') for (let k = cursor.length; k < part; k += 1) cursor[k] = null;
      cursor[part] = wantArray ? [] : {};
    }
    cursor = cursor[part];
  }
  return obj;
}

export function getPath(obj, key) {
  let cursor = obj;
  const parts = tokenizeKey(key);
  for (let i = 0; i < parts.length; i += 1) {
    if (cursor == null) return null;
    const part = parts[i];
    if (part === '[]') {
      // `[]` addresses the ARRAY at the preceding path.
      if (i === parts.length - 1) break;
      cursor = Array.isArray(cursor) ? cursor[0] : null;
      continue;
    }
    cursor = cursor[part];
  }
  return cursor ?? null;
}

export function cmdLock(root, args) {
  const [sub = 'status'] = args._;
  const lockPath = join(root, '.sdlc', 'sdlc.lock');
  if (sub === 'status') {
    const lock = existsSync(lockPath) ? readLock(lockPath) : null;
    const report = {
      path: lockPath,
      held: Boolean(lock),
      holder: lock,
      stale: lock ? isStale(lock) : null,
    };
    if (args.flags.json) jsonOut(report);
    else process.stdout.write(lock
      ? `lock held by pid ${lock.pid} on ${lock.host} since ${lock.startedAt}${report.stale ? ' (STALE)' : ''}\n`
      : 'no lock\n');
    return 0;
  }
  if (sub === 'release') {
    if (!existsSync(lockPath)) { process.stdout.write('no lock to release\n'); return 0; }
    const lock = readLock(lockPath);
    if (lock && !isStale(lock) && !args.flags.force) {
      process.stderr.write(`lock is live (pid ${lock.pid}); use --force to break it\n`);
      return 1;
    }
    unlinkSync(lockPath);
    process.stdout.write('lock released\n');
    return 0;
  }
  process.stderr.write(`unknown lock subcommand: ${sub}\n`);
  return 2;
}

export function cmdResume(root, args) {
  const { runtime } = openRuntime(root);
  try {
    const tasks = runtime.listTasks();
    const runs = runtime.listWorkerRuns();
    const transitions = [];
    for (const task of tasks) {
      if (!['ASSIGNED', 'IN_PROGRESS', 'VERIFYING'].includes(task.state)) continue;
      const run = runs.find((r) => r.task_id === task.id && !r.finished_at);
      const alive = run?.pid ? isPidAlive(run.pid) : false;
      if (!alive) transitions.push({ taskId: task.id, to: 'FAILED', actor: 'recovery', evidence: 'ORPHAN_SALVAGE' });
      else transitions.push({ taskId: task.id, to: task.state, actor: 'recovery', evidence: 'kept-alive' });
    }
    const orphaned = transitions.filter((t) => t.evidence === 'ORPHAN_SALVAGE');
    for (const t of orphaned) {
      runtime.state.transition(t.taskId, t.to, 'recovery', { hardFailure: true });
    }
    const report = { reconciled: transitions.length, transitions };
    if (args.flags.json) jsonOut(report); else process.stdout.write(`resume: reconciled ${transitions.length} task(s)\n`);
    return 0;
  } finally { runtime.close(); }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function cmdStop(root, args) {
  const { runtime } = openRuntime(root);
  try {
    const stopped = [];
    for (const task of runtime.listTasks()) {
      if (['BACKLOG', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'VERIFYING'].includes(task.state)) {
        const res = runtime.state.transition(task.id, 'CANCELLED', 'human', { workerStopped: true });
        if (res.ok) stopped.push(task.id);
      }
    }
    runtime.state.record({ actor: 'human', action: 'kill-switch', payload: { stopped } });
    const report = { stopped, reason: args.flags.force ? 'force' : 'requested' };
    if (args.flags.json) jsonOut(report); else process.stdout.write(`stop: cancelled ${stopped.length} task(s)\n`);
    return 0;
  } finally { runtime.close(); }
}

export function cmdDb(root, args) {
  const [sub = 'export-events'] = args._;
  if (sub === 'export-events') {
    const { runtime } = openRuntime(root, { useLock: false });
    try {
      const events = runtime.getEvents({ limit: 100000 });
      if (args.flags.json) jsonOut(events);
      else process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return 0;
    } finally { runtime.close({ releaseLock: false }); }
  }
  if (sub === 'integrity') {
    const { runtime } = openRuntime(root, { useLock: false });
    try {
      const status = runtime.assertIntegrity();
      if (args.flags.json) jsonOut({ ok: true, quickCheck: status });
      else process.stdout.write(`integrity: ${status}\n`);
      return 0;
    } finally { runtime.close({ releaseLock: false }); }
  }
  process.stderr.write(`unknown db subcommand: ${sub}\n`);
  return 2;
}

export function cmdVerify(root, args) {
  const { config } = loadConfig(root);
  const taskId = args.flags.task ?? args._[0] ?? 'MANUAL';
  const gates = args.flags.gates ? String(args.flags.gates).split(',') : undefined;
  const result = runVerification({ cwd: root, gates, config, taskId });
  if (args.flags.json) jsonOut(result);
  else {
    process.stdout.write(`verification: ${result.overall}\n`);
    for (const [gate, r] of Object.entries(result.gates)) process.stdout.write(`  ${gate.padEnd(12)} ${r.status}\n`);
  }
  return result.overall === 'pass' ? 0 : 1;
}

export function cmdDoctor(root, args) {
  const checks = [];
  const push = (id, ok, detail) => checks.push({ id, ok, detail });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1]);
  push('node>=22.5', nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5), process.version);
  const dsh = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  push('dsh', dsh.status === 0, (dsh.stdout || dsh.stderr || 'not found').trim());
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
  push('pnpm', pnpm.status === 0, (pnpm.stdout || 'not found').trim());
  const { config } = loadConfig(root);
  const v = validateConfig(config, { projectRoot: root });
  push('config', v.ok, `${v.errors.length} error(s), ${v.warnings.length} warning(s)`);
  const report = { errors: checks.filter((c) => !c.ok).length, warnings: v.warnings.length, checks };
  if (args.flags.json) jsonOut(report);
  else for (const c of checks) process.stdout.write(`  ${c.ok ? 'ok  ' : 'ERR '} ${c.id.padEnd(14)} ${c.detail}\n`);
  return report.errors ? 1 : 0;
}

/** `sdlc selftest --mock`: self-contained end-to-end smoke test in a temp dir. */
export function cmdSelftest(root, args) {
  if (args.flags.live) {
    process.stderr.write('selftest --live requires a funded provider key and is intentionally not run by CI\n');
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-selftest-'));
  try {
    const results = [];
    const step = (name, fn) => {
      try { const detail = fn(); results.push({ name, ok: true, detail: detail ?? '' }); }
      catch (err) { results.push({ name, ok: false, detail: err.message }); }
    };
    step('init', () => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'selftest', devDependencies: {} }));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      const res = initProject({ projectRoot: dir, createBranch: false });
      if (!res.ok) throw new Error(res.message);
      return res.stack;
    });
    step('schema', () => {
      const { runtime } = openRuntime(dir, { useLock: true });
      runtime.close();
      return 'sdlc.db initialised';
    });
    step('state-machine', () => {
      const { runtime } = openRuntime(dir, { useLock: false });
      try {
        runtime.createProject({ id: 'P1', name: 'selftest' });
        runtime.addTask({ id: 'T-001', project_id: 'P1', title: 'smoke', role: 'backend-engineer', allowed_paths: ['src/**'], verification: ['unit'] });
        runtime.transition('T-001', 'READY', 'scheduler', { depStates: {} });
        runtime.transition('T-001', 'ASSIGNED', 'scheduler', { available: true });
        runtime.transition('T-001', 'IN_PROGRESS', 'worker-mgr', {});
        runtime.transition('T-001', 'VERIFYING', 'worker-mgr', {});
        runtime.transition('T-001', 'ACCEPTED', 'verifier', { gatesPass: true });
        runtime.transition('T-001', 'MERGING', 'integration-mgr', { mergeSlotFree: true });
        runtime.transition('T-001', 'DONE', 'integration-mgr', { merged: true });
        return `task reached ${runtime.getTask('T-001').state}`;
      } finally { runtime.close({ releaseLock: false }); }
    });
    step('append-only', () => {
      const { runtime } = openRuntime(dir, { useLock: false });
      try { runtime.state.assertAppendOnly(); return 'events rejects DELETE'; }
      finally { runtime.close({ releaseLock: false }); }
    });
    const failed = results.filter((r) => !r.ok);
    if (args.flags.json) jsonOut({ ok: failed.length === 0, results });
    else {
      for (const r of results) process.stdout.write(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(16)} ${r.detail}\n`);
    }
    return failed.length ? 1 : 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function cmdLogs(root, args) {
  const taskId = args.flags.task;
  const dir = taskId ? join(root, '.sdlc', 'verification', taskId) : join(root, '.sdlc', 'verification');
  if (!existsSync(dir)) { process.stdout.write('no logs\n'); return 0; }
  const files = readdirSync(dir, { recursive: true }).map(String).sort();
  if (args.flags.json) { jsonOut({ dir, files }); return 0; }
  for (const f of files) process.stdout.write(`${join(dir, f)}\n`);
  return 0;
}

/**
 * `sdlc debug …` — the debug plugin option: side-by-side run anatomy for
 * review and improvement. Read-only over `.sdlc/`; never calls a model.
 *
 *   sdlc debug compare <task-id> <run-a> <run-b> [--label-a X] [--label-b Y] [--out SIDEBYSIDE.md] [--json]
 *   sdlc debug trace <task-id> [--json]
 */
export function cmdDebug(root, args) {
  const [sub = 'compare', ...rest] = args._;
  const dbPath = join(root, '.sdlc', 'sdlc.db');
  if (!existsSync(dbPath)) {
    const report = { ok: false, error: 'NO_PROJECT', detail: 'run `sdlc init` first', root };
    if (args.flags.json) jsonOut(report); else process.stdout.write(`${report.detail}\n`);
    return 1;
  }
  if (sub === 'trace') {
    const [taskId] = rest;
    if (!taskId) { process.stderr.write('usage: sdlc debug trace <task-id> [--json]\n'); return 2; }
    const { runtime } = openRuntime(root, { useLock: false });
    try {
      const path = tracePathFor(runtime, taskId);
      if (args.flags.json) { jsonOut({ taskId, steps: path.length, path }); return 0; }
      process.stdout.write(`trace ${taskId} — ${path.length} step(s)\n`);
      for (const step of path) {
        process.stdout.write(`  ${step.ts ?? '?'} ${String(step.actor).padEnd(14)} ${step.action ?? ''}${step.to ? ` → ${step.to}` : ''}\n`);
      }
      return 0;
    } finally { runtime.close({ releaseLock: false }); }
  }
  if (sub === 'compare') {
    const [taskId, runA, runB] = rest;
    if (!taskId || !runA || !runB) {
      process.stderr.write('usage: sdlc debug compare <task-id> <run-a> <run-b> [--label-a X] [--label-b Y] [--out FILE] [--json]\n');
      return 2;
    }
    const { runtime } = openRuntime(root, { useLock: false });
    try {
      const report = compareRuns(runtime, taskId, runA, runB, {
        labelA: args.flags['label-a'] ? String(args.flags['label-a']) : 'A',
        labelB: args.flags['label-b'] ? String(args.flags['label-b']) : 'B',
      });
      const outPath = args.flags.out ? resolve(String(args.flags.out)) : null;
      if (args.flags.json && !outPath) { jsonOut(report); return 0; }
      const markdown = renderSideBySide(report);
      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, markdown);
        if (args.flags.json) jsonOut({ ...report, outPath });
        else process.stdout.write(`debug compare: ${taskId} ${runA} vs ${runB} → ${outPath}\n`);
      } else {
        process.stdout.write(markdown);
      }
      const missing = [!report.runs.A.available, !report.runs.B.available].filter(Boolean).length;
      return missing ? 1 : 0;
    } finally { runtime.close({ releaseLock: false }); }
  }
  process.stderr.write(`unknown debug subcommand: ${sub} (compare|trace)\n`);
  return 2;
}

export const COMMANDS = {
  init: cmdInit,
  status: cmdStatus,
  tasks: cmdTasks,
  explain: cmdExplain,
  config: cmdConfig,
  lock: cmdLock,
  resume: cmdResume,
  stop: cmdStop,
  db: cmdDb,
  verify: cmdVerify,
  doctor: cmdDoctor,
  selftest: cmdSelftest,
  logs: cmdLogs,
  debug: cmdDebug,
};

export function usage() {
  return `sdlc — deterministic control plane over .sdlc/ (no model calls)

  sdlc init [--force|--reconfigure]        create .sdlc/, integration branch, gate commands
  sdlc status [--json] [--metrics]          project + task + spend summary
  sdlc tasks [--state S] [--json]          task list
  sdlc explain <id> [--model|--gates|--events] [--json]
  sdlc debug compare <task> <runA> <runB> [--label-a X] [--label-b Y] [--out FILE] [--json]
  sdlc debug trace <task> [--json]         side-by-side time/tokens/tracepaths for review
  sdlc config show|validate|get <key>|set <key> <value>
  sdlc lock status|release [--force]
  sdlc resume [--json]                     reconciliation (B.12)
  sdlc stop [--force]                      kill switch
  sdlc db export-events|integrity
  sdlc verify [--task ID] [--gates a,b]
  sdlc logs [--task ID]
  sdlc doctor [--json]
  sdlc selftest [--mock|--live]

Modes (C.2): slash commands and approvals exist ONLY in the interactive lead
(\`dsh --profile sdlc-web\`). A headless deployment is a guest of the state
machine: it can run work but cannot unblock itself (fail-closed).
`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [command] = args._;
  if (!command || command === 'help' || args.flags.help) {
    process.stdout.write(usage());
    return 0;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`sdlc: unknown command "${command}"\n\n${usage()}`);
    return 2;
  }
  const root = projectRootOf(argv);
  // Subcommands see the positionals AFTER the command itself.
  return handler(root, { ...args, _: args._.slice(1) });
}

export default main;
