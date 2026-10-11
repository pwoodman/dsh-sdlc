#!/usr/bin/env node
/**
 * scripts/demo-run.mjs — end-to-end debug-plugin demo on the demo fullstack app.
 *
 * Runs the REAL orchestrator control plane (Runtime + state machine + gates +
 * verifier decision) against the REAL demo app, twice:
 *
 *   attempt A ("first")  — worker ships the API + store but forgets the
 *                          toggle endpoint test; the `unit` gate FAILS.
 *   attempt B ("retry")  — worker adds the missing test; all gates PASS.
 *
 * Then it renders the side-by-side review surface the operator asked for:
 * time, tokens, cost, gates, and the full state-machine trace path — via
 * `sdlc debug compare` (JSON + SIDEBYSIDE.md).
 *
 * Fully offline, deterministic, no model: the "worker" is scripted file I/O
 * with fixed token/cost attributions, so the numbers are real measurements of
 * THIS run (durations) plus declared attributions (tokens/cost) that are
 * labelled as such in the report.
 *
 *   node scripts/demo-run.mjs [--out <dir>]
 */

import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const DEMO = join(ROOT, 'demo');
const argv = process.argv.slice(2);
const OUT = argv.includes('--out') ? resolve(argv[argv.indexOf('--out') + 1]) : join(ROOT, '.sdlc', 'debug-demo');

const { Runtime } = await import('../packages/sdlc-core/src/runtime.js');
const { loadConfig } = await import('../packages/sdlc-core/src/config.js');
const { runVerification } = await import('../packages/sdlc-core/src/gates.js');
const { decideAcceptance } = await import('../packages/sdlc-core/src/verifier.js');
const { compareRuns, renderSideBySide } = await import('../packages/sdlc-core/src/debug.js');

const FIXED_TOKENS = {
  // Declared attributions for the scripted worker (labelled in the report).
  A: { in: 4200, out: 1100 },
  B: { in: 2600, out: 800 },
};
const COST_PER_1K = 0.0025; // demo price table (USD per 1k tokens, estimate)

