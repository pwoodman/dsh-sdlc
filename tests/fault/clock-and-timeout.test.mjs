/**
 * tests/fault/clock-and-timeout.test.mjs — L5 fault matrix row: clock skew
 * (spec v3 B.3.2, B.7, K.5).
 *
 * The timeout policy takes an injected clock, so a skewed worker wall clock is
 * irrelevant: soft at 80 %, hard at 100 %, and the phase is monotonic in the
 * injected time. Duration accounting is monotonic and derived from the supplied
 * `durationMs`, never from `Date.now()`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const { timeoutThresholds, cumulativeBudgets, evaluateRun, backoffDelay } = await core.budget();

const PHASE_RANK = { ok: 0, soft: 1, hard: 2 };

test('timeoutThresholds uses the injected clock: soft at 80 %, hard at 100 %', () => {
  let now = 1000;
  const clock = () => now;
  const MAX = 10_000;
  const th = timeoutThresholds(MAX, clock);

  assert.equal(th.startedAt, 1000, 'the start comes from the injected clock, not the wall clock');
  assert.equal(th.softAt, 1000 + MAX * 0.8);
  assert.equal(th.hardAt, 1000 + MAX);

  assert.equal(th.phase(), 'ok', 'at t=0 the run is ok');
  now = 1000 + MAX * 0.8 - 1;
  assert.equal(th.phase(), 'ok', 'just before 80 % is still ok');
  now = 1000 + MAX * 0.8;
  assert.equal(th.phase(), 'soft', 'exactly at 80 % is soft');
  now = 1000 + MAX - 1;
  assert.equal(th.phase(), 'soft', 'between 80 % and 100 % is soft');
  now = 1000 + MAX;
  assert.equal(th.phase(), 'hard', 'exactly at 100 % is hard');
  now = 1000 + MAX * 5;
  assert.equal(th.phase(), 'hard', 'past 100 % stays hard');
});

test('the timeout phase is monotonic in elapsed time (never regresses)', () => {
  let now = 0;
  const MAX = 1000;
  const th = timeoutThresholds(MAX, () => now);
  let prev = -1;
  for (let t = 0; t <= MAX * 2; t += 25) {
    now = t;
    const rank = PHASE_RANK[th.phase()];
    assert.ok(rank >= prev, `phase regressed at t=${t}`);
    prev = rank;
  }
  assert.equal(prev, PHASE_RANK.hard);
});

test('duration accounting is monotonic and never reads the wall clock', () => {
  const budget = { maxAttempts: 3, maxDurationMs: 1000, maxCostUsd: 1, maxTokens: 1000 };
  const cumulative = cumulativeBudgets(budget);
  assert.equal(cumulative.maxDurationMs, 3000);

  // Monotonic: once the per-attempt duration crosses the ceiling it stays over.
  let over = false;
  for (const durationMs of [0, 250, 999, 1000, 1001, 5000]) {
    const out = evaluateRun({
      attempt: 0,
      run: { costUsd: 0, tokens: 0, durationMs },
      taskBudget: budget,
    });
    if (durationMs > budget.maxDurationMs) over = true;
    assert.equal(out.perAttemptOver, over, `perAttemptOver wrong at durationMs=${durationMs}`);
  }

  // Determinism under a frozen wall clock proves the result is duration-driven.
  const realNow = Date.now;
  try {
    Date.now = () => 0;
    const frozen = evaluateRun({ attempt: 0, run: { costUsd: 0, tokens: 0, durationMs: 500 }, taskBudget: budget });
    assert.equal(frozen.action, 'continue');
  } finally {
    Date.now = realNow;
  }

  assert.equal(backoffDelay(0), 1000);
});
