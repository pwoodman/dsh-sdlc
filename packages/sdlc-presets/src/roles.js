/**
 * packages/sdlc-presets/src/roles.js — the 26-role registry (spec v3 C.3).
 *
 * The spec's §7 role roster PLUS Accessibility Engineer (required by §53 Test 4
 * and owned: WCAG conformance, assistive-tech review, a11y test policy).
 *
 * A role is a `@deepseek-ai/dsh-agent-preset` row. Prompt = persona prefix
 * (mission + verification policy + escalation rules) + `{{cwd}}`/`{{model}}`
 * suffix; tools = mounted rows only (allowlist by omission). Permissions and
 * model are NOT preset fields (P15/P21) — permission comes from the profile's
 * `permission` row and the model from the tier overlay (C.6).
 *
 * Team composition rule (B.4, acceptance Test 1): a role becomes active only
 * when the planner assigns ≥1 task to it. There are no standing role agents;
 * "no unnecessary agents" is structural, not heuristic.
 */

/**
 * Tools every worker preset composes. Worker presets get NO delegation tools.
 *
 * DSH requires the tool configs in these rows explicitly — neither plugin has
 * a default — and an omitted value fails the WHOLE preset at mount:
 *   - `tool-todo`: `allowParallelInProgress` is a required deployment policy.
 *     A worker owns exactly one task contract at a time, so it keeps the
 *     single-active discipline.
 *   - `tool-subagent` (Lead only, below): `provider` is required.
 */
export const WORKER_TOOL_ROWS = [
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: false } },
  { id: 'sdlc-report', name: '@patwoodman/dsh-sdlc-flow-tools/report' },
];

/** Tools only the Lead composes: delegation, plan deltas, decision ledger.
 *
 * `provider: 'spawn'` is the in-process backend the web template registers;
 * `backgroundMode: 'continuable'` keeps delegated child conversations available
 * for follow-up turns. Both match DSH's own `standard`/web preset.
 */
export const LEAD_TOOL_ROWS = [
  {
    id: 'tool-subagent',
    name: '@deepseek-ai/dsh-tool-subagent',
    config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' },
  },
  { id: 'sdlc-dispatch', name: '@patwoodman/dsh-sdlc-flow-tools/dispatch' },
  { id: 'sdlc-plan', name: '@patwoodman/dsh-sdlc-flow-tools/plan' },
];

export const POLICY_SUFFIX = [
  'Verification policy: you may not accept your own work; the runtime derives files_changed from git and re-runs every gate.',
  'Escalation policy: if you need a decision or a missing dependency, call sdlc_request_decision; never guess and never widen scope.',
  'Authority: you hold no authority to approve, release, or merge. Anything that grants authority is a human decision.',
].join('\n');

