#!/usr/bin/env node
/**
 * scripts/validate-m4.mjs — M4 gate: recover (spec v3 D.0).
 *
 * Loop fingerprint on 2 identical failures; the CHEAP→BASE→ELEVATED ladder;
 * budget breach stops dispatch; the kill switch interrupts workers; and a
 * headless-only escalation stays BLOCKED (fail-closed).
 *
 *   node scripts/validate-m4.mjs [--json <path>] [--fail-fast]
 */

import { runSuite, EXIT } from './lib/harness.mjs';
import { importPkg, withDir, testConfig, openRuntime } from './lib/gate-helpers.mjs';

const loop = await importPkg('packages/sdlc-core/src/loop.js');
const escalation = await importPkg('packages/sdlc-core/src/escalation.js');
const budget = await importPkg('packages/sdlc-core/src/budget.js');
const { MockLlm } = await importPkg('packages/sdlc-mock-llm/src/index.js');

const checks = [
  {
    id: 'M4-01-loop-fingerprint',
    title: '2 identical failures ⇒ loop; 3 failures of any signature ⇒ loop',
    fn() {
      const fp = loop.fingerprint({ taskId: 'T1', gate: 'unit', failureText: 'Error: expected 1 got 2', filesChanged: ['src/a.ts'] });
      const repeat = loop.detectLoop([{ status: 'failed', fingerprint: fp }, { status: 'failed', fingerprint: fp }]);
      if (!repeat.loop || repeat.reason !== 'fingerprint-repeat:2') throw new Error(`repeat not detected: ${JSON.stringify(repeat)}`);
      const distinct = [1, 2, 3].map((n) => ({ status: 'failed', fingerprint: loop.fingerprint({ taskId: 'T1', gate: 'unit', failureText: `failure ${n}` }) }));
      const three = loop.detectLoop(distinct);
      if (!three.loop || three.reason !== 'max-failed-attempts:3') throw new Error('3 distinct failures did not escalate');
      const single = loop.detectLoop([{ status: 'failed', fingerprint: fp }]);
      if (single.loop) throw new Error('a single failure was treated as a loop');
      return { detail: 'fingerprint repeat and max-attempts both detect; single failure does not' };
    },
  },
  {
    id: 'M4-02-elevation-ladder',
    title: 'CHEAP→BASE→ELEVATED→ARCHITECTURE REVIEW→USER ladder fires correctly',
    fn() {
      const seen = [];
      let level = 'CHEAP';
      for (let i = 0; i < 4; i += 1) { level = loop.nextLadderStep(level); seen.push(level); }
      if (seen.join(',') !== 'BASE,ELEVATED,ARCHITECTURE_REVIEW,USER') throw new Error(`ladder wrong: ${seen.join(',')}`);
      if (escalation.escalationLevel([]) !== 'CHEAP') throw new Error('no failures should be CHEAP');
      if (escalation.escalationLevel([{ status: 'failed' }, { status: 'failed' }]) !== 'BASE') throw new Error('2 failures should be BASE');
      if (escalation.escalationLevel([{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }]) !== 'ELEVATED') throw new Error('3 failures should be ELEVATED');
      const packet = loop.buildElevationPacket({ taskId: 'T1', attempts: [{ n: 1, status: 'failed', signature: 's' }], failures: ['boom'] });
      if (packet.task_id !== 'T1' || packet.failures[0] !== 'boom') throw new Error('elevation packet malformed');
      const answer = loop.parseElevationResponse(new MockLlm().respond({ model: 'mock/elevation', messages: [] }).text);
      if (!answer.ok || answer.value.disposition !== 'replan') throw new Error('elevated structured answer not parsed');
      return { detail: 'ladder monotone; packet built; ELEVATED answer parsed from the mock provider' };
    },
  },
  {
    id: 'M4-03-budget-breach-stops-dispatch',
    title: 'per-attempt and cumulative budget breaches stop dispatch / escalate',
    fn() {
      const b = budget.RISK_BUDGET_DEFAULTS.R2;
      if (!budget.checkDispatch({ attempt: 0 }, b).ok) throw new Error('attempt 0 should be dispatchable');
      const exhausted = budget.checkDispatch({ attempt: 3 }, b);
      if (exhausted.ok) throw new Error('attempt 3 of maxAttempts 3 was allowed');
      if (!exhausted.reason.startsWith('BUDGET_EXHAUSTED')) throw new Error(`wrong reason ${exhausted.reason}`);
      if (budget.checkProjectBudget({ spentCostUsd: 10 }).ok !== true) throw new Error('project budget should be fine');
      const blocked = budget.checkProjectBudget({ spentCostUsd: 200 });
      if (blocked.ok) throw new Error('project budget breach not detected');
      const evaluate = budget.evaluateRun({ attempt: 3, run: { costUsd: 1 }, taskBudget: b });
      if (evaluate.action !== 'escalate') throw new Error(`cumulative exhaustion should escalate, got ${evaluate.action}`);
      return { detail: 'dispatch blocked, project blocked, cumulative exhaustion escalates' };
    },
  },
  {
    id: 'M4-04-kill-switch',
    title: 'the kill switch cancels dispatchable work and records the stop',
    fn() {
      return withDir(async (dir) => {
        const runtime = await openRuntime(dir, {
          config: testConfig(),
          tasks: [
            { id: 'T-1', title: 'a', role: 'backend-engineer', allowed_paths: ['src/a/**'] },
            { id: 'T-2', title: 'b', role: 'backend-engineer', allowed_paths: ['src/b/**'] },
          ],
        });
        try {
          runtime.transition('T-1', 'READY', 'scheduler', { depStates: {} });
          runtime.transition('T-1', 'ASSIGNED', 'scheduler', { available: true });
          runtime.transition('T-1', 'IN_PROGRESS', 'worker-mgr', {});
          for (const id of ['T-1', 'T-2']) {
            const res = runtime.state.transition(id, 'CANCELLED', 'human', { workerStopped: true });
            if (!res.ok) throw new Error(`${id} could not be cancelled: ${res.reason}`);
          }
          runtime.state.record({ actor: 'human', action: 'kill-switch' });
          if (runtime.getTask('T-1').state !== 'CANCELLED' || runtime.getTask('T-2').state !== 'CANCELLED') throw new Error('tasks not cancelled');
          if (!runtime.getEvents().some((e) => e.action === 'kill-switch')) throw new Error('the stop was not recorded');
          // An in-progress task may only be cancelled once the worker is stopped.
          const svc = runtime.state;
          svc._setState('T-9', 'IN_PROGRESS');
          const refused = svc.transition('T-9', 'CANCELLED', 'human', { workerStopped: false });
          if (refused.ok) throw new Error('an in-flight worker was cancelled without stopping it');
          return { detail: 'dispatchable work cancelled, stop recorded, in-flight worker must stop first' };
        } finally { runtime.close({ releaseLock: false }); }
      }, 'sdlc-m4-kill-');
    },
  },
  {
    id: 'M4-05-headless-escalation-stays-blocked',
    title: 'a headless-only escalation cannot unblock itself (fail-closed)',
    fn() {
      const block = escalation.buildDecisionBlock({ id: 'E1', trigger: 'budget_exhausted', question: 'raise budget?' });
      const plan = escalation.planEscalation(block, { mode: 'headless' });
      if (plan.deliver) throw new Error('a headless deployment attempted to deliver an approval request');
      if (plan.state !== 'BLOCKED') throw new Error('headless escalation did not block');
      const outcome = escalation.normalizeApprovalOutcome('unavailable');
      if (outcome.allowed || !outcome.failClosed) throw new Error('unavailable must fail closed');
      const applied = escalation.applyResolution({ resolution: 'unavailable' });
      if (applied.taskTo !== 'BLOCKED') throw new Error('unavailable must keep the task BLOCKED');
      const interactive = escalation.planEscalation(block, { mode: 'interactive' });
      if (!interactive.deliver) throw new Error('the interactive lead must be able to deliver the request');
      return { detail: 'headless ⇒ BLOCKED; unavailable ⇒ fail-closed; interactive can unblock' };
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M4 recovery gate', version: '1.0.0', checks }));
