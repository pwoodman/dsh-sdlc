/**
 * tests/integration/loop-escalation.test.mjs — spec v3 G.3.1, B.6, B.2.1 (L4).
 *
 * Loop detection:
 *   - two identical failure fingerprints ⇒ ESCALATED (loop fingerprint matched);
 *   - ≥3 failed attempts regardless of signature ⇒ ESCALATED.
 * The state machine accepts IN_PROGRESS→ESCALATED by `loop-detector` and
 * VERIFYING→ESCALATED by `verifier`, and rejects any other actor.
 * The elevation packet round-trips through the deterministic `MockLlm`
 * `elevation` scenario, and the response is parsed as a proposal (never applied
 * directly to the graph).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../lib/helpers.mjs';

test('loop-escalation: two identical failure fingerprints ⇒ loop ⇒ ESCALATED', async () => {
  const { fingerprint, detectLoop } = await core.loop();
  const fp = fingerprint({
    taskId: 'API-001',
    gate: 'unit',
    failureText: 'Error at /tmp/x/src/api/customers.ts:42 expected 1 got 2',
    filesChanged: ['src/api/customers.ts'],
  });
  const detection = detectLoop([
    { status: 'failed', fingerprint: fp },
    { status: 'failed', fingerprint: fp },
  ]);
  assert.equal(detection.loop, true);
  assert.equal(detection.reason, 'fingerprint-repeat:2');

  // Same failure text at a different absolute path normalizes to the same signature.
  const sameShape = fingerprint({
    taskId: 'API-001', gate: 'unit',
    failureText: 'Error at /home/other/src/api/customers.ts:99 expected 1 got 2',
    filesChanged: ['src/api/customers.ts'],
  });
  assert.equal(sameShape.signature, fp.signature);
  assert.equal(detectLoop([{ status: 'failed', fingerprint: sameShape }, { status: 'failed', fingerprint: fp }]).loop, true);

  // Three DIFFERENT failures ⇒ still a loop (max-failed-attempts).
  const three = ['gate-a failure', 'gate-b failure', 'gate-c failure'].map((text, i) => ({
    status: 'failed',
    fingerprint: fingerprint({ taskId: 'API-001', gate: 'unit', failureText: text, filesChanged: [`src/f${i}.ts`] }),
  }));
  const detection3 = detectLoop(three);
  assert.equal(detection3.loop, true);
  assert.equal(detection3.reason, 'max-failed-attempts:3');

  // NEGATIVE CONTROL: two genuinely different failures below the attempt cap are NOT a loop.
  assert.equal(detectLoop([
    { status: 'failed', fingerprint: fingerprint({ taskId: 'API-001', gate: 'unit', failureText: 'one' }) },
    { status: 'failed', fingerprint: fingerprint({ taskId: 'API-001', gate: 'unit', failureText: 'two' }) },
  ]).loop, false);
});

test('loop-escalation: state machine accepts ESCALATED from IN_PROGRESS/VERIFYING only for the right actor', async () => {
  const { TaskStateService } = await core.stateMachine();
  const svc = new TaskStateService(':memory:');
  try {
    svc._setState('L-1', 'IN_PROGRESS');
    const byDetector = svc.transition('L-1', 'ESCALATED', 'loop-detector', { loopMatched: true });
    assert.equal(byDetector.ok, true, byDetector.ok ? '' : byDetector.reason);
    assert.equal(svc.getState('L-1'), 'ESCALATED');

    svc._setState('L-2', 'VERIFYING');
    const byVerifier = svc.transition('L-2', 'ESCALATED', 'verifier', { loopMatched: true });
    assert.equal(byVerifier.ok, true, byVerifier.ok ? '' : byVerifier.reason);
    assert.equal(svc.getState('L-2'), 'ESCALATED');

    // NEGATIVE CONTROLS.
    svc._setState('L-3', 'IN_PROGRESS');
    const wrongActor = svc.transition('L-3', 'ESCALATED', 'verifier', { loopMatched: true });
    assert.equal(wrongActor.ok, false);
    assert.equal(wrongActor.error, 'INVALID_TRANSITION');
    assert.match(wrongActor.reason, /actor verifier may not perform IN_PROGRESS→ESCALATED/);

    svc._setState('L-4', 'IN_PROGRESS');
    const noLoop = svc.transition('L-4', 'ESCALATED', 'loop-detector', { loopMatched: false });
    assert.equal(noLoop.ok, false);
    assert.match(noLoop.reason, /guard loopMatched rejected/);
    assert.equal(svc.getState('L-4'), 'IN_PROGRESS', 'a rejected escalation does not change state');
  } finally {
    svc.close();
  }
});

test('loop-escalation: elevation packet round-trips the mock-LLM `elevation` scenario', async () => {
  const { buildElevationPacket, parseElevationResponse } = await core.loop();
  const { MockLlm, defaultScenarios } = await core.mockLlm();

  const packet = buildElevationPacket({
    taskId: 'API-001',
    attempts: [{ n: 1, status: 'failed' }, { n: 2, status: 'failed' }],
    failures: ['ERROR: scope violation at src/auth/login.ts'],
    filesChanged: ['src/auth/login.ts'],
    outOfScopeFiles: ['src/auth/login.ts'],
  });
  assert.equal(packet.task_id, 'API-001');
  assert.equal(packet.attempts.length, 2);
  assert.equal(packet.failure_pattern, undefined);

  const llm = new MockLlm({ scenarios: defaultScenarios() });
  const reply = await llm.complete({
    model: 'mock/elevation',
    messages: [{ role: 'user', content: JSON.stringify(packet) }],
  });

  // The mock records what the orchestrator ASKED FOR (K.4).
  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0].scenario, 'elevation');

  const parsed = parseElevationResponse(reply.text);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  assert.equal(parsed.value.disposition, 'replan');
  assert.equal(parsed.value.root_cause, 'task boundary too wide');
  assert.equal(parsed.value.mis_decomposition, true);
  assert.equal(parsed.value.architecture_issue, false);
  assert.deepEqual(parsed.value.corrective_plan, [{ action: 'split-task', id: 'API-001' }]);
});

test('loop-escalation: NEGATIVE CONTROL — malformed elevation responses are rejected', async () => {
  const { parseElevationResponse } = await core.loop();
  const bad = parseElevationResponse('{"disposition":"nope"}');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /ELEVATION_MALFORMED/);
  assert.equal(parseElevationResponse('not json').ok, false);
  assert.equal(parseElevationResponse(null).ok, false);
});
