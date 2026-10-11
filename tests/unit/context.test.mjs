/**
 * tests/unit/context.test.mjs — context assembly (spec v3 B.11, G.2.5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const ctx = await core.context();

test('blocks render in the fixed B.11 order', () => {
  const { text, manifest } = ctx.assembleContext({
    rolePreamble: 'ROLE',
    constitution: 'CONST',
    contract: { task: { id: 'T1', title: 't', objective: 'o' } },
    files: [{ path: 'src/a.ts', content: 'code' }],
    decisions: '- ADR-1: pick X',
    failureEvidence: 'FAILED LAST TIME',
    architectureSummary: 'ARCH',
  });
  assert.match(text, /## 1\. role-preamble/);
  assert.match(text, /## 2\. constitution-excerpt/);
  assert.match(text, /## 3\. task-contract/);
  assert.match(text, /## 4\. relevant-files/);
  assert.deepEqual(manifest.blocks.map((b) => b.n), [1, 2, 3, 4, 5, 6, 7]);
  const iRole = text.indexOf('ROLE');
  const iContract = text.indexOf('task: T1');
  const iFailure = text.indexOf('FAILED LAST TIME');
  assert.ok(iRole < iContract && iContract < iFailure, 'order is preserved');
});

test('truncation priority drops 4, then 5, then 7 — never 1-3 or 6', () => {
  const big = 'x'.repeat(4000); // ~1000 tokens
  const { manifest, text } = ctx.assembleContext({
    rolePreamble: 'ROLE', constitution: 'C', contract: { task: { id: 'T' } },
    files: [{ path: 'a.ts', content: big }], decisions: big, failureEvidence: 'LAST FAILURE', architectureSummary: big,
  }, { tokenBudget: 400 });
  assert.deepEqual(manifest.dropped.map((d) => d.n), [4, 5, 7]);
  assert.match(text, /LAST FAILURE/, 'failure evidence is never dropped');
  assert.match(text, /## 1\. role-preamble/);
  assert.equal(manifest.blocks.find((b) => b.n === 4).dropped, true);
});

test('a budget large enough drops nothing', () => {
  const { manifest } = ctx.assembleContext({ rolePreamble: 'a', constitution: 'b', contract: { task: { id: 'T' } } }, { tokenBudget: 24000 });
  assert.deepEqual(manifest.dropped, []);
});

test('file snippets are capped at maxLinesPerFile', () => {
  const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const { text } = ctx.assembleContext({ files: [{ path: 'big.ts', content }] }, { maxLinesPerFile: 10 });
  assert.match(text, /line 0/);
  assert.match(text, /truncated 490 lines/);
  assert.doesNotMatch(text, /line 400/);
});

test('the manifest records block bytes and the total token estimate', () => {
  const { manifest } = ctx.assembleContext({ rolePreamble: 'abcd' });
  const role = manifest.blocks.find((b) => b.n === 1);
  assert.equal(role.bytes, 4);
  assert.equal(role.tokens, 1);
  assert.equal(manifest.totalTokens, 1);
  assert.equal(manifest.tokenBudget, 24000);
});

test('constitution excerpt maps the domain to fixed sections only', () => {
  const excerpt = ctx.constitutionExcerpt(['backend', 'api']);
  assert.match(excerpt, /S3:/);
  assert.doesNotMatch(excerpt, /S6:/);
  assert.equal(ctx.constitutionExcerpt([]), '');
});

test('task contract rendering is deterministic and complete', () => {
  const text = ctx.renderTaskContract({
    task: {
      id: 'API-042', title: 'endpoint', objective: 'add it', role: 'api-engineer', risk_class: 'R2',
      capabilities: ['api'], allowed_paths: ['src/api/**'], forbidden_paths: ['src/auth/**'],
      verification: ['unit', 'api'],
      acceptance_criteria: [{ id: 'AC1', statement: 'works', check: 'api:test' }],
    },
  });
  assert.match(text, /^task: API-042/m);
  assert.match(text, /allowed_paths: src\/api\/\*\*/);
  assert.match(text, /- AC1: works \(api:test\)/);
  assert.equal(text, ctx.renderTaskContract({
    task: {
      id: 'API-042', title: 'endpoint', objective: 'add it', role: 'api-engineer', risk_class: 'R2',
      capabilities: ['api'], allowed_paths: ['src/api/**'], forbidden_paths: ['src/auth/**'],
      verification: ['unit', 'api'],
      acceptance_criteria: [{ id: 'AC1', statement: 'works', check: 'api:test' }],
    },
  }));
});

test('relevant decisions are filtered by domain tag intersection', () => {
  const decisions = [
    { id: 'ADR-1', tags: ['backend'], decision: 'use postgres', consequence: 'ops burden' },
    { id: 'ADR-2', tags: ['ux-ui'], decision: 'use a modal' },
  ];
  const relevant = ctx.relevantDecisions(decisions, ['backend']);
  assert.deepEqual(relevant.map((d) => d.id), ['ADR-1']);
  assert.match(ctx.renderDecisions(relevant), /ADR-1: use postgres — ops burden/);
});
