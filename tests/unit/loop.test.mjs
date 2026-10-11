/**
 * tests/unit/loop.test.mjs — loop fingerprinting & elevation (spec v3 B.6, G.2.5, K.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

const loop = await core.loop();

test('normalization removes paths, numbers, ids and hashes', () => {
  const a = loop.normalizeFailureText('FAIL src/api/users.ts:42 expected 3 got 5 (id 9f8a7b6c)');
  const b = loop.normalizeFailureText('FAIL src/other/thing.ts:999 expected 17 got 21 (id deadbeef99)');
  assert.equal(a, b);
  assert.match(a, /<path>/);
  assert.match(a, /<n>/);
});

test('normalization collapses whitespace and truncates to 200 chars', () => {
  assert.equal(loop.normalizeFailureText('a\n\n   b\t c'), 'a b c');
  assert.equal(loop.normalizeFailureText('x'.repeat(500)).length, 200);
});

test('identical failures collide; a different gate or file set does not', () => {
  const f1 = loop.fingerprint({ taskId: 'T1', gate: 'unit', failureText: 'Error: expected 1 got 2', filesChanged: ['src/a.ts', 'src/b.ts'] });
  const f2 = loop.fingerprint({ taskId: 'T1', gate: 'unit', failureText: 'Error: expected 3 got 4', filesChanged: ['src/b.ts', 'src/a.ts'] });
  assert.equal(f1.key, f2.key, 'normalized failures and sorted files must collide');

  const g = loop.fingerprint({ taskId: 'T1', gate: 'integration', failureText: 'Error: expected 1 got 2', filesChanged: ['src/a.ts', 'src/b.ts'] });
  assert.notEqual(f1.key, g.key, 'a different gate is a different signature');

  const h = loop.fingerprint({ taskId: 'T1', gate: 'unit', failureText: 'Error: expected 1 got 2', filesChanged: ['src/zzz.ts'] });
  assert.notEqual(f1.key, h.key);

  const other = loop.fingerprint({ taskId: 'T2', gate: 'unit', failureText: 'Error: expected 1 got 2', filesChanged: ['src/a.ts', 'src/b.ts'] });
  assert.notEqual(f1.key, other.key, 'fingerprints are task-scoped');
});

test('fingerprint uses only the top-5 sorted files_changed', () => {
  const many = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
  const a = loop.fingerprint({ taskId: 'T', gate: 'unit', failureText: 'x', filesChanged: many });
  const b = loop.fingerprint({ taskId: 'T', gate: 'unit', failureText: 'x', filesChanged: [...many].reverse() });
  assert.equal(a.key, b.key);
  assert.equal(a.files.split(',').length, 5);
});

test('detectLoop: the same fingerprint twice escapes to ESCALATED', () => {
  const fp = loop.fingerprint({ taskId: 'T1', gate: 'unit', failureText: 'Error: nope' });
  const result = loop.detectLoop([{ status: 'failed', fingerprint: fp }, { status: 'failed', fingerprint: fp }]);
  assert.equal(result.loop, true);
  assert.equal(result.reason, 'fingerprint-repeat:2');
});

test('detectLoop: three failures of any signature escapes', () => {
  const attempts = [1, 2, 3].map((n) => ({ status: 'failed', fingerprint: loop.fingerprint({ taskId: 'T', gate: 'unit', failureText: `distinct failure ${n}` }) }));
  const result = loop.detectLoop(attempts);
  assert.equal(result.loop, true);
  assert.equal(result.reason, 'max-failed-attempts:3');
});

test('detectLoop: a single failure is not a loop', () => {
  const fp = loop.fingerprint({ taskId: 'T', gate: 'unit', failureText: 'one off' });
  assert.equal(loop.detectLoop([{ status: 'failed', fingerprint: fp }]).loop, false);
});

test('elevation packet has the documented shape and truncates evidence to 8 KiB', () => {
  const packet = loop.buildElevationPacket({
    taskId: 'API-042',
    attempts: [{ n: 1, model: { provider: 'p', id: 'm' }, status: 'failed', signature: 'sig' }],
    failures: ['x'.repeat(20000)],
    filesChanged: ['src/a.ts'],
    testOutputPath: '.sdlc/verification/API-042/unit.log',
    relevantDecisions: ['ADR-1'],
  });
  assert.equal(packet.task_id, 'API-042');
  assert.equal(packet.attempts[0].signature, 'sig');
  assert.equal(packet.failures[0].length, 8192);
  assert.equal(packet.request, 'diagnose root cause and propose corrective action');
  assert.equal(packet.relevant_decisions[0], 'ADR-1');
});

test('parseElevationResponse validates the structured answer and rejects junk', () => {
  const good = loop.parseElevationResponse(JSON.stringify({
    root_cause: 'too wide', failure_pattern: 'scope', mis_decomposition: true,
    architecture_issue: false, corrective_plan: [{ a: 1 }], disposition: 'replan',
  }));
  assert.equal(good.ok, true);
  assert.equal(good.value.disposition, 'replan');
  assert.equal(loop.parseElevationResponse('not json').ok, false);
  assert.equal(loop.parseElevationResponse(JSON.stringify({ root_cause: 'x' })).ok, false);
  assert.equal(loop.parseElevationResponse(JSON.stringify({
    root_cause: 'x', failure_pattern: 'y', mis_decomposition: false, architecture_issue: false,
    corrective_plan: [], disposition: 'nonsense',
  })).ok, false);
});

test('the escalation ladder is monotone and terminates at USER', () => {
  assert.deepEqual(loop.LADDER, ['CHEAP', 'BASE', 'ELEVATED', 'ARCHITECTURE_REVIEW', 'USER']);
  assert.equal(loop.nextLadderStep('CHEAP'), 'BASE');
  assert.equal(loop.nextLadderStep('ELEVATED'), 'ARCHITECTURE_REVIEW');
  assert.equal(loop.nextLadderStep('USER'), 'USER');
  assert.equal(loop.nextLadderStep('garbage'), 'USER');
});
