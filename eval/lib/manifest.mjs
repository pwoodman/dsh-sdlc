/**
 * eval/lib/manifest.mjs — task manifests for the A/B evaluation.
 *
 * A manifest is a declarative, version-pinned description of ONE task that both
 * arms receive identically. Keeping it declarative is what makes the comparison
 * auditable: the requirement text, the fixture, the acceptance checks and the
 * metric set are all data, not code hidden in a runner.
 */

import { readdirSync, readFileSync } from 'node:fs';

export const MANIFEST_VERSION = '1.0.0';

export const DIMENSIONS = [
  'architecture',
  'code-quality',
  'ui',
  'ux',
  'api-performance',
  'api-reliability',
  'security',
  'speed',
  'cost',
];

/** Metric ids the harness knows how to collect (see metrics.mjs). */
export const METRIC_IDS = [
  'loc',
  'duplication',
  'complexity',
  'module-cycles',
  'syntax',
  'test-ratio',
  'secrets',
  'dangerous-patterns',
  'api-surface',
  'static-a11y',
  'deps',
  'coverage',
  'mutation',
  'latency-p95',
  'error-rate',
  'bundle-size',
  'dependency-audit',
];

export const FIXTURE_KINDS = ['greenfield', 'repo'];

export const CHECK_KINDS = ['command', 'file-exists', 'file-contains', 'http', 'rubric'];

/** A machine-readable description of the manifest contract (published as docs). */
export const TASK_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'SDLC evaluation task manifest',
  type: 'object',
  required: ['id', 'title', 'dimension', 'requirement', 'fixture', 'acceptance', 'metrics', 'strata'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,40}$' },
    title: { type: 'string', minLength: 4 },
    dimension: { type: 'array', items: { enum: DIMENSIONS }, minItems: 1 },
    requirement: { type: 'string', minLength: 10, description: 'the exact prompt given to BOTH arms' },
    fixture: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { enum: FIXTURE_KINDS },
        seedFiles: { type: 'object', description: 'greenfield only: relative path → file contents' },
        repoUrl: { type: 'string' },
        commit: { type: 'string' },
      },
    },
    acceptance: {
      type: 'object',
      required: ['checks'],
      properties: {
        checks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'kind'],
            properties: {
              id: { type: 'string' },
              kind: { enum: CHECK_KINDS },
              command: { type: 'array', items: { type: 'string' } },
              path: { type: 'string' },
              contains: { type: 'string' },
              url: { type: 'string' },
              expect: { type: 'string' },
            },
          },
        },
      },
    },
    metrics: { type: 'array', items: { enum: METRIC_IDS }, minItems: 1 },
    budget: {
      type: 'object',
      properties: {
        maxWallClockMs: { type: 'number' },
        maxCostUsd: { type: 'number' },
      },
    },
    strata: {
      type: 'object',
      required: ['risk', 'size'],
      properties: {
        risk: { enum: ['R1', 'R2', 'R3', 'R4'] },
        size: { enum: ['S', 'M', 'L'] },
      },
    },
    /** A negative control: the plugin is expected to be NEUTRAL here, not better. */
    control: { type: 'boolean' },
  },
});

/** Validate one manifest. Returns `{ok, problems}`; never throws. */
export function validateTask(task) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  if (!task || typeof task !== 'object') return { ok: false, problems: ['manifest is not an object'] };

  need(typeof task.id === 'string' && /^[a-z0-9][a-z0-9-]{2,40}$/.test(task.id), 'id must be kebab-case (3–41 chars)');
  need(typeof task.title === 'string' && task.title.length >= 4, 'title is required');
  need(Array.isArray(task.dimension) && task.dimension.length >= 1, 'dimension must be a non-empty array');
  for (const d of task.dimension ?? []) need(DIMENSIONS.includes(d), `unknown dimension ${d}`);
  need(typeof task.requirement === 'string' && task.requirement.length >= 10, 'requirement must be a prompt of ≥10 chars');

  const fx = task.fixture;
  need(fx && typeof fx === 'object', 'fixture is required');
  if (fx) {
    need(FIXTURE_KINDS.includes(fx.kind), `fixture.kind must be one of ${FIXTURE_KINDS.join('|')}`);
    if (fx.kind === 'greenfield') need(fx.seedFiles && typeof fx.seedFiles === 'object', 'greenfield fixtures need seedFiles');
    if (fx.kind === 'repo') {
      need(typeof fx.repoUrl === 'string', 'repo fixtures need repoUrl');
      need(typeof fx.commit === 'string' && fx.commit.length >= 7, 'repo fixtures need a pinned commit');
    }
  }

  const checks = task.acceptance?.checks;
  need(Array.isArray(checks) && checks.length >= 1, 'acceptance.checks must be a non-empty array');
  const checkIds = new Set();
  for (const c of checks ?? []) {
    need(c && typeof c === 'object', 'each check must be an object');
    if (!c) continue;
    need(typeof c.id === 'string' && c.id.length > 0, 'each check needs an id');
    need(CHECK_KINDS.includes(c.kind), `check ${c.id}: unknown kind ${c.kind}`);
    if (c.id) {
      need(!checkIds.has(c.id), `duplicate check id ${c.id}`);
      checkIds.add(c.id);
    }
    if (c.kind === 'command') need(Array.isArray(c.command) && c.command.length > 0, `check ${c.id}: command must be a non-empty argv array`);
    if (c.kind === 'file-exists' || c.kind === 'file-contains') need(typeof c.path === 'string', `check ${c.id}: path is required`);
    if (c.kind === 'file-contains') need(typeof c.contains === 'string', `check ${c.id}: contains is required`);
    if (c.kind === 'http') need(typeof c.url === 'string', `check ${c.id}: url is required`);
  }

  need(Array.isArray(task.metrics) && task.metrics.length >= 1, 'metrics must be a non-empty array');
  for (const m of task.metrics ?? []) need(METRIC_IDS.includes(m), `unknown metric ${m}`);

  need(task.strata && ['R1', 'R2', 'R3', 'R4'].includes(task.strata.risk), 'strata.risk is required (R1–R4)');
  need(task.strata && ['S', 'M', 'L'].includes(task.strata.size), 'strata.size is required (S|M|L)');
  if (task.control !== undefined) need(typeof task.control === 'boolean', 'control must be a boolean');

  return { ok: problems.length === 0, problems };
}

/**
 * Load and validate every `*.json` manifest in a directory.
 * @returns {{tasks: object[], problems: string[]}}
 */
export function loadTasks(dir, { readdir = readdirSync, readFile = defaultReadFile } = {}) {
  const list = readdir(dir).filter((f) => f.endsWith('.json')).sort();
  const tasks = [];
  const problems = [];
  for (const file of list) {
    let doc;
    try {
      doc = JSON.parse(readFile(`${dir}/${file}`));
    } catch (err) {
      problems.push(`${file}: not valid JSON (${err.message})`);
      continue;
    }
    const v = validateTask(doc);
    if (!v.ok) {
      problems.push(...v.problems.map((p) => `${file}: ${p}`));
      continue;
    }
    tasks.push(doc);
  }
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.id)) problems.push(`duplicate task id ${t.id}`);
    seen.add(t.id);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, problems };
}

function defaultReadFile(path) {
  return readFileSync(path, 'utf8');
}

export default { validateTask, loadTasks, TASK_SCHEMA, DIMENSIONS, METRIC_IDS };