export const ROLES = [
  { id: 'lead', name: 'Lead Orchestrator', order: 10, domains: ['requirements', 'architecture', 'integration'], lead: true,
    owns: 'Decomposition, delegation, plan deltas, decision ledger, final reporting.',
    description: 'Owns decomposition, delegation and the decision ledger; the only role that talks to the user.' },
  { id: 'business-analyst', name: 'Business Analyst', order: 20, domains: ['requirements'],
    owns: 'Stakeholder intent, business rules, success measures, requirement conflicts.',
    description: 'Owns stakeholder intent, business rules and success measures.' },
  { id: 'requirements-engineer', name: 'Requirements Engineer', order: 21, domains: ['requirements'],
    owns: 'Requirement statements, acceptance criteria, traceability.',
    description: 'Owns requirement statements and their acceptance criteria.' },
  { id: 'product-owner', name: 'Product Owner', order: 22, domains: ['requirements'],
    owns: 'Scope, priority, value, release acceptance.',
    description: 'Owns scope, priority and release acceptance.' },
  { id: 'solution-architect', name: 'Solution Architect', order: 30, domains: ['architecture', 'integration'],
    owns: 'ADRs, system boundaries, cross-cutting concerns, architecture summary.',
    description: 'Owns ADRs, system boundaries and cross-cutting concerns.' },
  { id: 'security-engineer', name: 'Security Engineer', order: 31, domains: ['security'],
    owns: 'Threat analysis, security testing, authz review, dependency risk.',
    description: 'Owns threat analysis, security testing, authz review and dependency risk.' },
  { id: 'data-engineer', name: 'Data Engineer', order: 32, domains: ['data-pipeline', 'database'],
    owns: 'Pipelines, data contracts, backfills, data quality.',
    description: 'Owns pipelines, data contracts and data quality.' },
  { id: 'database-engineer', name: 'Database Engineer', order: 33, domains: ['database'],
    owns: 'Schema design, migrations, indexes, query performance.',
    description: 'Owns schema design, migrations and query performance.' },
  { id: 'ux-designer', name: 'UX Designer', order: 40, domains: ['ux-ui'],
    owns: 'Flows, information architecture, interaction states, usability.',
    description: 'Owns flows, information architecture and interaction states.' },
  { id: 'ui-designer', name: 'UI Designer', order: 41, domains: ['ux-ui', 'frontend'],
    owns: 'Visual system, layout, typography, component appearance.',
    description: 'Owns the visual system, layout and component appearance.' },
  { id: 'accessibility-engineer', name: 'Accessibility Engineer', order: 42, domains: ['ux-ui', 'frontend'],
    owns: 'WCAG conformance, assistive-tech review, a11y test policy and the always-on floor checks (contrast, alt text, labels, focus visibility).',
    description: 'Owns WCAG conformance, assistive-tech review and the a11y test policy.' },
  { id: 'frontend-engineer', name: 'Frontend Engineer', order: 50, domains: ['frontend', 'ux-ui'],
    owns: 'UI implementation, component state, client-side routing, rendering performance.',
    description: 'Owns UI implementation, component state and client-side routing.' },
  { id: 'backend-engineer', name: 'Backend Engineer', order: 51, domains: ['backend'],
    owns: 'Service logic, domain rules, persistence calls, error handling.',
    description: 'Owns service logic, domain rules and error handling.' },
  { id: 'api-engineer', name: 'API Engineer', order: 52, domains: ['api', 'backend'],
    owns: 'API contracts, versioning, validation at the boundary, contract tests.',
    description: 'Owns API contracts, versioning and validation at the boundary.' },
  { id: 'integration-engineer', name: 'Integration Engineer', order: 53, domains: ['integration'],
    owns: 'Third-party integrations, retries, idempotency, webhook handling.',
    description: 'Owns third-party integrations, retries and idempotency.' },
  { id: 'devops-engineer', name: 'DevOps Engineer', order: 60, domains: ['devops'],
    owns: 'CI/CD, containers, environments, deployment safety.',
    description: 'Owns CI/CD, containers, environments and deployment safety.' },
  { id: 'platform-engineer', name: 'Platform Engineer', order: 61, domains: ['devops', 'architecture'],
    owns: 'Build tooling, developer experience, shared libraries, dependency upgrades.',
    description: 'Owns build tooling, developer experience and shared libraries.' },
  { id: 'qa-engineer', name: 'QA Engineer', order: 70, domains: ['testing'],
    owns: 'Test strategy, acceptance-criteria mapping, defect triage.',
    description: 'Owns test strategy, acceptance-criteria mapping and defect triage.' },
  { id: 'test-automation-engineer', name: 'Test Automation Engineer', order: 71, domains: ['testing'],
    owns: 'Unit and integration test suites, fixtures, determinism.',
    description: 'Owns unit and integration suites, fixtures and determinism.' },
  { id: 'e2e-engineer', name: 'E2E Engineer', order: 72, domains: ['testing', 'frontend'],
    owns: 'End-to-end scenarios, browser automation, flake control.',
    description: 'Owns end-to-end scenarios and browser automation.' },
  { id: 'visual-qa-engineer', name: 'Visual QA Engineer', order: 73, domains: ['testing', 'ux-ui'],
    owns: 'Viewport matrix, screenshot review, visual regression verdicts.',
    description: 'Owns the viewport matrix, screenshot review and visual regression verdicts.' },
  { id: 'performance-engineer', name: 'Performance Engineer', order: 74, domains: ['testing', 'backend'],
    owns: 'Load profiles, budgets, profiling, performance gates.',
    description: 'Owns load profiles, performance budgets and profiling.' },
  { id: 'technical-writer', name: 'Technical Writer', order: 80, domains: ['docs'],
    owns: 'README, API docs, runbooks, changelog.',
    description: 'Owns README, API docs, runbooks and the changelog.' },
  { id: 'release-manager', name: 'Release Manager', order: 81, domains: ['devops', 'docs'],
    owns: 'Release notes, versioning, release gates, rollback plan.',
    description: 'Owns release notes, versioning, release gates and the rollback plan.' },
  { id: 'code-reviewer', name: 'Code Reviewer', order: 90, domains: ['testing'],
    owns: 'Independent review verdict, correctness, maintainability, scope discipline.',
    description: 'Owns the independent review verdict, correctness and maintainability.' },
  { id: 'sre-engineer', name: 'SRE Engineer', order: 91, domains: ['devops', 'backend'],
    owns: 'Observability, SLOs, incident readiness, operational runbooks.',
    description: 'Owns observability, SLOs and incident readiness.' },
];

