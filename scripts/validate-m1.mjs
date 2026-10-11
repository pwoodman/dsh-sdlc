#!/usr/bin/env node
/**
 * scripts/validate-m1.mjs — M1 gate: plan (spec v3 D.0, C.8.1 style).
 *
 * Validates, with NO model call and NO network:
 *   - complexity engine determinism (same input ⇒ same score across runs)
 *   - the task DAG is persisted to sdlc.db with dependencies and resources
 *   - every state transition matches the B.2.1 matrix (legal accepted, illegal rejected)
 *   - `events` are append-only (negative control)
 *   - the mock-LLM predicate pipeline runs end to end, deterministically
 *
 *   node scripts/validate-m1.mjs [--json <path>] [--fail-fast]
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSuite, withTempDir, EXIT } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const P = (rel) => join(ROOT, rel);
const importFrom = (rel) => import(`file://${P(rel)}`);

const { computeComplexity } = await importFrom('packages/sdlc-core/src/complexity/index.js');
const sm = await importFrom('packages/sdlc-core/src/state-machine.js');
const { Runtime } = await importFrom('packages/sdlc-core/src/runtime.js');
const { documentedTransitions } = await import(`file://${P('tests/lib/transition-fixtures.mjs')}`);
const { MockLlm } = await importFrom('packages/sdlc-mock-llm/src/index.js');
const { normalizeEvents, eventStreamKey } = await importFrom('tests/lib/normalize-events.mjs');

const ESTIMATE = { domains: 3, files: 12, integrations: 1, db: true, sec: false, ui: true, external_deps: 2, dep: false, testing: 0.5 };

function projectConfig() {
  return {
    storage: { dbPath: '.sdlc/sdlc.db', requireQuickCheckOnOpen: true },
    safety: { instanceLock: false },
    budgets: {},
    tiers: {}, pricing: {},
  };
}

function seedRuntime(dir) {
  const runtime = new Runtime({ projectRoot: dir, config: projectConfig(), useLock: false });
  runtime.open();
  runtime.createProject({ id: 'P1', name: 'm1', complexity: computeComplexity(ESTIMATE) });
  runtime.addTask({
    id: 'DB-001', project_id: 'P1', title: 'add table', role: 'database-engineer',
    allowed_paths: ['src/db/**'], resources: ['package.json'],
    acceptance_criteria: [{ id: 'AC1', statement: 'table exists', check: 'integration:X' }],
  });
  runtime.addTask({
    id: 'API-001', project_id: 'P1', title: 'add endpoint', role: 'api-engineer',
    depends_on: ['DB-001'], allowed_paths: ['src/api/**'], resources: ['package.json'],
    acceptance_criteria: [{ id: 'AC1', statement: 'list returned', check: 'api:Y' }],
  });
  return runtime;
}

const checks = [
  {
    id: 'M1-01-complexity-determinism',
    title: 'complexity engine: same input ⇒ same score over 100 runs',
    fn() {
      const scores = new Set();
      for (let i = 0; i < 100; i += 1) scores.add(computeComplexity(ESTIMATE).score);
      if (scores.size !== 1) throw new Error(`expected 1 distinct score, got ${scores.size}`);
      const { score, band } = computeComplexity(ESTIMATE);
      if (!(score >= 0 && score <= 1)) throw new Error(`score out of range: ${score}`);
      return { detail: `score=${score.toFixed(4)} band=${band}` };
    },
  },
  {
    id: 'M1-02-dag-persisted',
    title: 'task DAG (deps + resources) persists to sdlc.db',
    fn() {
      return withTempDir('sdlc-m1-dag-', (dir) => {
        const runtime = seedRuntime(dir);
        try {
          const api = runtime.getTask('API-001');
          if (!api) throw new Error('task not persisted');
          if (JSON.stringify(api.depends_on) !== JSON.stringify(['DB-001'])) throw new Error(`deps wrong: ${JSON.stringify(api.depends_on)}`);
          if (!api.resources.includes('package.json')) throw new Error('resources wrong');
          const rows = runtime.db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get().n;
          if (rows !== 1) throw new Error(`expected 1 dependency row, got ${rows}`);
          const listed = runtime.listTasks({ projectId: 'P1' });
          if (listed.length !== 2) throw new Error(`expected 2 tasks, got ${listed.length}`);
          return { detail: '2 tasks, 1 dependency, resources persisted' };
        } finally { runtime.close({ releaseLock: false }); }
      });
    },
  },
  {
    id: 'M1-03-transition-matrix',
    title: 'state transitions match the B.2.1 matrix exactly',
    fn() {
      const { legal, illegal } = documentedTransitions();
      for (const [from, to, actor, ctx] of legal) {
        const svc = new sm.TaskStateService(':memory:');
        if (from !== null) svc._setState('T1', from);
        const res = svc.transition('T1', to, actor, ctx);
        if (!res.ok) throw new Error(`legal ${from}→${to} (${actor}) rejected: ${res.reason}`);
        if (svc.getState('T1') !== to) throw new Error(`state not applied for ${from}→${to}`);
      }
      for (const [from, to, actor] of illegal) {
        const svc = new sm.TaskStateService(':memory:');
        if (from !== null) svc._setState('T1', from);
        const res = svc.transition('T1', to, actor, { available: true, gatesPass: true, merged: true });
        if (res.ok) throw new Error(`illegal ${from}→${to} (${actor}) was accepted`);
        if (res.error !== 'INVALID_TRANSITION') throw new Error(`wrong error for ${from}→${to}: ${res.error}`);
        if (from !== null && svc.getState('T1') !== from) throw new Error('state changed on rejection');
      }
      // Exhaustive cross-check of every (from, to, actor) cell.
      let cells = 0;
      for (const from of sm.TASK_STATES) {
        for (const to of sm.TASK_STATES) {
          for (const actor of ['planner', 'scheduler', 'worker-mgr', 'verifier', 'integration-mgr', 'loop-detector', 'escalation-mgr', 'human', 'recovery']) {
            const legalByMatrix = sm.findTransition(from, to, actor) !== null;
            const byApi = sm.isLegalTransition(from, to, actor);
            if (legalByMatrix !== byApi) throw new Error('isLegalTransition disagrees with findTransition');
            cells += 1;
          }
        }
      }
      return { detail: `${legal.length} legal + ${illegal.length} illegal rows verified; ${cells} matrix cells consistent` };
    },
  },
  {
    id: 'M1-04-events-append-only',
    title: 'events are append-only (negative control)',
    fn() {
      return withTempDir('sdlc-m1-events-', (dir) => {
        const runtime = seedRuntime(dir);
        try {
          runtime.transition('DB-001', 'READY', 'scheduler', { depStates: {} });
          let deleted = false;
          try { runtime.db.prepare('DELETE FROM events').run(); deleted = true; } catch { /* expected */ }
          if (deleted) throw new Error('DELETE FROM events was allowed');
          let updated = false;
          try { runtime.db.prepare("UPDATE events SET actor='x'").run(); updated = true; } catch { /* expected */ }
          if (updated) throw new Error('UPDATE events was allowed');
          const events = runtime.getEvents({ taskId: 'DB-001' });
          if (!events.some((e) => e.action === 'BACKLOG→READY')) throw new Error('the transition event was not written');
          const applyCount = events.filter((e) => e.action.includes('→')).length;
          if (applyCount !== 1) throw new Error(`expected exactly 1 transition event, got ${applyCount}`);
          return { detail: `UPDATE and DELETE both rejected; ${events.length} audit rows for DB-001` };
        } finally { runtime.close({ releaseLock: false }); }
      });
    },
  },
  {
    id: 'M1-05-mock-pipeline',
    title: 'mock-LLM plan→implement pipeline runs end to end, offline',
    fn() {
      return withTempDir('sdlc-m1-pipeline-', (dir) => {
        const runtime = seedRuntime(dir);
        try {
          const llm = new MockLlm();
          const plan = llm.respond({ model: 'mock/plan-api', messages: [{ role: 'user', content: 'plan' }] });
          const planned = JSON.parse(plan.text);
          if (planned.tasks.length < 2) throw new Error('mock plan produced no DAG');
          const implementation = llm.respond({ model: 'mock/implement', messages: [{ role: 'user', content: 'implement' }] });
          if (!implementation.text.includes('sdlc-result')) throw new Error('mock implement produced no result block');

          // Drive both tasks through the real state machine.
          for (const id of ['DB-001', 'API-001']) {
            runtime.transition(id, 'READY', 'scheduler', { depStates: id === 'API-001' ? { 'DB-001': 'DONE' } : {} });
            runtime.transition(id, 'ASSIGNED', 'scheduler', { available: true });
            runtime.transition(id, 'IN_PROGRESS', 'worker-mgr', {});
            runtime.transition(id, 'VERIFYING', 'worker-mgr', {});
            runtime.transition(id, 'ACCEPTED', 'verifier', { gatesPass: true });
            runtime.transition(id, 'MERGING', 'integration-mgr', { mergeSlotFree: true });
            runtime.transition(id, 'DONE', 'integration-mgr', { merged: true });
          }
          const states = ['DB-001', 'API-001'].map((id) => runtime.getTask(id).state);
          if (states.join(',') !== 'DONE,DONE') throw new Error(`pipeline ended at ${states.join(',')}`);
          return { detail: 'plan → implement → DONE for 2 tasks with the mock provider' };
        } finally { runtime.close({ releaseLock: false }); }
      });
    },
  },
  {
    id: 'M1-06-plan-determinism',
    title: 'K.6: identical state produces a byte-identical normalized event stream',
    fn() {
      const streams = [0, 1].map((i) => withTempDir(`sdlc-m1-det-${i}-`, (dir) => {
        const runtime = seedRuntime(dir);
        try {
          runtime.transition('DB-001', 'READY', 'scheduler', { depStates: {} });
          runtime.transition('DB-001', 'ASSIGNED', 'scheduler', { available: true });
          runtime.transition('DB-001', 'IN_PROGRESS', 'worker-mgr', {});
          return eventStreamKey(normalizeEvents(runtime.getEvents()));
        } finally { runtime.close({ releaseLock: false }); }
      }));
      if (streams[0] !== streams[1]) throw new Error(`event streams diverge:\n${streams[0]}\n---\n${streams[1]}`);
      return { detail: `${streams[0].split('\n').filter(Boolean).length} normalized events identical across two runs` };
    },
  },
  {
    id: 'M1-07-runtime-resume',
    title: 'state survives a close/reopen (durable, not in-memory)',
    fn() {
      return withTempDir('sdlc-m1-resume-', (dir) => {
        const first = seedRuntime(dir);
        first.transition('DB-001', 'READY', 'scheduler', { depStates: {} });
        first.close({ releaseLock: false });
        const second = new Runtime({ projectRoot: dir, config: projectConfig(), useLock: false });
        second.open();
        try {
          if (second.getTask('DB-001').state !== 'READY') throw new Error('state was not durable');
          const events = second.getEvents({ taskId: 'DB-001' });
          if (!events.some((e) => e.action === 'BACKLOG→READY')) throw new Error('events were not durable');
          return { detail: 'READY state and 1 event survived reopen' };
        } finally { second.close({ releaseLock: false }); }
      });
    },
  },
  {
    id: 'M1-08-contract-budget-boundary',
    title: 'a spec-shaped B.3.1 task contract round-trips through addTask/getTask',
    fn() {
      return withTempDir('sdlc-m1-contract-', (dir) => {
        const runtime = new Runtime({ projectRoot: dir, config: projectConfig(), useLock: false });
        runtime.open();
        try {
          runtime.createProject({ id: 'P1', name: 'm1' });
          runtime.addTask({
            id: 'API-042', project_id: 'P1', title: 'endpoint', objective: 'add it',
            role: 'api-engineer', risk_class: 'R2',
            // Snake_case exactly as B.3.1 documents it.
            budgets: { max_attempts: 4, max_duration_ms: 1000, max_cost_usd: 2.5, max_tokens: 123 },
            acceptance_criteria: [{ id: 'AC1', statement: 'works', check: 'api:t' }],
            allowed_paths: ['src/api/**'], forbidden_paths: ['src/auth/**'],
            verification: ['unit', 'api'],
          });
          const task = runtime.getTask('API-042');
          if (task.retry_budget !== 4) throw new Error(`retry_budget=${task.retry_budget}, expected 4 (from max_attempts)`);
          if (task.forbidden_paths[0] !== 'src/auth/**') throw new Error('forbidden_paths lost');
          if (task.acceptance_criteria.length !== 1) throw new Error('acceptance criteria lost');
          let rejected = false;
          try { runtime.addTask({ id: 'X-1', project_id: 'P1', title: 'x', role: 'r', budgets: { wibble: 1 } }); } catch { rejected = true; }
          if (!rejected) throw new Error('an unknown budget key was silently accepted');
          return { detail: 'snake_case budgets, paths and ACs persisted; unknown keys rejected' };
        } finally { runtime.close({ releaseLock: false }); }
      });
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M1 planning gate', version: '1.0.0', checks }));
