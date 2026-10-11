/**
 * packages/sdlc-core/src/budget.js — per-attempt vs per-task budgets (spec v3 B.7).
 *
 * Semantics fixed in v3:
 *   - `max_attempts` is PER TASK.
 *   - `max_duration_ms`, `max_cost_usd`, `max_tokens` are PER ATTEMPT; the task
 *     also carries derived cumulative limits `attempts × per-attempt`, which the
 *     scheduler checks before dispatch.
 *   - A run that exceeds its per-attempt wall clock is killed by the timeout
 *     policy (soft at 80 %, hard at 100 %).
 *   - A task whose CUMULATIVE limits are exhausted moves to ESCALATED, not
 *     FAILED, so the decision is explicit.
 */

export const RISK_BUDGET_DEFAULTS = Object.freeze({
  R1: { maxAttempts: 2, maxDurationMs: 1800000, maxCostUsd: 2.0, maxTokens: 200000 },
  R2: { maxAttempts: 3, maxDurationMs: 3600000, maxCostUsd: 5.0, maxTokens: 400000 },
  R3: { maxAttempts: 3, maxDurationMs: 7200000, maxCostUsd: 15.0, maxTokens: 1000000 },
  R4: { maxAttempts: 4, maxDurationMs: 14400000, maxCostUsd: 50.0, maxTokens: 3000000 },
});

export const PROJECT_BUDGET_DEFAULTS = Object.freeze({
  maxCostUsd: 200.0,
  maxDurationMs: 86400000,
  maxParallelWorkers: 'auto',
});

export const SOFT_BUDGET_RATIO = 0.8;

export function budgetsForRisk(risk, perTask = RISK_BUDGET_DEFAULTS) {
  return { ...(perTask[risk] ?? perTask.R2) };
}

/** The canonical task-contract budget keys, per spec B.3.1 / H.1 (snake_case). */
export const BUDGET_ALIASES = {
  max_attempts: 'maxAttempts',
  maxAttempts: 'maxAttempts',
  max_duration_ms: 'maxDurationMs',
  maxDurationMs: 'maxDurationMs',
  max_cost_usd: 'maxCostUsd',
  maxCostUsd: 'maxCostUsd',
  max_tokens: 'maxTokens',
  maxTokens: 'maxTokens',
};

/**
 * Normalize a task-contract `budgets` block. B.3.1 writes snake_case
 * (`max_attempts`, `max_duration_ms`, …) while the internal model is camelCase;
 * BOTH are accepted so a spec-shaped contract round-trips without translation by
 * the caller. Unknown keys are reported rather than silently dropped.
 *
 * @returns {{budget:object, unknownKeys:string[]}}
 */
export function normalizeTaskBudget(budgets, risk = 'R2', perTask = RISK_BUDGET_DEFAULTS) {
  const base = budgetsForRisk(risk, perTask);
  if (budgets == null) return { budget: base, unknownKeys: [] };
  const unknownKeys = [];
  const out = { ...base };
  for (const [key, value] of Object.entries(budgets)) {
    const canonical = BUDGET_ALIASES[key];
    if (!canonical) { unknownKeys.push(key); continue; }
    out[canonical] = typeof value === 'number' ? value : Number(value);
  }
  return { budget: out, unknownKeys };
}

