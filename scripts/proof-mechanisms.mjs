#!/usr/bin/env node
/**
 * scripts/proof-mechanisms.mjs — offline proof that the verification mechanisms
 * do what the product claims, against an unguarded baseline.
 *
 * This is deliberately NOT a model benchmark. It proves the deterministic part:
 * given the same worker output, the plugin rejects the five hazards that an
 * unguarded "trust the worker" loop accepts:
 *
 *   1. a diff outside the task's allowed/forbidden paths;
 *   2. a DONE claim whose required gate failed;
 *   3. a replayed/forged outbox (wrong nonce/run);
 *   4. two tasks writing the same shared resource;
 *   5. a crashed worker (dead or missing pid) left IN_PROGRESS.
 *
 * The baseline column is a two-line "accept the claim" implementation, not a
 * strawman wrapper around the plugin. Both run in this process, on the same
 * inputs; no network, no model, no DSH home.
 *
 *   node scripts/proof-mechanisms.mjs [--json <path>]
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { deriveWorkerResult, scopeVerdict, ingestOutbox, buildOutbox } from '../packages/sdlc-core/src/worker-result.js';
import { decideAcceptance } from '../packages/sdlc-core/src/verifier.js';
import { runVerification } from '../packages/sdlc-core/src/gates.js';
import { checkNoOverlap } from '../packages/sdlc-core/src/scheduler.js';
import { findOrphans, reconcile } from '../packages/sdlc-core/src/recovery.js';
import { TaskStateService } from '../packages/sdlc-core/src/state-machine.js';
import { requiredGates } from '../packages/sdlc-core/src/risk.js';

const argv = process.argv.slice(2);
const jsonFlag = argv.indexOf('--json');
const JSON_OUT = jsonFlag >= 0 ? argv[jsonFlag + 1] : null;

/** An unguarded loop: whatever the worker says happened, accept it. */
const trustClaim = (claim) => ({ accepted: true, detail: `trusted worker claim (${claim})` });

