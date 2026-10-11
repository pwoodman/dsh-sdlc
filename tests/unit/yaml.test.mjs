/**
 * tests/unit/yaml.test.mjs — the dependency-free YAML subset used by .sdlc/config.yml.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const y = await core.yaml();

test('block mappings, sequences, flow maps and flow sequences parse', () => {
  const doc = y.parseYaml([
    'a: 1',
    'b: true',
    'c: null',
    'd: hello',
    'e:',
    '  - x',
    '  - y: 2',
    '    z: 3',
    'f: { input: 0.15, output: 0.6 }',
    'g: [1, 2, three]',
    "h: 'quoted: value'",
    'i: "with \\"escape\\""',
  ].join('\n'));
  assert.equal(doc.a, 1);
  assert.equal(doc.b, true);
  assert.equal(doc.c, null);
  assert.equal(doc.d, 'hello');
  assert.deepEqual(doc.e, ['x', { y: 2, z: 3 }]);
  assert.deepEqual(doc.f, { input: 0.15, output: 0.6 });
  assert.deepEqual(doc.g, [1, 2, 'three']);
  assert.equal(doc.h, 'quoted: value');
  assert.equal(doc.i, 'with "escape"');
});

test('comments, blank lines and inline hashes are handled', () => {
  const doc = y.parseYaml('# top\na: 1  # trailing\n\nb: "has # inside"\n');
  assert.deepEqual(doc, { a: 1, b: 'has # inside' });
});

test('quoted keys (model ids) survive the round trip', () => {
  const text = y.dumpYaml({ pricing: { 'openai/gpt-4o': { input: 2.5, output: 10 } } });
  const parsed = y.parseYaml(text);
  assert.deepEqual(parsed.pricing['openai/gpt-4o'], { input: 2.5, output: 10 });
});

test('dump → parse is idempotent for the config subset', () => {
  const value = {
    tiers: { cheap: [{ provider: 'openai', model: 'gpt-4o-mini' }], base: [], elevated: [] },
    execution: { basePort: 4100, workerEnvKeys: [], egress: { mode: 'allowlist', hosts: ['registry.npmjs.org'] } },
    nested: { deep: { deeper: [1, 2, { k: 'v' }] } },
  };
  const once = y.parseYaml(y.dumpYaml(value));
  const twice = y.parseYaml(y.dumpYaml(once));
  assert.deepEqual(once, value);
  assert.deepEqual(twice, once);
});

test('unsupported YAML fails loudly rather than guessing', () => {
  assert.throws(() => y.parseYaml('a:\n\tb: 1'), /tab indentation/);
  assert.throws(() => y.parseYaml('just a bare scalar without colon'), /expected "key: value"/);
  assert.throws(() => y.parseYaml('a: [1, 2'), /unterminated flow sequence/);
  assert.throws(() => y.parseYaml('a: {x: 1'), /unterminated flow mapping/);
});

test('empty documents parse to null', () => {
  assert.equal(y.parseYaml(''), null);
  assert.equal(y.parseYaml('# only a comment'), null);
});

test('scalar quoting is minimal but safe', () => {
  const text = y.dumpYaml({ win: 'true', num: '5', plain: 'hello', colon: 'a: b', empty: '' });
  const parsed = y.parseYaml(text);
  assert.equal(parsed.win, 'true');
  assert.equal(parsed.num, '5');
  assert.equal(parsed.plain, 'hello');
  assert.equal(parsed.colon, 'a: b');
  assert.equal(parsed.empty, '');
});
