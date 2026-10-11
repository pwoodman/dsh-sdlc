/**
 * tests/adversarial/path-traversal.test.mjs — L6 threat T1: a worker attempts
 * to write outside its scope (spec v3 C.7, K.7, L.4 T1).
 *
 * The guard is policy (L.3): these assertions cover the lexical policy that
 * keeps a cooperative worker inside `allowed_paths`. The sandbox root is the
 * real boundary and the diff is the backstop; both are asserted in other files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const g = await core.guard();
const { GuardPlugin, ORCHESTRATOR_PATHS, PROTECTED_ORCHESTRATOR_PATHS } = g;

function guard(over = {}) {
  return new GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: [], ...over });
}

test('lexical traversal, absolute, NUL, home and Windows paths are denied', () => {
  const gr = guard();
  const cases = [
    ['../../escape', /unsafe-path:traversal/],
    ['src/../..', /unsafe-path:traversal/],
    ['src/../../escape.txt', /unsafe-path:traversal/],
    ['/etc/passwd', /unsafe-path:absolute-path/],
    ['\\etc\\passwd', /unsafe-path:absolute-path/],
    ['//server/share/secret', /unsafe-path:absolute-path/],
    ['C:/Windows/System32', /unsafe-path:absolute-path/],
    ['C:\\Windows\\System32', /unsafe-path:absolute-path/],
    ['D:/data/x', /unsafe-path:absolute-path/],
    ['src/api\u0000.ts', /unsafe-path:nul-byte/],
    ['~', /unsafe-path:home-relative-path/],
    ['~/secret', /unsafe-path:home-relative-path/],
    ['~root/.ssh/id_rsa', /unsafe-path:home-relative-path/],
  ];
  for (const [path, reason] of cases) {
    const decision = gr.decideFsWrite(path);
    assert.equal(decision.kind, 'deny', `expected deny for ${JSON.stringify(path)}`);
    assert.match(decision.reason, reason, `wrong reason for ${JSON.stringify(path)}`);
  }
});

test('unicode dot variants are normalized to .. before the safety check (traversal)', () => {
  const gr = guard();
  // Full-width full stop U+FF0E, one-dot leader U+2024, small full stop U+FE52
  // all NFKC-normalize to '.' and become a traversal.
  const dots = [
    '\uFF0E\uFF0E/\uFF0E\uFF0E/etc/passwd',
    '\u2024\u2024/escape',
    '\uFE52\uFE52/escape',
  ];
  for (const path of dots) {
    const decision = gr.decideFsWrite(path);
    assert.equal(decision.kind, 'deny', `unicode traversal not denied: ${JSON.stringify(path)}`);
    assert.match(decision.reason, /unsafe-path:traversal/);
  }
  // U+FF61 (halfwidth ideographic full stop) NFKC-maps to U+3002, not '.', so it
  // is NOT a dot-traversal — but it is still denied, by the scope check.
  const ff61 = gr.decideFsWrite('\uFF61\uFF61/escape');
  assert.equal(ff61.kind, 'deny');
  assert.equal(ff61.reason, 'outside-allowed-paths');

  // Mixed ASCII/unicode dots normalize together.
  assert.equal(gr.checkFsWrite('src/\uFF0E\uFF0E/..'), 'deny');
});

test('ORCHESTRATOR_PATHS are allowed except the protected set', () => {
  const gr = guard({ allowed_paths: [] });
  assert.ok(ORCHESTRATOR_PATHS.includes('.sdlc/**'));

  // The worker's own result channel is writable.
  assert.equal(gr.checkFsWrite('.sdlc/task-outbox.json'), 'allow');
  assert.equal(gr.checkFsWrite('.sdlc/requests.jsonl'), 'allow');
  assert.equal(gr.checkFsWrite('.dsh/config.json'), 'allow');
  assert.equal(gr.decideFsWrite('.sdlc/task-outbox.json').reason, 'orchestrator-path');

  // The protected orchestrator paths are never writable, even though they are
  // inside an allowed orchestrator prefix.
  for (const p of ['.sdlc/sdlc.db', '.sdlc/sdlc.lock', '.sdlc/task-contract.json']) {
    assert.ok(PROTECTED_ORCHESTRATOR_PATHS.includes(p));
    const decision = gr.decideFsWrite(p);
    assert.equal(decision.kind, 'deny', `protected path not denied: ${p}`);
    assert.match(decision.reason, /protected-orchestrator-path/);
  }
  assert.equal(gr.checkFsWrite('.sdlc/sdlc.db-wal'), 'deny');
  assert.equal(gr.checkFsWrite('.sdlc/sdlc.db-shm'), 'deny');
  assert.equal(gr.checkFsWrite('.sdlc/instance.lock'), 'deny');
  assert.equal(gr.checkFsWrite('.sdlc/backup/sdlc.db'), 'deny');
  assert.equal(gr.checkFsWrite('.sdlc/task-contract.json/../x'), 'deny');
});

test('forbidden_paths beats allowed_paths (deny wins)', () => {
  const gr = new GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: ['src/secret/**'] });
  // Negative control: a sibling inside allowed_paths is fine.
  assert.equal(gr.checkFsWrite('src/app.js'), 'allow');
  const decision = gr.decideFsWrite('src/secret/key.pem');
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.reason, 'forbidden-path:src/secret/**');
  // Also denied when the file would otherwise be an allowed orchestrator path.
  const gr2 = new GuardPlugin({ allowed_paths: ['**'], forbidden_paths: ['.sdlc/**'] });
  assert.equal(gr2.checkFsWrite('.sdlc/anything.json'), 'deny');
});

test('legal in-scope writes and reads stay allowed (control still usable)', () => {
  const gr = guard();
  assert.equal(gr.checkFsWrite('src/api/users.ts'), 'allow');
  // Reads are not scoped by allowed_paths (B.3.2) — a relative path outside
  // `src/**` is readable — but a lexically unsafe read is still denied.
  assert.equal(gr.checkFsRead('README.md'), 'allow');
  assert.equal(gr.checkFsRead('../../etc/passwd'), 'deny');
  assert.equal(gr.checkFsRead('/etc/hosts'), 'deny');
  assert.deepEqual(gr.violations(['src/a.ts', '../../escape']), ['../../escape']);
});
