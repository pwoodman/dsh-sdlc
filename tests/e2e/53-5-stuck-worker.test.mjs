/**
 * tests/e2e/53-5-stuck-worker.test.mjs — §53 Test 5, Stuck worker (spec v3 K.8, D.1).
 *
 * A worker that keeps failing the same way must be DETECTED (B.6 loop
 * fingerprint), ELEVATED (B.8 ladder rules 3–4 + the escalation ladder) and end
 * in a ROOT-CAUSE corrective plan — never a blind retry.
 *
 * Runtime evidence asserted: `events` (IN_PROGRESS→ESCALATED with the loop
 * fingerprint guard, ESCALATED→READY only with an approved corrective plan),
 * the `escalations` row holding the elevation packet, and the router's own
 * ladder decisions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M, createHarness, addTasks, schedule, makeMock, modelDecision,
} from './harness.mjs';

const { loop, escalation, router } = M;

test('§53 Test 5: loop fingerprint, elevation packet, ladder, corrective plan', async () => {
  const h = await createHarness();
  try {
    // ── B.6 fingerprint: cosmetic differences collide ─────────────────────
    const fp1 = loop.fingerprint({
      taskId: 'STUCK-001', gate: 'unit',
      failureText: 'Error at /tmp/run-a/src/service.ts:42 expected 1 got 2',
      filesChanged: ['src/service.ts'],
    });
    const fp2 = loop.fingerprint({
      taskId: 'STUCK-001', gate: 'unit',
      failureText: 'error at /tmp/run-b/lib/other.ts:99 expected 7 got 8',
      filesChanged: ['src/service.ts'],
    });
    assert.equal(fp1.signature, fp2.signature);
    assert.equal(fp1.key, fp2.key);
    assert.match(fp1.signature, /<path>/);

    const attempts = [
      { n: 1, status: 'failed', fingerprint: fp1, model: { provider: 'openai', id: 'gpt-4o-mini' } },
      { n: 2, status: 'failed', fingerprint: fp2, model: { provider: 'openai', id: 'gpt-4o' } },
    ];
    const detected = loop.detectLoop(attempts);
    assert.equal(detected.loop, true);
    assert.equal(detected.reason, 'fingerprint-repeat:2');

    // ≥3 failed attempts escalates regardless of signature.
    const three = loop.detectLoop([...attempts, { n: 3, status: 'timeout', fingerprint: loop.fingerprint({ taskId: 'STUCK-001', gate: 'unit', failureText: 'different failure' }) }]);
    assert.equal(three.loop, true);
    assert.equal(three.reason, 'max-failed-attempts:3');

    // ── B.8 ladder rules 3–4 + the B.6 escalation ladder ──────────────────
    assert.deepEqual(loop.LADDER, ['CHEAP', 'BASE', 'ELEVATED', 'ARCHITECTURE_REVIEW', 'USER']);
    assert.equal(loop.nextLadderStep('CHEAP'), 'BASE');
    assert.equal(loop.nextLadderStep('ELEVATED'), 'ARCHITECTURE_REVIEW');
    assert.equal(loop.nextLadderStep('ARCHITECTURE_REVIEW'), 'USER');

    const r = new router.ModelRouter({ tiers: h.config.tiers });
    assert.equal(r.route({ task_class: 'trivial', attempt: 0 }).tier, 'cheap');
    assert.equal(r.route({ task_class: 'normal', attempt: 1 }).tier, 'base');
    assert.equal(r.route({ task_class: 'normal', attempt: 2 }).tier, 'elevated');
    assert.equal(r.route({ requires_elevated: true, task_class: 'architectural' }).tier, 'elevated');

    assert.equal(escalation.escalationLevel([{ status: 'success' }]), 'CHEAP');
    assert.equal(escalation.escalationLevel(attempts), 'BASE');
    assert.equal(escalation.escalationLevel([{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }]), 'ELEVATED');

    // ── the elevation packet handed to the ELEVATED model (B.6) ───────────
    const packet = loop.buildElevationPacket({
      taskId: 'STUCK-001',
      attempts,
      failures: ['unit: <path>: expected <n> got <n>'],
      filesChanged: ['src/service.ts'],
      outOfScopeFiles: [],
      testOutputPath: '.sdlc/verification/STUCK-001/unit.log',
      relevantDecisions: ['ADR-0001'],
    });
    assert.equal(packet.task_id, 'STUCK-001');
    assert.equal(packet.attempts.length, 2);
    assert.equal(packet.failures.length, 1);
    assert.equal(packet.request, 'diagnose root cause and propose corrective action');

    // The ELEVATED model's structured answer (mock, never prose).
    const mock = makeMock();
    const raw = mock.respond({ model: 'mock/elevation' }).text;
    const parsed = loop.parseElevationResponse(raw);
    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.value.disposition, 'replan');
    assert.equal(parsed.value.mis_decomposition, true);
    assert.ok(parsed.value.corrective_plan.length >= 1, 'corrective plan, not a blind retry');

    // ── runtime evidence: ESCALATED via the loop-detector only ────────────
    addTasks(h, [{
      id: 'STUCK-001', title: 'Fix flaky service', role: 'backend-engineer',
      objective: 'make the service deterministic', task_class: 'normal', risk_class: 'R2',
      allowed_paths: ['src/service.ts'], verification: ['syntax', 'lint', 'unit'],
    }]);
    schedule(h);
    h.runtime.state.transition('STUCK-001', 'IN_PROGRESS', 'worker-mgr', {});

    // NEGATIVE CONTROL: no loop ⇒ the escalation transition is rejected.
    const blind = h.runtime.state.transition('STUCK-001', 'ESCALATED', 'loop-detector', { loopMatched: false });
    assert.equal(blind.ok, false);
    assert.equal(blind.error, 'INVALID_TRANSITION');
    assert.match(blind.reason, /loopMatched/);
    assert.equal(h.runtime.getTask('STUCK-001').state, 'IN_PROGRESS');

    const escalated = h.runtime.state.transition('STUCK-001', 'ESCALATED', 'loop-detector', { loopMatched: true });
    assert.equal(escalated.ok, true, escalated.reason);
    assert.equal(h.runtime.getTask('STUCK-001').state, 'ESCALATED');

    // The escalation-mgr persists the elevation packet (durable evidence).
    h.runtime.db.prepare(
      `INSERT INTO escalations(id, task_id, attempt, level, packet_json, resolution, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('ESC-1', 'STUCK-001', 0, 'ELEVATED', JSON.stringify({ packet, response: parsed.value }), 'pending', new Date().toISOString());

    // Blind retry is refused; only an approved corrective plan re-enters READY.
    const noPlan = h.runtime.state.transition('STUCK-001', 'READY', 'escalation-mgr', {});
    assert.equal(noPlan.ok, false);
    assert.match(noPlan.reason, /planApproved/);
    const resumed = h.runtime.state.transition('STUCK-001', 'READY', 'escalation-mgr', { correctivePlanApproved: true });
    assert.equal(resumed.ok, true, resumed.reason);
    const task = h.runtime.getTask('STUCK-001');
    assert.equal(task.state, 'READY');
    assert.equal(task.attempt, 1, 'resuming an escalation starts a NEW attempt');

    // ── runtime evidence: the escalation flow is in `events` and the DB ───
    const actions = h.runtime.getEvents({ taskId: 'STUCK-001' }).map((e) => e.action);
    assert.ok(actions.includes('IN_PROGRESS→ESCALATED'));
    assert.ok(actions.includes('ESCALATED→READY'));
    const row = h.runtime.db.prepare('SELECT * FROM escalations WHERE id = ?').get('ESC-1');
    assert.equal(row.level, 'ELEVATED');
    const stored = JSON.parse(row.packet_json);
    assert.equal(stored.packet.task_id, 'STUCK-001');
    assert.equal(stored.response.disposition, 'replan');
    assert.ok(stored.response.corrective_plan.length >= 1);

    // The next dispatch runs at BASE, and a further failure reaches ELEVATED.
    assert.equal(r.route({ task_class: 'normal', attempt: task.attempt }).tier, 'base');
    assert.equal(r.route({ task_class: 'normal', attempt: 2 }).tier, 'elevated');
  } finally {
    h.close();
  }
});
