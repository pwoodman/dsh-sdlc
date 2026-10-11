/**
 * tests/unit/budget.test.mjs — budgets & timeout policy (spec v3 B.7, K.5 clock/timeout row).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const b = await core.budget();

test('defaults match the B.7 table exactly', () => {
  assert.deepEqual(b.RISK_BUDGET_DEFAULTS.R1, { maxAttempts: 2, maxDurationMs: 1800000, maxCostUsd: 2.0, maxTokens: 200000 });
  assert.deepEqual(b.RISK_BUDGET_DEFAULTS.R2, { maxAttempts: 3, maxDurationMs: 3600000, maxCostUsd: 5.0, maxTokens: 400000 });
  assert.deepEqual(b.RISK_BUDGET_DEFAULTS.R3, { maxAttempts: 3, maxDurationMs: 7200000, maxCostUsd: 15.0, maxTokens: 1000000 });
  assert.deepEqual(b.RISK_BUDGET_DEFAULTS.R4, { maxAttempts: 4, maxDurationMs: 14400000, maxCostUsd: 50.0, maxTokens: 3000000 });
  assert.deepEqual(b.PROJECT_BUDGET_DEFAULTS, { maxCostUsd: 200.0, maxDurationMs: 86400000, maxParallelWorkers: 'auto' });
});

test('cumulative limits are attempts × per-attempt', () => {
  const cumulative = b.cumulativeBudgets(b.RISK_BUDGET_DEFAULTS.R2);
  assert.equal(cumulative.maxDurationMs, 3600000 * 3);
  assert.equal(cumulative.maxTokens, 400000 * 3);
  assert.equal(cumulative.maxCostUsd, 15);
});

test('checkDispatch blocks on any exhausted cumulative limit', () => {
  const budget = b.RISK_BUDGET_DEFAULTS.R2;
  assert.equal(b.checkDispatch({ attempt: 0 }, budget).ok, true);
  assert.match(b.checkDispatch({ attempt: 3 }, budget).reason, /max_attempts/);
  assert.match(b.checkDispatch({ attempt: 1, spentCostUsd: 15 }, budget).reason, /cost/);
  assert.match(b.checkDispatch({ attempt: 1, spentTokens: 1_200_000 }, budget).reason, /tokens/);
  assert.match(b.checkDispatch({ attempt: 1, spentDurationMs: 10_800_000 }, budget).reason, /duration/);
});

test('checkProjectBudget blocks the whole run', () => {
  assert.equal(b.checkProjectBudget({ spentCostUsd: 10 }).ok, true);
  assert.match(b.checkProjectBudget({ spentCostUsd: 200 }).reason, /project-cost/);
  assert.match(b.checkProjectBudget({ spentDurationMs: 86400000 }).reason, /project-duration/);
});

test('evaluateRun distinguishes per-attempt overrun from cumulative exhaustion', () => {
  const budget = b.RISK_BUDGET_DEFAULTS.R2;
  const over = b.evaluateRun({ attempt: 0, run: { costUsd: 6, tokens: 10, durationMs: 10 }, taskBudget: budget });
  assert.equal(over.action, 'retry');
  assert.equal(over.perAttemptOver, true);

  const exhausted = b.evaluateRun({ attempt: 3, run: { costUsd: 1, tokens: 1, durationMs: 1 }, taskBudget: budget });
  assert.equal(exhausted.action, 'escalate', 'cumulative exhaustion is an explicit decision, not a silent retry');
  assert.match(exhausted.reason, /BUDGET_EXHAUSTED/);

  const blocked = b.evaluateRun({
    attempt: 0, run: { costUsd: 1 }, taskBudget: budget,
    projectBudget: b.PROJECT_BUDGET_DEFAULTS, projectSpend: { costUsd: 200, durationMs: 0 },
  });
  assert.equal(blocked.action, 'block');
  assert.match(blocked.reason, /project-cost/);

  assert.equal(b.evaluateRun({ attempt: 0, run: { costUsd: 0 }, taskBudget: budget }).action, 'continue');
});

test('timeout policy: soft at 80 %, hard at 100 % of the per-attempt budget', () => {
  let now = 1_000_000;
  const t = b.timeoutThresholds(1000, () => now);
  assert.equal(t.phase(), 'ok');
  now += 800; assert.equal(t.phase(), 'soft');
  now += 200; assert.equal(t.phase(), 'hard');
});

test('backoff is exponential and capped (provider 429 backpressure)', () => {
  assert.equal(b.backoffDelay(0), 1000);
  assert.equal(b.backoffDelay(1), 2000);
  assert.equal(b.backoffDelay(3), 8000);
  assert.equal(b.backoffDelay(50), 60000, 'capped');
});

test('per-task budgets must be below per-project budgets (H.3 sanity input)', async () => {
  const cfg = await core.config();
  const check = cfg.validateConfig(cfg.DEFAULT_CONFIG, { projectRoot: process.cwd() });
  assert.equal(check.errors.some((e) => e.startsWith('budgets:')), false);
});

test('a spec-shaped snake_case budgets block normalizes to the internal model (B.3.1)', () => {
  // B.3.1/H.1 write the task contract in snake_case; the runtime model is
  // camelCase. Both must be accepted at the contract boundary.
  const snake = b.normalizeTaskBudget({ max_attempts: 4, max_duration_ms: 1000, max_cost_usd: 2.5, max_tokens: 123 }, 'R2');
  assert.deepEqual(snake.budget, { maxAttempts: 4, maxDurationMs: 1000, maxCostUsd: 2.5, maxTokens: 123 });
  assert.deepEqual(snake.unknownKeys, []);

  const camel = b.normalizeTaskBudget({ maxAttempts: 5 }, 'R1');
  assert.equal(camel.budget.maxAttempts, 5);
  assert.equal(camel.budget.maxTokens, b.RISK_BUDGET_DEFAULTS.R1.maxTokens, 'unspecified keys fall back to the risk default');

  const partial = b.normalizeTaskBudget({ max_cost_usd: 9 }, 'R3');
  assert.equal(partial.budget.maxCostUsd, 9);
  assert.equal(partial.budget.maxAttempts, b.RISK_BUDGET_DEFAULTS.R3.maxAttempts);

  const unknown = b.normalizeTaskBudget({ max_attempts: 1, wibble: 2 }, 'R2');
  assert.deepEqual(unknown.unknownKeys, ['wibble'], 'unknown keys are reported, never silently dropped');

  assert.deepEqual(b.normalizeTaskBudget(null, 'R2').budget, b.RISK_BUDGET_DEFAULTS.R2);
});
