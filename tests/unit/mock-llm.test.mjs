/**
 * tests/unit/mock-llm.test.mjs — the deterministic mock provider (spec v3 K.4, E11).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const mock = await core.mockLlm();
const { MockLlm, parseMockModel, defaultScenarios } = mock;

test('same prompt ⇒ same response; no network, no credentials', () => {
  const a = new MockLlm();
  const b = new MockLlm();
  const call = { model: 'mock/plan-api', messages: [{ role: 'user', content: 'plan' }] };
  assert.equal(a.respond(call).text, b.respond(call).text);
  assert.equal(a.respond(call).text, a.respond(call).text);
});

test('route parsing: scenario, fault plan, injection mode and run id', () => {
  assert.deepEqual(parseMockModel('mock/plan-api').scenario, 'plan-api');
  assert.equal(parseMockModel('openai/gpt-4o'), null);
  const fault = parseMockModel('mock/implement?fail=429:2');
  assert.deepEqual(fault.failPlan, { status: 429, times: 2 });
  assert.equal(parseMockModel('mock/implement?inject=escape').inject, 'escape');
  assert.equal(parseMockModel('mock/implement?fail=500:1&inject=falsefile&run=r7').run, 'r7');
});

test('fault mode: the first N calls fail, then the provider succeeds', () => {
  const llm = new MockLlm();
  const call = { model: 'mock/implement?fail=429:2', messages: [{ role: 'user', content: 'x' }] };
  assert.throws(() => llm.respond(call), (err) => err.status === 429);
  assert.throws(() => llm.respond(call), (err) => err.status === 429);
  const ok = llm.respond(call);
  assert.match(ok.text, /sdlc-result/);
});

test('fault mode 500 is distinguishable from 429 (fallback vs backoff)', () => {
  const llm = new MockLlm();
  assert.throws(() => llm.respond({ model: 'mock/implement?fail=500:1', messages: [] }), (err) => err.status === 500);
});

test('injection mode returns hostile content for the L6 suite', () => {
  const llm = new MockLlm();
  const escape = llm.respond({ model: 'mock/implement?inject=escape', messages: [] });
  assert.match(escape.text, /outside the worktree/);
  assert.equal(escape.injected, 'escape');
  const falsefile = llm.respond({ model: 'mock/implement?inject=falsefile', messages: [] });
  assert.match(falsefile.text, /src\/imaginary\.ts/);
  const injection = llm.respond({ model: 'mock/implement?inject=injection', messages: [] });
  assert.match(injection.text, /IGNORE ALL PREVIOUS INSTRUCTIONS/);
  assert.throws(() => llm.respond({ model: 'mock/implement?inject=nope', messages: [] }), /unknown injection mode/);
});

test('unknown scenario and non-mock routes fail loudly, never silently', () => {
  const llm = new MockLlm();
  assert.throws(() => llm.respond({ model: 'mock/does-not-exist', messages: [] }), /unknown mock scenario/);
  assert.throws(() => llm.respond({ model: 'openai/gpt-4o', messages: [] }), /only serves mock\//);
  assert.throws(() => new MockLlm({ withDefaults: false }).respond({ model: 'mock/plan-api', messages: [] }), /unknown mock scenario/);
});

test('scripted responses can be keyed by request hash or supplied per scenario', () => {
  const llm = new MockLlm({ scenarios: { custom: { default: { text: 'fallback text' } } } });
  assert.equal(llm.respond({ model: 'mock/custom', messages: [] }).text, 'fallback text');
  llm.register('listed', [{ text: 'first' }, { text: 'second' }]);
  assert.equal(llm.respond({ model: 'mock/listed', messages: [] }).text, 'first');
  assert.equal(llm.respond({ model: 'mock/listed', messages: [] }).text, 'second');
  assert.equal(llm.respond({ model: 'mock/listed', messages: [] }).text, 'second', 'last response repeats');
});

test('every request is recorded so tests can assert what was ASKED (K.4)', () => {
  const dir = tempDir('sdlc-mock-');
  try {
    const recordPath = join(dir, 'requests.jsonl');
    const llm = new MockLlm({ recordPath });
    llm.respond({ model: 'mock/plan-api', messages: [{ role: 'user', content: 'plan it' }] });
    assert.equal(llm.requests.length, 1);
    assert.equal(llm.requests[0].scenario, 'plan-api');
    assert.match(llm.requests[0].requestHash, /^[0-9a-f]{16}$/);
    const lines = readFileSync(recordPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).outcome, 'ok');
  } finally { cleanup(dir); }
});

test('the default scenario set covers the pipeline stages the tests need', () => {
  const scenarios = defaultScenarios();
  for (const name of ['plan-trivial', 'plan-api', 'implement', 'review-accept', 'review-reject', 'elevation', 'visual-rubric']) {
    assert.ok(scenarios[name], `missing default scenario ${name}`);
  }
});

test('stream yields text, usage and end deterministically', async () => {
  const llm = new MockLlm();
  const chunks = [];
  for await (const chunk of llm.stream({ model: 'mock/implement', messages: [] })) chunks.push(chunk.type);
  assert.deepEqual(chunks, ['text', 'usage', 'end']);
});

test('the provider descriptor registers a deterministic provider (never published)', () => {
  const descriptor = new MockLlm().providerDescriptor();
  assert.equal(descriptor.id, 'mock');
  assert.ok(descriptor.models.includes('mock/*'));
  assert.equal(typeof descriptor.complete, 'function');
});
