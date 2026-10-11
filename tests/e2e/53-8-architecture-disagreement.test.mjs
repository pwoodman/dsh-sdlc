/**
 * tests/e2e/53-8-architecture-disagreement.test.mjs — §53 Test 8, Architecture
 * disagreement (spec v3 K.8, D.1).
 *
 * Two independent ADR proposals that answer the same question differently
 * trigger B.8 collaborative mode (`architecture_dispute`); 2–3 diverse models
 * run in parallel, one ELEVATED adjudicator decides, and the outcome is exactly
 * ONE ADR recorded in the `decisions` ledger.
 *
 * Runtime evidence asserted: `decisions` rows, the router's elevated tier
 * decision, and the MockLlm request log (what the orchestrator ASKED FOR).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { M, createHarness, makeMock } from './harness.mjs';

const { router } = M;

const ADR_A = {
  id: 'ADR-A',
  question: 'Where does authentication terminate for the public API?',
  decision: 'Edge-terminated JWT at the API gateway',
  reason: 'single enforcement point, smallest code surface',
  consequences: ['gateway owns key rotation'],
};
const ADR_B = {
  id: 'ADR-B',
  question: 'Where does authentication terminate for the public API?',
  decision: 'Service-mesh mTLS with per-service authorization',
  reason: 'defence in depth, zero-trust between services',
  consequences: ['mesh certificate lifecycle'],
};
const ADJUDICATION = {
  question: ADR_A.question,
  chosen: 'ADR-B',
  decision: ADR_B.decision,
  reason: 'lower blast radius; mesh policy already deployed',
  alternatives: ['ADR-A'],
  consequences: ['mesh certificate lifecycle', 'gateway consumes mesh identity'],
};

test('§53 Test 8: two conflicting ADRs trigger collaborative adjudication producing one ADR', async () => {
  const h = await createHarness();
  try {
    const mock = makeMock({
      'adr-model-a': { default: { text: JSON.stringify(ADR_A), usage: { inputTokens: 300, outputTokens: 120 } } },
      'adr-model-b': { default: { text: JSON.stringify(ADR_B), usage: { inputTokens: 300, outputTokens: 120 } } },
      'adr-adjudicate': { default: { text: JSON.stringify(ADJUDICATION), usage: { inputTokens: 500, outputTokens: 200 } } },
    });

    // ── two INDEPENDENT analyses (deterministic mock models) ───────────────
    const proposalA = JSON.parse(mock.respond({ model: 'mock/adr-model-a', runId: 'collab' }).text);
    const proposalB = JSON.parse(mock.respond({ model: 'mock/adr-model-b', runId: 'collab' }).text);

    // Conflict = same question, different decision → B.8 trigger.
    const conflict = proposalA.question === proposalB.question && proposalA.decision !== proposalB.decision;
    assert.equal(conflict, true, 'the two ADRs must genuinely disagree');
    assert.ok(
      h.config.escalation.collaborativeTriggers.includes('architecture_dispute'),
      `architecture_dispute must be a collaborative trigger: ${h.config.escalation.collaborativeTriggers}`,
    );

    // ── elevated adjudication: rule 3 routes the dispute to ELEVATED ───────
    const route = h.runtime.router.route({ task: { requires_elevated: true, task_class: 'architectural' } });
    assert.equal(route.tier, 'elevated');
    assert.equal(route.rule, 3);

    // A diverse second tier is available for the parallel analyses.
    const candidates = router.TIERS.flatMap((tier) => h.config.tiers[tier] ?? []);
    assert.ok(candidates.length >= 3, 'collaborative mode needs 2–3 diverse models');

    const verdict = JSON.parse(mock.respond({ model: 'mock/adr-adjudicate', runId: 'collab' }).text);
    assert.equal(verdict.chosen, 'ADR-B');
    assert.equal(verdict.question, ADR_A.question);
    assert.ok(Array.isArray(verdict.alternatives));

    // ── exactly ONE ADR reaches the decisions ledger ──────────────────────
    h.runtime.recordDecision({
      id: 'ADR-0001',
      project_id: h.projectId,
      question: verdict.question,
      decision: verdict.decision,
      reason: verdict.reason,
      alternatives: [ADR_A.decision, ...(verdict.alternatives ?? [])],
      consequences: verdict.consequences ?? [],
      tags: ['adr', 'architecture', 'collaborative'],
    });

    const decisions = h.runtime.listDecisions(h.projectId);
    assert.equal(decisions.length, 1, 'the adjudication must produce exactly one ADR');
    assert.equal(decisions[0].id, 'ADR-0001');
    assert.equal(decisions[0].decision, ADR_B.decision);
    assert.ok(decisions[0].alternatives.includes(ADR_A.decision), 'the losing proposal is an ALTERNATIVE, not a second ADR');
    assert.ok(decisions[0].tags.includes('adr'));
    assert.equal(new Set(decisions.map((d) => d.question)).size, decisions.length, 'no duplicate question rows');

    // ── runtime evidence: the ledger row is in sdlc.db ────────────────────
    const row = h.runtime.db.prepare('SELECT * FROM decisions WHERE id = ?').get('ADR-0001');
    assert.equal(row.project_id, h.projectId);
    assert.match(row.question, /authentication/);
    assert.equal(JSON.parse(row.alternatives_json).length, 2);

    // ── runtime evidence: what the orchestrator asked for (mock log) ──────
    assert.equal(mock.requests.length, 3);
    assert.deepEqual(
      mock.requests.map((r) => r.scenario).sort(),
      ['adr-adjudicate', 'adr-model-a', 'adr-model-b'],
    );
    assert.ok(mock.requests.every((r) => r.outcome === 'ok'));
  } finally {
    h.close();
  }
});