if (ROLES.length !== 26) {
  throw new Error(`role registry must contain exactly 26 roles (spec C.3), found ${ROLES.length}`);
}

export const ROLE_IDS = ROLES.map((r) => r.id);
export const ROLE_COUNT = ROLES.length;

export function presetIdFor(roleId) {
  return `preset-sdlc-${roleId}`;
}

export function presetConfigIdFor(roleId) {
  return `sdlc-${roleId}`;
}

/**
 * The registry the 26 preset rows need to activate. DSH's `web` template
 * ships an `agent-preset-registry` row; the `headless` and `sdk` templates
 * (the only ones that can serve one-shot `--json` runs and boot probes) do
 * not — so every treatment-arm run warned `26 entries did not activate …
 * waiting for service: agentPresets` while the presets silently never
 * mounted.
 *
 * The row is FIRST inside the member patch's insert: list so it exists before
 * the presets register against it on headless/sdk profiles, which ship no
 * registry row. On web the shipped row exists, so the generated lead
 * meta-bundle replaces this insert with an id-targeted override of the
 * shipped row's `default` — a duplicate id+name is loader-accepted but blocks
 * the plugin manager's uninstall audit.
 */
export function presetRegistryRow() {
  return {
    id: 'agent-preset-registry',
    name: '@deepseek-ai/dsh-agent-preset-registry',
    config: { default: 'sdlc-lead' },
  };
}

export function personaPrefix(role) {
  return [
    `You are the ${role.name} on an SDLC task team.`,
    '',
    `Mission: ${role.owns}`,
    '',
    'You work on exactly one task at a time under a task contract that names the paths you may change.',
    'Stay inside the contract. If the task is wrong, say so and request a decision — do not widen scope.',
    '',
    POLICY_SUFFIX,
  ].join('\n');
}

/**
 * The Lead fans work out to workers/subagents, so its own todo list may legitimately
 * track several active items at once. Workers stay single-active.
 */
function leadToolRows() {
  const rows = WORKER_TOOL_ROWS.map((row) =>
    row.id === 'tool-todo'
      ? { ...row, config: { ...row.config, allowParallelInProgress: true } }
      : row,
  );
  return [...rows, ...LEAD_TOOL_ROWS];
}

/** Build the `- insert:` row for one role preset. */
export function presetRow(role) {
  const plugins = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: personaPrefix(role),
        suffix: 'Your working directory is {{cwd}}. Model: {{model}}.',
      },
    },
    ...(role.lead ? leadToolRows() : WORKER_TOOL_ROWS),
  ];
  return {
    id: presetIdFor(role.id),
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: presetConfigIdFor(role.id),
      name: role.name,
      description: role.description,
      order: role.order,
      plugins,
    },
  };
}

export function presetRows() {
  return [presetRegistryRow(), ...ROLES.map(presetRow)];
}

/** Domain → candidate roles (used by the planner's role assignment). */
export function rolesForDomains(domains = []) {
  const set = new Set(domains);
  const matches = ROLES.filter((r) => r.domains.some((d) => set.has(d))).map((r) => r.id);
  return matches.length ? matches : ['backend-engineer'];
}

export default { ROLES, ROLE_IDS, ROLE_COUNT, presetRows, presetRow, presetRegistryRow, presetIdFor, rolesForDomains };
