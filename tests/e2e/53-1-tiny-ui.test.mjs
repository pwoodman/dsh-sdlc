/**
 * tests/e2e/53-1-tiny-ui.test.mjs — §53 Test 1, Tiny UI change (spec v3 K.8, D.1).
 *
 * "Change the submit button colour" must verify VISUALLY, not through an
 * end-to-end suite: B.1 Tiny band + B.8 rule 6 (trivial → CHEAP) + B.4
 * appearance-only refinement + the B.4 team-composition rule.
 *
 * Runtime evidence asserted: `tasks.state`, `model_tier`, `test_results`
 * (visual ran; integration/e2e did not), the gate log on disk, `events`, and
 * the real `sdlc/integration` git history.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M, createHarness, addTasks, schedule, stageTaskWork, runAttempt, mergeAcceptedTask,
  makeMock, modelDecision, activeRoles, unnecessaryRoles, gatewayEvidence,
} from './harness.mjs';
import { git } from '../lib/helpers.mjs';

const { risk, complexity, verifier } = M;

const VISUAL_CMD = { visual: { command: ['visual-qc', '--viewport', '1440x900'], kind: 'playwright' } };

test('§53 Test 1: tiny appearance-only UI change rides CHEAP and verifies visually', async () => {
  const h = await createHarness({ gateCommands: VISUAL_CMD });
  try {
    const mock = makeMock();
    // The planner decision a real Lead would make (structured, not prose).
    const plan = modelDecision(mock, 'mock/plan-trivial');
    const planned = plan.tasks[0];
    assert.equal(planned.task_class, 'trivial');

    // B.1: the complexity estimate is in the Tiny band.
    const est = { domains: 1, files: 1, integrations: 0, db: false, sec: false, ui: true, external_deps: 0, dep: false, testing: 0 };
    const { score, band } = complexity.computeComplexity(est);
    assert.equal(band, 'Tiny', `expected Tiny band, got ${band} (score ${score})`);
    assert.ok(score < 0.25);

    // The appearance-only classifier is true for the CSS change.
    const cssFiles = ['src/app.css'];
    assert.equal(risk.isAppearanceOnly(cssFiles), true);

    // B.4 appearance-only refinement: visual replaces integration/e2e.
    const gates = risk.requiredGates('R3', {
      uiChange: true, appearanceOnly: true, gateCommands: h.gateCommands,
    }).map((g) => g.gate);
    assert.ok(gates.includes('visual'), 'visual gate required');
    assert.ok(!gates.includes('e2e'), 'a colour change must not run an e2e suite');
    assert.ok(!gates.includes('integration'), 'integration replaced by the visual gate');

    // B.8 rule 6: trivial + attempt 0 → CHEAP (the runtime's own router).
    const decision = h.runtime.router.route({ task: planned });
    assert.equal(decision.tier, 'cheap');
    assert.equal(decision.rule, 6);

    // Persist the DAG and the planner's tier decision (runtime evidence).
    addTasks(h, [{ ...planned, allowed_paths: ['src/**', 'tests/visual/**'] }]);
    h.runtime.db.prepare('UPDATE tasks SET model_tier = ? WHERE id = ?').run(decision.tier, planned.id);

    const applied = schedule(h);
    assert.deepEqual(applied.map((a) => `${a.taskId}:${a.from}→${a.to}`), ['UI-001:BACKLOG→READY', 'UI-001:READY→ASSIGNED']);

    // The appearance-only diff ALSO refreshes the visual baseline, which is the
    // test evidence the §24 behavioural rule asks for. Both files classify as
    // appearance (css + png) with no logic/routing/state change.
    const work = stageTaskWork(h, {
      taskId: planned.id,
      files: {
        'src/app.css': '.btn { color: green; }\n',
        'tests/visual/baseline/button-1440x900.png': 'PNG-PLACEHOLDER\n',
      },
    });
    assert.equal(risk.isAppearanceOnly(work.filesChanged), true, `not appearance-only: ${work.filesChanged}`);

    const review = modelDecision(mock, 'mock/review-accept');
    const attempt = runAttempt(h, {
      taskId: planned.id,
      filesChanged: work.filesChanged,
      review,
      gateList: gates,
      branch: work.branch,
    });
    assert.equal(attempt.decision.accept, true, JSON.stringify(attempt.decision));
    assert.equal(h.runtime.getTask(planned.id).state, 'ACCEPTED');

    const merge = mergeAcceptedTask(h, { taskId: planned.id, branch: work.branch });
    const task = h.runtime.getTask(planned.id);
    assert.equal(task.state, 'DONE');
    assert.equal(task.model_tier, 'cheap');

    // ── runtime evidence: git history ──────────────────────────────────────
    const log = git(['log', '--format=%s', 'sdlc/integration'], h.repo).split('\n');
    assert.ok(log.some((m) => m.startsWith('sdlc: accept UI-001')), `merge commit missing: ${log}`);
    assert.equal(merge.message, 'sdlc: accept UI-001 (Change submit button colour)');
    const changed = git(['diff', '--name-only', 'main', 'sdlc/integration'], h.repo).split('\n').filter(Boolean);
    assert.ok(changed.every((f) => /\.(css|scss|less|png|jpe?g|svg)$/i.test(f)), `unexpected files: ${changed}`);

    // ── runtime evidence: test_results + gate logs on disk ─────────────────
    const evidence = gatewayEvidence(h, planned.id);
    const byGate = Object.fromEntries(evidence.map((r) => [r.gate, r.status]));
    assert.equal(byGate.visual, 'pass');
    assert.equal(byGate.integration, undefined, 'integration gate must not have run');
    assert.equal(byGate.e2e, undefined, 'e2e gate must not have run');
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(`${h.verificationDir}/UI-001/visual.log`), 'visual gate log is the artifact of record');

    // ── runtime evidence: events ───────────────────────────────────────────
    const events = h.runtime.getEvents({ taskId: planned.id });
    assert.ok(events.some((e) => e.action === 'IN_PROGRESS→VERIFYING'));
    assert.ok(events.some((e) => e.action === 'VERIFYING→ACCEPTED'));

    // ── B.4 team composition: no unnecessary agents ────────────────────────
    const tasks = h.runtime.listTasks({ projectId: h.projectId });
    assert.equal(M.presets.ROLES.length, 26, 'the 26-role registry is authoritative');
    assert.deepEqual(activeRoles(tasks), ['frontend-engineer', 'lead']);
    assert.equal(unnecessaryRoles(tasks).length, 24, 'no role without a task may be instantiated');
    assert.ok(tasks.every((t) => t.role && activeRoles(tasks).includes(t.role)));
  } finally {
    h.close();
  }
});

/**
 * SPEC CONFLICT (implementation NOT modified, reported):
 * B.4's §24 behavioural-test rule and G.4's §53 Test 1 pull in opposite
 * directions for a *bare* CSS-only diff. `risk.violatesBehavioralTestRule`
 * treats `.css` as production code, so a button-colour change with no test
 * file change is auto-rejected `NO_TEST_EVIDENCE` — while G.4 asserts the
 * Test 1 diff files are all `.css`. The implementation follows §24; Test 1
 * above therefore also refreshes the visual baseline (a test-owned PNG under
 * `tests/`, which classifies as appearance AND as test evidence). This test
 * pins the §24 policy so the conflict cannot regress silently.
 */
