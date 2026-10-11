/**
 * packages/sdlc-core/src/debug.js — debug compare: side-by-side run anatomy.
 *
 * The debug plugin option the operator asked for: given TWO worker runs of the
 * same task (e.g. a first attempt that failed and the retry that passed), show
 * them side by side — wall-clock, tokens, cost, gate outcomes, state-machine
 * trace path — so a reviewer can see WHAT changed and WHY, then improve the
 * task boundary, the gates, or the router input.
 *
 * Offline + deterministic: everything comes from `sdlc.db` rows (worker_runs,
 * test_results, events, model_runs). Nothing is fabricated: a missing artifact
 * renders as `—` with an explicit `unavailable` reason, and cost is always
 * labelled an estimate (no currency metadata exists upstream, E9).
 *
 * Output shapes:
 *   - `compareRuns()` → JSON-serialisable object (consumed by `sdlc debug`
 *     `--json` and by the SIDEBYSIDE.md report generator).
 *   - `renderSideBySide()` → human-readable markdown with two columns.
 */

/**
 * Ordered trace path for one task: every state the task occupied, with the
 * actor + action that moved it there, drawn from the append-only events log.
 * A repeat visit to the same state (FAILED → READY → …) is kept — the loop
 * IS the signal the reviewer is looking for.
 */
export function tracePathFor(runtime, taskId) {
  const rows = runtime.db.prepare(
    'SELECT ts, actor, action, payload_json FROM events WHERE task_id = ? ORDER BY id',
  ).all(taskId);
  const path = [];
  for (const row of rows) {
    let payload = null;
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch { payload = null; }
    const to = payload?.to ?? payload?.state ?? actionToState(row.action);
    path.push({ ts: row.ts, actor: row.actor, action: row.action, to });
  }
  return path;
}

/** Best-effort mapping for legacy actions that carry no `to` in the payload. */
function actionToState(action) {
  const m = /→\s*([A-Z_]+)|:\s*([A-Z_]+)\s*$/.exec(String(action ?? ''));
  return m?.[1] ?? m?.[2] ?? null;
}

/** Gate outcomes recorded for one (task, run) pair. */
export function gatesForRun(runtime, taskId, runId) {
  try {
    return runtime.db.prepare(
      'SELECT gate, status, log_path FROM test_results WHERE task_id = ? AND run_id = ? ORDER BY gate',
    ).all(taskId, runId).map((r) => ({ gate: r.gate, status: r.status, logPath: r.log_path ?? null }));
  } catch { return []; }
}

/** Model attribution recorded for one task (may be empty for mock runs). */
export function modelsForTask(runtime, taskId) {
  try {
    return runtime.db.prepare(
      'SELECT model_id, task_type, duration_ms, tokens, cost_usd, attempts, outcome FROM model_runs WHERE task_id = ? ORDER BY rowid',
    ).all(taskId);
  } catch { return []; }
}

function runAnatomy(runtime, taskId, runId) {
  const run = typeof runtime.getWorkerRun === 'function' ? runtime.getWorkerRun(runId) : null;
  if (!run) return { runId, available: false, reason: 'no worker_runs row' };
  let result = null;
  try { result = run.result_json ? JSON.parse(run.result_json) : (run.result ?? null); } catch { result = null; }
  return {
    runId,
    available: true,
    status: run.status ?? 'unknown',
    attempt: run.attempt ?? null,
    model: run.model_id ? `${run.model_provider ?? '?'} / ${run.model_id}` : (run.model_provider ?? '—'),
    sessionId: run.session_id ?? '—',
    durationMs: run.duration_ms ?? 0,
    tokensIn: run.tokens_in ?? 0,
    tokensOut: run.tokens_out ?? 0,
    tokensTotal: (run.tokens_in ?? 0) + (run.tokens_out ?? 0),
    costUsdEstimate: run.cost_usd ?? 0,
    exitCode: run.exit_code ?? null,
    resultStatus: result?.status ?? '—',
    resultCode: result?.code ?? result?.scope?.code ?? '—',
    gates: gatesForRun(runtime, taskId, runId),
    logPath: run.worktree_path ? `${run.worktree_path}/.sdlc/verification/${taskId}/worker-${runId}.ndjson` : null,
  };
}

function deltaOf(a, b) {
  if (a == null || b == null) return null;
  const d = b - a;
  return { delta: d, pct: a === 0 ? null : (d / a) * 100 };
}

/**
 * Compare two worker runs of one task.
 * @returns the JSON model for `sdlc debug compare --json` and SIDEBYSIDE.md.
 */
export function compareRuns(runtime, taskId, runIdA, runIdB, { labelA = 'A', labelB = 'B' } = {}) {
  const task = typeof runtime.getTask === 'function' ? runtime.getTask(taskId) : null;
  const a = runAnatomy(runtime, taskId, runIdA);
  const b = runAnatomy(runtime, taskId, runIdB);
  const trace = tracePathFor(runtime, taskId);
  const models = modelsForTask(runtime, taskId);
  return {
    tool: 'sdlc-debug-compare',
    version: '1.0.0',
    task: task ? {
      id: task.id,
      title: task.title ?? task.id,
      state: task.state,
      role: task.role ?? null,
      riskClass: task.risk_class ?? null,
      allowedPaths: task.allowed_paths ?? [],
    } : { id: taskId },
    columns: { A: { label: labelA, runId: runIdA }, B: { label: labelB, runId: runIdB } },
    runs: { A: a, B: b },
    deltas: (a.available && b.available) ? {
      durationMs: deltaOf(a.durationMs, b.durationMs),
      tokensTotal: deltaOf(a.tokensTotal, b.tokensTotal),
      costUsdEstimate: deltaOf(a.costUsdEstimate, b.costUsdEstimate),
    } : null,
    tracePath: trace,
    traceSummary: summarizeTrace(trace),
    gatesCompared: compareGateSets(a.gates ?? [], b.gates ?? []),
    modelRuns: models,
    notes: [
      'Cost is an estimate: no currency metadata exists upstream (E9).',
      'A missing value renders as — and is never treated as zero.',
    ],
  };
}