const results = [];
function proof(name, hazard, plugin, baseline) {
  let p;
  let b;
  try {
    p = plugin();
    b = baseline();
  } catch (error) {
    results.push({ name, hazard, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  results.push({
    name,
    hazard,
    plugin: p,
    baseline: b,
    prevented: p.caught === true,
    escapedWithout: b.escaped === true,
  });
}

// ── 1. Scope ───────────────────────────────────────────────────────────────
proof(
  'scope-violation',
  'worker writes a forbidden file and claims DONE',
  () => {
    const result = deriveWorkerResult({
      filesChanged: ['src/app.js', 'secrets/prod.key'],
      contract: { allowed_paths: ['src/**'], forbidden_paths: ['secrets/**'] },
      claims: { status: 'completed' },
      runtime: { exitCode: 0, turnEndReason: 'end_turn' },
    });
    const verdict = scopeVerdict(result);
    return {
      caught: verdict.ok === false && verdict.code === 'SCOPE_VIOLATION',
      detail: `${verdict.code}: ${[...new Set(verdict.files ?? [])].join(', ')}`,
    };
  },
  () => {
    const claim = trustClaim('completed');
    return { escaped: true, detail: claim.detail };
  },
);

// ── 2. False DONE / failing gate ────────────────────────────────────────────
proof(
  'false-done-claim',
  'worker claims DONE while the unit gate fails',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-proof-gates-'));
    try {
      const config = {
        verification: {
          gates: {
            syntax: { command: ['PASS'] },
            lint: { command: ['PASS'] },
            unit: { command: ['FAIL'] },
            integration: { command: ['PASS'] },
          },
        },
      };
      const runner = (argv2) => (argv2[0] === 'FAIL'
        ? { status: 1, stdout: '', stderr: 'assertion failed' }
        : { status: 0, stdout: 'ok', stderr: '' });
      const gateRun = runVerification({
        cwd: dir,
        gates: ['syntax', 'lint', 'unit', 'integration'],
        config,
        runner,
        taskId: 'PROOF',
      });
      const decision = decideAcceptance({
        riskClass: 'R2',
        gateResults: gateRun.gates,
        review: { verdict: 'accept' },
        filesChanged: ['src/app.js', 'tests/app.test.js'],
        claims: { status: 'completed' },
        runtimeStatus: 'completed',
      });
      return {
        caught: gateRun.overall === 'fail' && decision.accept === false && decision.code === 'GATE_FAILED',
        detail: `${gateRun.firstFailure?.gate ?? JSON.stringify(gateRun.firstFailure)} failed; verdict ${decision.status}/${decision.code}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  () => {
    const claim = trustClaim('completed; tests pass');
    return { escaped: true, detail: claim.detail };
  },
);

// ── 3. Outbox provenance ────────────────────────────────────────────────────
proof(
  'forged-outbox',
  'a replayed run writes another run\'s provenance',
  () => {
    const forged = buildOutbox({
      runId: 'run-forged',
      taskId: 'T2',
      attempt: 0,
      nonce: 'nonce-forged',
      claims: { status: 'completed' },
    });
    const ingested = ingestOutbox(forged, {
      runId: 'run-real',
      taskId: 'T1',
      attempt: 0,
      nonce: 'nonce-real',
    });
    return {
      caught: ingested.valid === true && ingested.suspect === true,
      detail: `suspect=${ingested.suspect} for run ${forged.runId} vs run-real`,
    };
  },
  () => {
    const claim = trustClaim('outbox status=completed');
    return { escaped: true, detail: claim.detail };
  },
);

// ── 4. Shared-resource collision ────────────────────────────────────────────
proof(
  'resource-collision',
  'two workers edit package.json at the same time',
  () => {
    const tasks = [
      { id: 'A', state: 'ASSIGNED', allowed_paths: ['src/a/**'], resources: ['package.json'] },
      { id: 'B', state: 'ASSIGNED', allowed_paths: ['src/b/**'], resources: ['package.json'] },
    ];
    const violations = checkNoOverlap(tasks, { maxSharedResourceTasks: 1 });
    return {
      caught: violations.some((v) => v.kind === 'resource-collision'),
      detail: violations.map((v) => v.kind).join(', '),
    };
  },
  () => {
    const assigned = ['A', 'B'];
    return { escaped: assigned.length === 2, detail: `dispatched ${assigned.join(' and ')} concurrently` };
  },
);

// ── 5. Crashed worker ───────────────────────────────────────────────────────
proof(
  'crashed-worker',
  'a worker died (no pid) and its task is still IN_PROGRESS',
  () => {
    const runs = [{ id: 'run-dead', task_id: 'T1', attempt: 0, pid: null, status: 'running', finished_at: null }];
    const orphans = findOrphans({ runs, isAlive: () => false });
    const rec = reconcile({
      tasks: [{ id: 'T1', state: 'IN_PROGRESS', worktree_path: null, branch: null }],
      runs,
      isAlive: () => false,
    });
    return {
      caught: orphans.length === 1 && orphans[0].reason === 'no-pid',
      detail: `${orphans.length} orphan (${orphans[0]?.reason}); reconcile transitions ${rec.transitions.length}`,
    };
  },
  () => {
    return { escaped: true, detail: 'task remains IN_PROGRESS; nobody reclaims it' };
  },
);

// ── 6. Required gate completeness ──────────────────────────────────────────
proof(
  'gate-completeness',
  'R4 task reports only syntax:pass and claims DONE',
  () => {
    const required = requiredGates('R4').filter((g) => g.required).map((g) => g.gate);
    const decision = decideAcceptance({
      riskClass: 'R4',
      gateResults: { syntax: { status: 'pass' } },
      review: { verdict: 'accept' },
      filesChanged: ['src/api/a.ts', 'tests/a.test.ts'],
      claims: { status: 'completed' },
      runtimeStatus: 'completed',
    });
    return {
      caught: decision.accept === false && decision.code === 'SKIPPED_GATE_NOT_PASSED',
      detail: `${decision.code}: ${decision.reasons.join('; ')}`,
    };
  },
  () => {
    const claim = trustClaim('syntax passed');
    return { escaped: true, detail: claim.detail };
  },
);

// ── 7. Merge single writer ─────────────────────────────────────────────────
proof(
  'merge-single-writer',
  'two ACCEPTED tasks try to enter MERGING at once',
  () => {
    const svc = new TaskStateService(':memory:');
    try {
      svc._setState('A', 'ACCEPTED');
      svc._setState('B', 'ACCEPTED');
      const first = svc.transition('A', 'MERGING', 'integration-mgr', {});
      const second = svc.transition('B', 'MERGING', 'integration-mgr', {});
      return {
        caught: first.ok === true && second.ok === false,
        detail: `first ${first.ok ? 'merged' : 'rejected'}, second ${second.ok ? 'merged' : 'rejected'}`,
      };
    } finally {
      svc.close();
    }
  },
  () => {
    const merged = ['A', 'B'];
    return { escaped: merged.length === 2, detail: `merged ${merged.join(' and ')} concurrently` };
  },
);

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.error || !r.prevented || !r.escapedWithout);
const report = {
  generatedAt: new Date().toISOString(),
  kind: 'offline-mechanism-proof',
  model: null,
  summary: {
    scenarios: results.length,
    preventedByPlugin: results.filter((r) => r.prevented).length,
    escapedWithoutGuard: results.filter((r) => r.escapedWithout).length,
    failed: failed.length,
  },
  results,
};

process.stdout.write('\nPlugin mechanism proof — offline, no model, no network\n');
process.stdout.write('='.repeat(92) + '\n');
for (const r of results) {
  if (r.error) {
    process.stdout.write(`  [FAIL] ${r.name}: ${r.error}\n`);
    continue;
  }
  const mark = r.prevented && r.escapedWithout ? 'ok  ' : 'FAIL';
  process.stdout.write(`  [${mark}] ${r.name.padEnd(20)} plugin: ${String(r.plugin.detail).padEnd(46)} baseline: ${r.baseline.detail}\n`);
}
process.stdout.write('='.repeat(92) + '\n');
process.stdout.write(
  `  ${report.summary.preventedByPlugin}/${report.summary.scenarios} hazards prevented by the plugin mechanism; `
  + `${report.summary.escapedWithoutGuard}/${report.summary.scenarios} escaped the unguarded baseline.\n`,
);

if (JSON_OUT) {
  if (!existsSync(dirname(JSON_OUT))) mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`  report: ${JSON_OUT}\n`);
}

process.exit(failed.length === 0 ? 0 : 1);