test('§53 Test 1: the §24 behavioural rule does NOT reject an appearance-only diff (F1 fixed)', () => {
  // Originally a spec conflict: .css was classified as production code, so a
  // colour-only diff was rejected with NO_TEST_EVIDENCE while G.4 asserts
  // Test 1's diff is all .css. B.4's appearance-vs-behaviour refinement now
  // wins: an appearance-only diff verifies VISUALLY.
  assert.equal(risk.isAppearanceOnly(['src/app.css']), true);
  assert.equal(risk.violatesBehavioralTestRule(['src/app.css']), false);
  assert.equal(risk.violatesBehavioralTestRule(['src/app.css', 'tests/visual/baseline/button-1440x900.png']), false);
  // Logic changes are still guarded.
  assert.equal(risk.violatesBehavioralTestRule(['src/app.ts']), true);

  const required = risk.requiredGates('R3', { uiChange: true, appearanceOnly: true })
    .filter((g) => g.required).map((g) => g.gate);
  const decision = verifier.decideAcceptance({
    riskClass: 'R3',
    requiredGates: required,
    gateResults: { syntax: { status: 'pass' }, lint: { status: 'pass' }, unit: { status: 'pass' }, visual: { status: 'pass' } },
    filesChanged: ['src/app.css'],
    review: { verdict: 'accept' },
    claims: { status: 'completed' },
    runtimeStatus: 'completed',
  });
  assert.equal(decision.accept, true, 'a verified appearance-only change is accepted');
});
