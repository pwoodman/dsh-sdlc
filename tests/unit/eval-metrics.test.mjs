/**
 * tests/unit/eval-metrics.test.mjs — objective metric collectors (eval/lib/metrics.mjs).
 *
 * The collector's contract is that it never invents a number: an unmeasurable
 * metric must be `available:false` with a reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectMetrics, normalizeLines, walk, isTestFile, COLLECTOR_IDS } from '../../eval/lib/metrics.mjs';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-metrics-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test('walk skips vendor directories', () => {
  const dir = fixture({ 'src/a.js': 'x', 'node_modules/pkg/index.js': 'x', 'dist/b.js': 'x' });
  try {
    const files = walk(dir);
    assert.ok(files.includes('src/a.js'));
    assert.ok(!files.some((f) => f.startsWith('node_modules/')));
    assert.ok(!files.some((f) => f.startsWith('dist/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeLines drops blanks and comments and collapses whitespace', () => {
  assert.deepEqual(normalizeLines('  a  b \n\n// c\n/* d\n e \n'), ['a b', 'e']);
  assert.equal(isTestFile('src/a.test.js'), true);
  assert.equal(isTestFile('tests/x.mjs'), true);
  assert.equal(isTestFile('src/a.js'), false);
});

test('loc does not count a trailing newline as an extra line', () => {
  const dir = fixture({ 'src/one.js': 'a\n', 'src/two.js': 'a\nb\n' });
  try {
    const { metrics } = collectMetrics(dir, { metrics: ['loc'] });
    assert.equal(metrics.loc.value, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplication detects a block triplicated across files', () => {
  const body = (n) => `export function validate${n}(x) {\n  if (!x) throw new Error('missing');\n  if (typeof x.name !== 'string') throw new Error('bad');\n  if (x.name.length > 64) throw new Error('long');\n  return true;\n}\n`;
  const dir = fixture({ 'src/a.js': body('A'), 'src/b.js': body('B'), 'src/c.js': body('C') });
  try {
    const { metrics } = collectMetrics(dir, { metrics: ['duplication'] });
    assert.equal(metrics.duplication.available, true);
    assert.ok(metrics.duplication.value > 0.5, `expected heavy duplication, got ${metrics.duplication.value}`);
    assert.ok(metrics.duplication.clones >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplication is ~0 for genuinely distinct files', () => {
  const dir = fixture({
    'src/a.js': 'export const a = 1;\nexport function f(x) { return x + 1; }\n',
    'src/b.js': 'import { a } from "./a.js";\nexport class B { constructor() { this.a = a; } }\n',
  });
  try {
    const { metrics } = collectMetrics(dir, { metrics: ['duplication'] });
    assert.equal(metrics.duplication.value, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secrets and dangerous patterns are detected, with redacted evidence', () => {
  const dir = fixture({ 'src/leak.js': 'const k = "AKIAIOSFODNN7EXAMPLE";\nconst r = eval("1");\n' });
  try {
    const { metrics } = collectMetrics(dir, { metrics: ['secrets', 'dangerous-patterns'] });
    assert.equal(metrics.secrets.value, 1);
    assert.equal(metrics.secrets.hits[0].pattern, 'aws-access-key');
    assert.equal(metrics['dangerous-patterns'].value, 1);
    assert.ok(!JSON.stringify(metrics.secrets).includes('AKIAIOSFODNN7EXAMPLE'), 'the secret itself must not be echoed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unmeasurable metrics are honestly unavailable, never zero', () => {
  const dir = fixture({ 'src/a.js': 'export const a = 1;\n' });
  try {
    const { metrics, unknownMetrics } = collectMetrics(dir, {
      metrics: ['coverage', 'mutation', 'latency-p95', 'error-rate', 'dependency-audit', 'bundle-size', 'static-a11y', 'not-a-real-metric'],
    });
    for (const id of ['coverage', 'mutation', 'latency-p95', 'error-rate', 'dependency-audit', 'bundle-size', 'static-a11y']) {
      assert.equal(metrics[id].available, false, `${id} must be unavailable`);
      assert.equal(metrics[id].value, null);
      assert.ok(metrics[id].note && metrics[id].note.length > 5, `${id} needs a reason`);
    }
    assert.deepEqual(unknownMetrics, ['not-a-real-metric']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifacts turn an otherwise-unavailable metric into a real value', () => {
  const dir = fixture({ 'src/a.js': 'export const a = 1;\n' });
  try {
    const { metrics } = collectMetrics(dir, { metrics: ['coverage', 'latency-p95'], artifacts: { coverage: { value: 87.5 }, load: { value: 42 } } });
    assert.deepEqual({ a: metrics.coverage.available, v: metrics.coverage.value }, { a: true, v: 87.5 });
    assert.equal(metrics['latency-p95'].value, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every declared metric id has a collector', () => {
  const dir = fixture({ 'src/a.js': 'export const a = 1;\n' });
  try {
    const { metrics } = collectMetrics(dir, { metrics: COLLECTOR_IDS });
    for (const id of COLLECTOR_IDS) assert.ok(metrics[id], `no result for ${id}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
