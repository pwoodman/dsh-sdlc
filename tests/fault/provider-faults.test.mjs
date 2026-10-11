/**
 * tests/fault/provider-faults.test.mjs — L5 fault matrix rows: provider 429
 * storm and provider 500 (spec v3 B.7, B.8, K.5).
 *
 * The mock provider is deterministic: `mock/<scenario>?fail=429:2` fails the
 * first two calls and succeeds on the third, recording every attempt in its
 * request log. `budget.backoffDelay` is exponential and capped. On a 500 the
 * fallback chain advances to the next eligible candidate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tempDir, cleanup, core } from '../lib/helpers.mjs';

const { MockLlm, MockLlmError } = await core.mockLlm();
const { backoffDelay } = await core.budget();
const { ModelRouter } = await core.router();

function makeLlm(recordDir, recordName = 'requests.jsonl') {
  const recordPath = join(recordDir, recordName);
  const llm = new MockLlm({
    scenarios: { impl: { default: { text: 'implemented', usage: { inputTokens: 11, outputTokens: 22 } } } },
    recordPath,
    runId: 'run-1',
  });
  return { llm, recordPath };
}

test('mock/<scenario>?fail=429:2 throws 429 twice and then succeeds, logging every attempt', () => {
  const dir = tempDir('sdlc-fault-429-');
  try {
    const { llm, recordPath } = makeLlm(dir);
    const model = 'mock/impl?fail=429:2';

    assert.throws(() => llm.respond({ model, runId: 'run-1' }), (err) => {
      assert.ok(err instanceof MockLlmError);
      assert.equal(err.status, 429);
      return true;
    });
    assert.throws(() => llm.respond({ model, runId: 'run-1' }), (err) => err.status === 429);

    const ok = llm.respond({ model, runId: 'run-1' });
    assert.equal(ok.text, 'implemented');

    assert.equal(llm.requests.length, 3, 'the request log records every attempt');
    assert.deepEqual(llm.requests.map((r) => r.outcome), ['error:429', 'error:429', 'ok']);
    assert.deepEqual(llm.requests.map((r) => r.callIndex), [1, 2, 3]);

    const lines = readFileSync(recordPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).outcome, 'error:429');
  } finally {
    cleanup(dir);
  }
});

test('backoffDelay is exponential and capped', () => {
  assert.equal(backoffDelay(0, { baseMs: 1000, capMs: 60000 }), 1000);
  assert.equal(backoffDelay(1, { baseMs: 1000, capMs: 60000 }), 2000);
  assert.equal(backoffDelay(2, { baseMs: 1000, capMs: 60000 }), 4000);
  assert.equal(backoffDelay(3, { baseMs: 1000, capMs: 60000 }), 8000);

  let prev = 0;
  for (let attempt = 0; attempt <= 30; attempt += 1) {
    const delay = backoffDelay(attempt, { baseMs: 1000, capMs: 60000 });
    assert.ok(delay >= prev, 'cooldown is monotonic');
    assert.ok(delay <= 60000, 'cooldown is capped — never unbounded');
    prev = delay;
  }
  assert.equal(backoffDelay(100, { baseMs: 1000, capMs: 60000 }), 60000);
});

test('a provider 500 advances the fallback chain to the next candidate, in score order', () => {
  const dir = tempDir('sdlc-fault-500-');
  try {
    const { llm } = makeLlm(dir);
    const router = new ModelRouter({
      tiers: {
        cheap: [{ provider: 'mock', model: 'cheap-a' }],
        base: [{ provider: 'mock', model: 'base-good' }, { provider: 'mock', model: 'base-weak' }],
        elevated: [{ provider: 'mock', model: 'elev' }],
      },
      pricing: {
        'mock/cheap-a': { input: 1, output: 1 },
        'mock/base-good': { input: 1, output: 1 },
        'mock/base-weak': { input: 100, output: 100 },
        'mock/elev': { input: 5, output: 5 },
      },
      history: {
        'mock/base-good:default': { successes: 9, failures: 1 },
        'mock/base-weak:default': { successes: 1, failures: 9 },
      },
    });

    const task = { id: 'T1', task_class: 'normal', attempt: 0, task_type: 'default' };
    const primary = router.route(task);
    assert.equal(primary.model, 'base-good', 'route picks the higher-scored candidate within the tier');

    const chain = router.fallbackChain(task);
    assert.ok(chain.length >= 2, 'the fallback chain is finite and non-empty');
    const models = chain.map((c) => c.model);
    assert.equal(new Set(models).size, models.length, 'no candidate is listed twice (no infinite retry)');
    assert.deepEqual(
      chain.filter((c) => c.tier === 'base').map((c) => c.model),
      ['base-good', 'base-weak'],
      'within a tier the chain is in score order for this configuration',
    );

    const idx = chain.findIndex((c) => c.provider === primary.provider && c.model === primary.model);
    assert.ok(idx >= 0, 'the routed primary is present in the chain');
    const next = chain[idx + 1];
    assert.ok(next, 'a 500 on the primary advances to a next candidate');
    assert.notDeepEqual(
      { provider: next.provider, model: next.model },
      { provider: primary.provider, model: primary.model },
    );

    // The 500 is a real provider error that the request log records.
    const model = 'mock/impl?fail=500:1';
    assert.throws(() => llm.respond({ model, runId: 'run-1' }), (err) => err.status === 500);
    const recovered = llm.respond({ model, runId: 'run-1' });
    assert.equal(recovered.text, 'implemented');
    assert.deepEqual(llm.requests.map((r) => r.outcome), ['error:500', 'ok']);
  } finally {
    cleanup(dir);
  }
});