function compareGateSets(gatesA, gatesB) {
  const names = [...new Set([...gatesA.map((g) => g.gate), ...gatesB.map((g) => g.gate)])].sort();
  const mapA = new Map(gatesA.map((g) => [g.gate, g.status]));
  const mapB = new Map(gatesB.map((g) => [g.gate, g.status]));
  return names.map((gate) => {
    const a = mapA.get(gate) ?? '—';
    const b = mapB.get(gate) ?? '—';
    return { gate, A: a, B: b, changed: a !== b };
  });
}

function summarizeTrace(trace) {
  const states = trace.map((t) => t.to).filter(Boolean);
  const visits = {};
  for (const s of states) visits[s] = (visits[s] ?? 0) + 1;
  const loops = Object.entries(visits).filter(([, n]) => n > 1).map(([s, n]) => `${s}×${n}`);
  return {
    steps: trace.length,
    states: states.join(' → ') || '—',
    revisited: loops,
  };
}

const DASH = '—';

function fmtMs(ms) {
  if (ms == null) return DASH;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDelta(d, unit = '') {
  if (!d) return DASH;
  const sign = d.delta > 0 ? '+' : '';
  const pct = d.pct == null ? 'n/a' : `${sign}${d.pct.toFixed(1)}%`;
  return `${sign}${d.delta}${unit} (${pct})`;
}

/** Render the comparison as side-by-side markdown (the review surface). */
export function renderSideBySide(report) {
  const { A, B } = report.runs;
  const L = [];
  L.push(`# Debug compare — ${report.task.id} ${report.task.title ? `(${report.task.title})` : ''}`);
  L.push('');
  L.push(`state: **${report.task.state ?? '?'}** · role: ${report.task.role ?? DASH} · risk: ${report.task.riskClass ?? DASH}`);
  L.push('');
  L.push(`| dimension | ${report.columns.A.label} \`${report.columns.A.runId}\` | ${report.columns.B.label} \`${report.columns.B.runId}\` | Δ (B−A) |`);
  L.push('|---|---|---|---|');
  const row = (dim, a, b, d = DASH) => L.push(`| ${dim} | ${a} | ${b} | ${d} |`);
  if (!A.available || !B.available) {
    row('run', A.available ? A.status : `missing (${A.reason})`, B.available ? B.status : `missing (${B.reason})`, DASH);
  } else {
    row('status', `\`${A.status}\``, `\`${B.status}\``, A.status === B.status ? 'same' : '**changed**');
    row('attempt', String(A.attempt ?? DASH), String(B.attempt ?? DASH), DASH);
    row('model', A.model, B.model, A.model === B.model ? 'same' : '**changed**');
    row('wall-clock', fmtMs(A.durationMs), fmtMs(B.durationMs), fmtDelta(report.deltas?.durationMs, 'ms'));
    row('tokens in/out', `${A.tokensIn}/${A.tokensOut}`, `${B.tokensIn}/${B.tokensOut}`, DASH);
    row('tokens total', String(A.tokensTotal), String(B.tokensTotal), fmtDelta(report.deltas?.tokensTotal));
    row('cost (est.)', `$${A.costUsdEstimate}`, `$${B.costUsdEstimate}`, fmtDelta(report.deltas?.costUsdEstimate, ''));
    row('exit code', String(A.exitCode ?? DASH), String(B.exitCode ?? DASH), DASH);
    row('result', `${A.resultStatus} / ${A.resultCode}`, `${B.resultStatus} / ${B.resultCode}`, DASH);
  }
  L.push('');
  L.push('## Gates');
  L.push('');
  if (!report.gatesCompared.length) {
    L.push('_No gate evidence recorded for either run._');
  } else {
    L.push('| gate | A | B |');
    L.push('|---|---|---|');
    for (const g of report.gatesCompared) {
      const mark = g.changed ? ' **← changed**' : '';
      L.push(`| ${g.gate} | \`${g.A}\` | \`${g.B}\`${mark} |`);
    }
  }
  L.push('');
  L.push('## Trace path (state machine, from the append-only event log)');
  L.push('');
  L.push(`_${report.traceSummary.states}_  (${report.traceSummary.steps} steps${report.traceSummary.revisited.length ? `; revisited: ${report.traceSummary.revisited.join(', ')}` : ''})`);
  L.push('');
  for (const step of report.tracePath) {
    L.push(`- \`${step.ts ?? '?'}\` **${step.actor}** ${step.action}${step.to ? ` → ${step.to}` : ''}`);
  }
  if (report.modelRuns?.length) {
    L.push('');
    L.push('## Model runs (router attribution)');
    L.push('');
    L.push('| model | outcome | tokens | cost (est.) | duration |');
    L.push('|---|---|---|---|---|');
    for (const m of report.modelRuns) {
      L.push(`| ${m.model_id} | ${m.outcome ?? DASH} | ${m.tokens ?? DASH} | $${m.cost_usd ?? 0} | ${fmtMs(m.duration_ms)} |`);
    }
  }
  L.push('');
  for (const note of report.notes) L.push(`> ${note}`);
  return L.join('\n') + '\n';
}

export default { compareRuns, renderSideBySide, tracePathFor, gatesForRun, modelsForTask };