function costOf(t) {
  return Number((((t.in + t.out) / 1000) * COST_PER_1K).toFixed(4));
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function gateConfig() {
  return {
    verification: {
      gateTimeoutMs: 120000,
      gates: {
        syntax: { command: ['node', '--check', '{file}'], scope: 'changed-files' },
        unit: { command: ['node', '--test', 'tests/**/*.test.mjs'], timeoutMs: 120000 },
        build: { command: ['node', 'scripts/build.mjs'], timeoutMs: 120000 },
      },
    },
  };
}

process.stdout.write('sdlc debug demo — fullstack app, two attempts, side-by-side review\n');
mkdirSync(OUT, { recursive: true });

// ── 1. project + task ──────────────────────────────────────────────────────
// The event log is append-only BY DESIGN (triggers reject DELETE), so each
// re-run mints a fresh task id and compares ITS two attempts — history is
// never rewritten.
const DEMO_TASK_ID = `DEMO-${Date.now().toString(36).toUpperCase()}`;
const { config } = loadConfig(ROOT);
const runtime = new Runtime({ projectRoot: ROOT, config, useLock: false });
runtime.open();
try {
  if (!runtime.getProject('DEMO')) runtime.createProject({ id: 'DEMO', name: 'demo fullstack (task tracker)' });
  runtime.addTask({
    id: DEMO_TASK_ID, project_id: 'DEMO', title: 'Task-tracker API + frontend', role: 'fullstack-engineer',
    task_class: 'normal', risk_class: 'R2',
    allowed_paths: ['demo/**'], verification: ['syntax', 'unit', 'build'],
    acceptance_criteria: [
      { id: 'AC1', statement: 'health/create/list/toggle API works', check: 'unit:tests/api.test.mjs' },
      { id: 'AC2', statement: 'demo build passes', check: 'build:demo/scripts/build.mjs' },
    ],
  });
} finally { runtime.close({ releaseLock: false }); }

// ── 2. attempt A: sabotage — hide the toggle test, keep everything else ────
const apiTest = join(DEMO, 'tests', 'api.test.mjs');
const apiBackup = readFileSync(apiTest, 'utf8');
const sabotaged = apiBackup.replace(
  "await post(`/api/tasks/${created.id}/done`, { done: true })",
  "await post(`/api/tasks/${created.id}/done`, { done: false })",
);

// Idempotent re-runs: covered by the fresh task id above — history is append-only.
function driveAttempt({ label, filesChanged, sabotage, tokens }) {
  const rt = new Runtime({ projectRoot: ROOT, config, useLock: false });
  rt.open();
  try {
    if (sabotage) writeFileSync(apiTest, sabotaged);
    else writeFileSync(apiTest, apiBackup);
    const task = rt.getTask(DEMO_TASK_ID);
    const attempt = task.attempt ?? 0;
    if (task.state === 'BACKLOG') rt.transition(DEMO_TASK_ID, 'READY', 'scheduler', { depStates: {} });
    if (rt.getTask(DEMO_TASK_ID).state === 'READY') rt.transition(DEMO_TASK_ID, 'ASSIGNED', 'scheduler', { available: true });
    if (rt.getTask(DEMO_TASK_ID).state === 'ASSIGNED') rt.transition(DEMO_TASK_ID, 'IN_PROGRESS', 'worker-mgr', {});
    if (rt.getTask(DEMO_TASK_ID).state === 'FAILED') rt.transition(DEMO_TASK_ID, 'READY', 'scheduler', { attempt, retryBudget: 3 });
    if (rt.getTask(DEMO_TASK_ID).state === 'READY' && attempt > 0) rt.transition(DEMO_TASK_ID, 'ASSIGNED', 'scheduler', { available: true });
    if (rt.getTask(DEMO_TASK_ID).state === 'ASSIGNED' && attempt > 0) rt.transition(DEMO_TASK_ID, 'IN_PROGRESS', 'worker-mgr', {});

    const started = Date.now();
    const runId = rt.startWorkerRun({ taskId: DEMO_TASK_ID, attempt });
    const gates = runVerification({ cwd: DEMO, config: gateConfig(), taskId: DEMO_TASK_ID, changedFiles: filesChanged });
    const durationMs = Date.now() - started;
    const costUsd = costOf(tokens);
    const status = gates.overall === 'pass' ? 'completed' : 'failed';
    rt.finishWorkerRun(runId, { status, exitCode: gates.overall === 'pass' ? 0 : 1, durationMs, tokens, costUsd });
    rt.transition(DEMO_TASK_ID, 'VERIFYING', 'worker-mgr', {});
    for (const [gate, r] of Object.entries(gates.gates)) {
      rt.recordTestResults(DEMO_TASK_ID, runId, { [gate]: { status: r.status, logPath: r.logPath ?? null } });
    }
    const failedGates = Object.entries(gates.gates).filter(([, r]) => String(r.status).startsWith('fail'));
    const verdict = decideAcceptance({
      riskClass: 'R2', gateResults: gates.gates,
      scope: { ok: true, code: 'IN_SCOPE' },
      review: failedGates.length ? null : { verdict: 'accept', reason: 'independent review (scripted): matches contract' },
      filesChanged, claims: { status, suspect: false },
      runtimeStatus: status,
    });
    if (verdict.accept) rt.transition(DEMO_TASK_ID, 'ACCEPTED', 'verifier', { gatesPass: true });
    else rt.transition(DEMO_TASK_ID, 'FAILED', 'verifier', { gatesPass: false });
    process.stdout.write(`  attempt ${label}: ${gates.overall} in ${durationMs}ms — ${verdict.accept ? 'ACCEPTED' : `FAILED (${verdict.code})`}\n`);
    for (const [gate, r] of Object.entries(gates.gates)) {
      process.stdout.write(`    ${gate.padEnd(10)} ${r.status}\n`);
    }
    return { runId, gates, verdict, durationMs };
  } finally { rt.close({ releaseLock: false }); }
}

const changedFiles = ['tests/api.test.mjs'];
const resA = driveAttempt({ label: 'attempt-a', filesChanged: changedFiles, sabotage: true, tokens: FIXED_TOKENS.A });
const resB = driveAttempt({ label: 'attempt-b', filesChanged: changedFiles, sabotage: false, tokens: FIXED_TOKENS.B });
writeFileSync(apiTest, apiBackup); // leave the tree clean

// ── 3. side-by-side review surface ─────────────────────────────────────────
const rt = new Runtime({ projectRoot: ROOT, config, useLock: false });
rt.open();
let report;
try {
  report = compareRuns(rt, DEMO_TASK_ID, resA.runId, resB.runId, { labelA: 'first (buggy test)', labelB: 'retry (fixed)' });
} finally { rt.close({ releaseLock: false }); }

const mdPath = join(OUT, 'SIDEBYSIDE.md');
const jsonPath = join(OUT, 'compare.json');
writeFileSync(mdPath, renderSideBySide(report));
writeFileSync(jsonPath, JSON.stringify({ ...report, tokenAttribution: 'declared-scripted', costNote: 'estimate' }, null, 2) + '\n');

// Also prove the CLI path renders the same report.
const cli = run('node', ['packages/sdlc-cli/bin/sdlc.mjs', 'debug', 'compare', DEMO_TASK_ID, resA.runId, resB.runId,
  '--label-a', 'first (buggy test)', '--label-b', 'retry (fixed)', '--out', join(OUT, 'SIDEBYSIDE-cli.md')], { cwd: ROOT });
if (cli.status !== 0) {
  process.stdout.write(`  WARN sdlc debug CLI exited ${cli.status}: ${(cli.stderr || cli.stdout).slice(0, 300)}\n`);
}

process.stdout.write(`\nreview surface:\n  ${mdPath}\n  ${jsonPath}\n`);
process.stdout.write(`\ntrace: BACKLOG → ${report.traceSummary.states}\n`);
const tokA = report.runs.A.tokensTotal;
const tokB = report.runs.B.tokensTotal;
process.stdout.write(`tokens: A=${tokA} (declared) B=${tokB} (declared) Δ=${tokB - tokA}\n`);
process.stdout.write(`time:   A=${report.runs.A.durationMs}ms (measured) B=${report.runs.B.durationMs}ms (measured)\n`);