/** Derive the cumulative (whole-task) ceilings from a per-attempt budget. */
export function cumulativeBudgets(perAttempt) {
  return {
    maxAttempts: perAttempt.maxAttempts,
    maxDurationMs: perAttempt.maxDurationMs * perAttempt.maxAttempts,
    maxCostUsd: round6(perAttempt.maxCostUsd * perAttempt.maxAttempts),
    maxTokens: perAttempt.maxTokens * perAttempt.maxAttempts,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Scheduler gate before dispatch.
 * @returns {{ok:boolean, reason?:string}} `BUDGET_EXHAUSTED` blocks dispatch.
 */
export function checkDispatch({ attempt = 0, spentCostUsd = 0, spentTokens = 0, spentDurationMs = 0 } = {}, budget) {
  const cumulative = cumulativeBudgets(budget);
  if (attempt >= budget.maxAttempts) return { ok: false, reason: 'BUDGET_EXHAUSTED:max_attempts' };
  if (spentCostUsd >= cumulative.maxCostUsd) return { ok: false, reason: 'BUDGET_EXHAUSTED:cost' };
  if (spentTokens >= cumulative.maxTokens) return { ok: false, reason: 'BUDGET_EXHAUSTED:tokens' };
  if (spentDurationMs >= cumulative.maxDurationMs) return { ok: false, reason: 'BUDGET_EXHAUSTED:duration' };
  return { ok: true };
}

/** Project-level run budget. */
export function checkProjectBudget({ spentCostUsd = 0, spentDurationMs = 0 } = {}, projectBudget = PROJECT_BUDGET_DEFAULTS) {
  if (projectBudget.maxCostUsd != null && spentCostUsd >= projectBudget.maxCostUsd) {
    return { ok: false, reason: 'BUDGET_EXHAUSTED:project-cost' };
  }
  if (projectBudget.maxDurationMs != null && spentDurationMs >= projectBudget.maxDurationMs) {
    return { ok: false, reason: 'BUDGET_EXHAUSTED:project-duration' };
  }
  return { ok: true };
}

/** Timeout policy thresholds for a single run (B.3.2). */
export function timeoutThresholds(maxDurationMs, now = () => Date.now()) {
  const start = now();
  return {
    startedAt: start,
    softAt: start + maxDurationMs * SOFT_BUDGET_RATIO,
    hardAt: start + maxDurationMs,
    phase(t = now()) {
      if (t >= start + maxDurationMs) return 'hard';
      if (t >= start + maxDurationMs * SOFT_BUDGET_RATIO) return 'soft';
      return 'ok';
    },
  };
}

/**
 * Post-run accounting. Returns the next action the scheduler must take.
 * `exhausted` ⇒ ESCALATED (explicit decision), `overrun` ⇒ kill/retry path.
 *
 * `taskSpend` is THIS task's spend from earlier attempts — it feeds the task
 * cumulative cost ceiling. `projectSpend` is the whole project's spend and is
 * used ONLY for the project ceiling; conflating the two let an unrelated task's
 * spend escalate a task that had barely started.
 */
export function evaluateRun({
  attempt = 0,
  run = { costUsd: 0, tokens: 0, durationMs: 0 },
  taskBudget,
  taskSpend = { costUsd: 0 },
  projectBudget = PROJECT_BUDGET_DEFAULTS,
  projectSpend = { costUsd: 0, durationMs: 0 },
} = {}) {
  const perAttemptOver =
    (run.costUsd ?? 0) > taskBudget.maxCostUsd ||
    (run.tokens ?? 0) > taskBudget.maxTokens ||
    (run.durationMs ?? 0) > taskBudget.maxDurationMs;

  const cumulative = cumulativeBudgets(taskBudget);
  const nextAttempt = attempt + 1;
  const cumulativeExhausted =
    nextAttempt >= taskBudget.maxAttempts ||
    (taskSpend.costUsd ?? 0) + (run.costUsd ?? 0) >= cumulative.maxCostUsd;

  const project = checkProjectBudget(
    { spentCostUsd: (projectSpend.costUsd ?? 0) + (run.costUsd ?? 0), spentDurationMs: (projectSpend.durationMs ?? 0) + (run.durationMs ?? 0) },
    projectBudget,
  );

  if (!project.ok) return { action: 'block', reason: project.reason, perAttemptOver, cumulativeExhausted };
  if (cumulativeExhausted) return { action: 'escalate', reason: 'BUDGET_EXHAUSTED:cumulative', perAttemptOver, cumulativeExhausted };
  if (perAttemptOver) return { action: 'retry', reason: 'PER_ATTEMPT_BUDGET_EXCEEDED', perAttemptOver, cumulativeExhausted };
  return { action: 'continue', reason: null, perAttemptOver, cumulativeExhausted };
}

/** Provider 429 backpressure: exponential cooldown, capped (B.7). */
export function backoffDelay(attempt, { baseMs = 1000, capMs = 60000 } = {}) {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
}

export default {
  RISK_BUDGET_DEFAULTS, PROJECT_BUDGET_DEFAULTS, budgetsForRisk, cumulativeBudgets,
  checkDispatch, checkProjectBudget, evaluateRun, timeoutThresholds, backoffDelay,
};
