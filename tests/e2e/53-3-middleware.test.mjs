/**
 * tests/e2e/53-3-middleware.test.mjs — §53 Test 3, Middleware change (spec v3 K.8, D.1).
 *
 * A middleware change touches requirements, architecture, integration, data,
 * backend, QA, security and DevOps, so the planner's role assignment must cover
 * all of them: C.3 role presets + `rolesForDomains` + B.1 domain classification.
 * "No unnecessary agents" is structural: roles active = distinct task roles ∪
 * {lead}, and a role with zero tasks is never instantiated.
 *
 * Runtime evidence asserted: `tasks.role` rows in `sdlc.db` and the role
 * registry's domain→role mapping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M, createHarness, addTasks, activeRoles, unnecessaryRoles, makeMock, modelDecision,
} from './harness.mjs';

const { presets, complexity } = M;

/** The eight domains §53 Test 3 must cover, each with its owning role. */
const REQUIRED = [
  { domain: 'requirements', role: 'business-analyst', objective: 'capture middleware business rules' },
  { domain: 'architecture', role: 'solution-architect', objective: 'design the middleware architecture' },
  { domain: 'integration', role: 'integration-engineer', objective: 'wire third-party integration retries' },
  { domain: 'data-pipeline', role: 'data-engineer', objective: 'pipeline the audit events' },
  { domain: 'backend', role: 'backend-engineer', objective: 'implement the middleware service logic' },
  { domain: 'testing', role: 'qa-engineer', objective: 'test strategy and acceptance mapping' },
  { domain: 'security', role: 'security-engineer', objective: 'threat analysis and authz review' },
  { domain: 'devops', role: 'devops-engineer', objective: 'CI/CD and deployment safety' },
];

test('§53 Test 3: middleware role assignment covers all eight domains', async () => {
  const h = await createHarness();
  try {
    const allDomains = REQUIRED.map((r) => r.domain);

    // `rolesForDomains` maps every required domain to at least its owning role.
    for (const { domain, role } of REQUIRED) {
      const roles = presets.rolesForDomains([domain]);
      assert.ok(roles.includes(role), `domain ${domain} must map to ${role}; got ${roles}`);
    }

    // Across the whole change the mapping is distinct and complete.
    const mapped = presets.rolesForDomains(allDomains);
    assert.equal(new Set(mapped).size, mapped.length, 'role list must be deduplicated');
    for (const { role } of REQUIRED) assert.ok(mapped.includes(role), `missing role ${role}`);

    // B.1 domain classification: architecture/data/security are architectural.
    for (const domain of ['architecture', 'data-pipeline', 'security']) {
      assert.equal(complexity.classifyTask({ domains: [domain], estimate: { files: 1 } }), 'architectural');
    }
    assert.equal(complexity.classifyTask({ domains: ['backend'], estimate: { files: 4 } }), 'normal');

    // Persist one task per role; these are the only roles the runtime may
    // instantiate for this project. The task list is the planner's structured
    // decision (mock model), exactly where the real Lead would have made one.
    const mock = makeMock({
      'plan-middleware': {
        default: {
          text: JSON.stringify({
            tasks: REQUIRED.map((r, i) => ({
              id: `MW-${String(i + 1).padStart(3, '0')}`,
              title: `${r.domain} work`,
              objective: r.objective,
              role: r.role,
              domains: [r.domain],
              task_class: complexity.classifyTask({ domains: [r.domain], estimate: { files: 3 } }),
              risk_class: 'R2',
              allowed_paths: [`src/${r.domain}/**`],
              verification: ['syntax', 'lint', 'unit', 'integration'],
            })),
          }),
          usage: { inputTokens: 400, outputTokens: 200 },
        },
      },
    });
    const plan = modelDecision(mock, 'mock/plan-middleware');
    assert.equal(plan.tasks.length, 8);
    assert.deepEqual([...plan.tasks.map((t) => t.role)].sort(), [...REQUIRED.map((r) => r.role)].sort());
    addTasks(h, plan.tasks);

    // ── runtime evidence: distinct task roles persisted in sdlc.db ─────────
    const rows = h.runtime.db
      .prepare('SELECT DISTINCT role FROM tasks WHERE project_id = ? ORDER BY role')
      .all(h.projectId);
    const distinct = rows.map((r) => r.role);
    assert.deepEqual(distinct, [...REQUIRED.map((r) => r.role)].sort());
    assert.equal(distinct.length, 8, 'eight distinct roles, no duplicates');

    const tasks = h.runtime.listTasks({ projectId: h.projectId });
    assert.deepEqual(activeRoles(tasks), [...distinct, 'lead'].sort());
    // Every inactive role exists in the registry but is NOT instantiated.
    const unnecessary = unnecessaryRoles(tasks);
    assert.equal(unnecessary.length, 26 - 9, 'only 8 role agents + the lead exist');
    assert.ok(unnecessary.includes('release-manager'));
    assert.ok(unnecessary.includes('technical-writer'));

    // ── runtime evidence: events record the planner's task creation ────────
    const events = h.runtime.getEvents({});
    assert.equal(events.filter((e) => e.action === 'task-created').length, 8);
  } finally {
    h.close();
  }
});
