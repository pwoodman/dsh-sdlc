/**
 * tests/contract/schemas.mjs — the L3 contract schemas (spec v3 K.2 layer L3).
 *
 * Every document the orchestrator exchanges across a seam is published here as
 * a versioned JSON-Schema document (draft 2020-12 subset): the task contract
 * (B.3.1), the WorkerResult (B.3.2), the outbox envelope (B.3.2), the elevation
 * response (B.6), the independent-review verdict (verifier.parseReviewVerdict)
 * and the gate-result set (gates.runVerification).
 *
 * `validate()` is a tiny, dependency-free validator. It intentionally supports
 * only the keywords the schemas below use — a contract test must not depend on
 * a third-party validator, and there is no network to install one:
 *
 *   type (string | array of strings), required, properties,
 *   additionalProperties, items, enum, const, oneOf, anyOf,
 *   minimum, maximum, minLength, pattern, $ref (document-local)
 *
 * K.10's evidence-bundle shape is also published here as a schema so the CI
 * harness can validate its own output with the same code path.
 */

export const SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** B.4.1 fixed gate order (risk.js GATE_ORDER). */
export const GATE_NAMES = [
  'syntax', 'types', 'lint', 'unit', 'integration', 'api', 'e2e', 'visual', 'security', 'perf', 'build',
];

export const WORKER_STATUSES = ['completed', 'failed', 'aborted', 'timeout'];
export const OUTBOX_STATUSES = ['completed', 'failed', 'aborted'];
export const RISK_CLASSES = ['R1', 'R2', 'R3', 'R4'];
export const DISPOSITIONS = ['retask', 'replan', 'architecture_review', 'escalate_user'];

const str = (extra = {}) => ({ type: 'string', ...extra });
const strArray = (extra = {}) => ({ type: 'array', items: { type: 'string', ...extra } });
const nullableString = { oneOf: [{ type: 'null' }, { type: 'string' }] };

const evidenceClaim = {
  type: 'object',
  additionalProperties: true,
  required: ['ac_id', 'claim'],
  properties: {
    ac_id: { type: 'string', minLength: 1 },
    claim: { type: 'string', enum: ['pass', 'fail'] },
    artifact: { type: 'string' },
  },
};

// ── B.3.1 — Task contract ──────────────────────────────────────────────────
export const taskContractSchema = {
  $schema: SCHEMA_DRAFT,
  $id: 'https://sdlc.dev/schemas/task-contract.schema.json',
  title: 'SDLC task contract (spec v3 B.3.1)',
  'x-contract-version': '3.0.0',
  type: 'object',
  additionalProperties: true,
  required: ['id', 'title', 'objective', 'role'],
  properties: {
    id: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-[0-9]+$' },
    title: { type: 'string', minLength: 1 },
    objective: { type: 'string', minLength: 1 },
    role: { type: 'string', minLength: 1 },
    depends_on: strArray(),
    risk_class: { type: 'string', enum: RISK_CLASSES },
    capabilities: strArray(),
    acceptance_criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'statement'],
        properties: {
          id: { type: 'string', minLength: 1 },
          statement: { type: 'string' },
          check: { type: 'string' },
        },
      },
    },
    allowed_paths: strArray({ minLength: 1 }),
    forbidden_paths: strArray({ minLength: 1 }),
    verification: { type: 'array', items: { type: 'string', enum: GATE_NAMES } },
    estimate: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: { type: 'integer', minimum: 0 },
        integrations: { type: 'integer', minimum: 0 },
        external_deps: { type: 'integer', minimum: 0 },
      },
    },
    budgets: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_attempts: { type: 'integer', minimum: 1 },
        max_duration_ms: { type: 'integer', minimum: 1 },
        max_cost_usd: { type: 'number', minimum: 0 },
        max_tokens: { type: 'integer', minimum: 1 },
      },
    },
  },
};

// ── B.3.2 — WorkerResult ───────────────────────────────────────────────────
export const workerResultSchema = {
  $schema: SCHEMA_DRAFT,
  $id: 'https://sdlc.dev/schemas/worker-result.schema.json',
  title: 'SDLC WorkerResult (spec v3 B.3.2)',
  'x-contract-version': '3.0.0',
  type: 'object',
  additionalProperties: true,
  required: ['status', 'summary', 'evidence_claims', 'tests_run', 'requests', 'files_changed', 'out_of_scope_files'],
  properties: {
    // worker-claimed
    status: { type: 'string', enum: WORKER_STATUSES },
    summary: { type: 'string' },
    evidence_claims: { type: 'array', items: evidenceClaim },
    tests_run: strArray(),
    requests: { type: 'array' },
    // runtime-derived
    files_changed: strArray(),
    out_of_scope_files: strArray(),
    forbidden_files: strArray(),
    result_malformed: { type: 'boolean' },
    suspect: { type: 'boolean' },
    session_id: nullableString,
    tokens: {
      type: 'object',
      additionalProperties: true,
      required: ['in', 'out'],
      properties: { in: { type: 'number', minimum: 0 }, out: { type: 'number', minimum: 0 } },
    },
    cost_usd: { type: 'number', minimum: 0 },
    duration_ms: { type: 'number', minimum: 0 },
    model: {
      oneOf: [
        { type: 'null' },
        { type: 'string' },
        {
          type: 'object',
          additionalProperties: true,
          required: ['provider', 'id'],
          properties: { provider: { type: 'string' }, id: { type: 'string' } },
        },
      ],
    },
    attempt: { type: 'integer', minimum: 0 },
    worker_claimed_status: { oneOf: [{ type: 'null' }, { type: 'string' }] },
  },
};

// ── B.3.2 — outbox envelope ────────────────────────────────────────────────
export const outboxSchema = {
  $schema: SCHEMA_DRAFT,
  $id: 'https://sdlc.dev/schemas/task-outbox.schema.json',
  title: 'SDLC task outbox envelope (spec v3 B.3.2)',
  'x-contract-version': '1.0.0',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'runId', 'taskId', 'attempt', 'nonce', 'status', 'summary', 'evidence_claims', 'tests_run', 'requests'],
  properties: {
    schemaVersion: { const: 1 },
    runId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    attempt: { type: 'integer', minimum: 0 },
    nonce: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: OUTBOX_STATUSES },
    summary: { type: 'string' },
    evidence_claims: { type: 'array', items: evidenceClaim },
    tests_run: strArray(),
    requests: { type: 'array' },
  },
};

// ── B.6 — elevated model structured response ───────────────────────────────
export const elevationResponseSchema = {
  $schema: SCHEMA_DRAFT,
  $id: 'https://sdlc.dev/schemas/elevation-response.schema.json',
  title: 'SDLC elevation response (spec v3 B.6)',
  'x-contract-version': '3.0.0',
  type: 'object',
  additionalProperties: true,
  required: ['root_cause', 'failure_pattern', 'mis_decomposition', 'architecture_issue', 'corrective_plan', 'disposition'],
  properties: {
    root_cause: { type: 'string', minLength: 1 },
    failure_pattern: { type: 'string' },
    mis_decomposition: { type: 'boolean' },
    architecture_issue: { type: 'boolean' },
    corrective_plan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['add', 'edit', 'remove'] },
          task_id: { type: 'string' },
          title: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
    disposition: { type: 'string', enum: DISPOSITIONS },
  },
};

// ── Independent-review verdict (verifier.parseReviewVerdict) ───────────────
export const reviewVerdictSchema = {
  $schema: SCHEMA_DRAFT,
  $id: 'https://sdlc.dev/schemas/review-verdict.schema.json',
  title: 'SDLC independent review verdict (spec v3 B.4 / L.1 rule 3)',
  'x-contract-version': '1.0.0',
  type: 'object',
  additionalProperties: true,
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['accept', 'reject'] },
    reason: nullableString,
    reviewer: nullableString,
  },
};

// ── Gate-result set (gates.runVerification) ────────────────────────────────
const gateEntryOneOf = [
  {
    type: 'object',
    additionalProperties: true,
    required: ['status'],
    properties: {
      status: { type: 'string', pattern: '^(pass|fail:[^\\s]+)$' },
      exitCode: { type: 'integer' },
      durationMs: { type: 'number', minimum: 0 },
      logPath: { type: 'string' },
      signature: { type: 'string' },
    },
  },
  {
    type: 'object',
    additionalProperties: true,
    required: ['status'],
    properties: { status: { type: 'string', pattern: '^skipped:.+$' } },
  },
];

export const gateResultSetSchema = {
  $schema: SCHEMA_DRAFT,
  $id: 'https://sdlc.dev/schemas/gate-result-set.schema.json',
  title: 'SDLC gate result set (spec v3 B.4.1)',
  'x-contract-version': '1.0.0',
  type: 'object',
  additionalProperties: true,
  required: ['overall', 'gates'],
  properties: {
    overall: { type: 'string', enum: ['pass', 'fail'] },
    gates: { type: 'object', additionalProperties: { oneOf: gateEntryOneOf } },
    firstFailure: {
      oneOf: [
        { type: 'null' },
        { type: 'object', additionalProperties: true, required: ['status'] },
      ],
    },
  },
};

// ── K.10 — evidence bundle ─────────────────────────────────────────────────
export const evidenceBundleSchema = {
  $schema: SCHEMA_DRAFT,
  $id: 'https://sdlc.dev/schemas/evidence-bundle.schema.json',
  title: 'SDLC evidence bundle (spec v3 K.10)',
  'x-contract-version': '1.0.0',
  type: 'object',
  additionalProperties: true,
  required: ['suite', 'suiteVersion', 'ran', 'passed', 'failed', 'skipped', 'results'],
  properties: {
    suite: { type: 'string', minLength: 1 },
    suiteVersion: { type: 'string', minLength: 1 },
    ran: { type: 'integer', minimum: 0 },
    passed: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    node: { type: 'string' },
    platform: { type: 'string' },
    cwd: { type: 'string' },
    gitSha: nullableString,
    startedAt: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'status'],
        properties: {
          id: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: ['pass', 'fail', 'skip'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          durationMs: { type: 'number', minimum: 0 },
          live: { type: 'boolean' },
        },
      },
    },
  },
};

/** Published schema documents by stable name. */
export const schemas = {
  taskContract: taskContractSchema,
  workerResult: workerResultSchema,
  outbox: outboxSchema,
  elevationResponse: elevationResponseSchema,
  reviewVerdict: reviewVerdictSchema,
  gateResultSet: gateResultSetSchema,
  evidenceBundle: evidenceBundleSchema,
};

/**
 * Fixture files under tests/contract/fixtures/, keyed by schema name. The
 * `.invalid.json` document MUST be rejected; the `.valid.json` MUST pass.
 */
export const fixtureFiles = {
  taskContract: { valid: 'task-contract.valid.json', invalid: 'task-contract.invalid.json' },
  workerResult: { valid: 'worker-result.valid.json', invalid: 'worker-result.invalid.json' },
  outbox: { valid: 'outbox.valid.json', invalid: 'outbox.invalid.json' },
  elevationResponse: { valid: 'elevation-response.valid.json', invalid: 'elevation-response.invalid.json' },
  reviewVerdict: { valid: 'review-verdict.valid.json', invalid: 'review-verdict.invalid.json' },
  gateResultSet: { valid: 'gate-result-set.valid.json', invalid: 'gate-result-set.invalid.json' },
  evidenceBundle: { valid: 'evidence-bundle.valid.json', invalid: 'evidence-bundle.invalid.json' },
};

// ── validator ──────────────────────────────────────────────────────────────

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof node !== 'object') return null;
    node = node[key];
  }
  return node ?? null;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function walk(schema, value, path, errors, root) {
  if (schema === true || schema == null) return;
  if (schema === false) {
    errors.push({ path, message: 'schema forbids any value' });
    return;
  }
  if (typeof schema !== 'object') return;

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    if (target == null) {
      errors.push({ path, message: `unresolvable $ref ${schema.$ref}` });
      return;
    }
    walk(target, value, path, errors, root);
    return;
  }

  const here = path || '$';

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(value, t))) {
      errors.push({ path: here, message: `expected type ${allowed.join('|')}, got ${typeOf(value)}` });
      return;
    }
  }

  if (schema.const !== undefined && !sameValue(value, schema.const)) {
    errors.push({ path: here, message: `expected const ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameValue(value, candidate))) {
    errors.push({ path: here, message: `value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]` });
  }

  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((branch) => validate(branch, value, root).ok);
    if (!ok) errors.push({ path: here, message: 'does not match anyOf' });
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validate(branch, value, root).ok).length;
    if (matches !== 1) errors.push({ path: here, message: `matched ${matches} of oneOf (expected exactly 1)` });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: here, message: `length ${value.length} < minLength ${schema.minLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: here, message: `does not match pattern ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path: here, message: `${value} < minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path: here, message: `${value} > maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      value.forEach((item, i) => walk(schema.items, item, `${here}[${i}]`, errors, root));
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: here, message: `items ${value.length} < minItems ${schema.minItems}` });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push({ path: `${here}.${key}`, message: 'missing required property' });
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined) walk(sub, value[key], `${here}.${key}`, errors, root);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push({ path: `${here}.${key}`, message: 'additional property not allowed' });
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(value)) {
        if (!(key in props)) walk(schema.additionalProperties, value[key], `${here}.${key}`, errors, root);
      }
    }
  }
}

/**
 * Validate `value` against `schema`.
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validate(schema, value, root = null) {
  const errors = [];
  walk(schema, value, '', errors, root ?? schema);
  return { ok: errors.length === 0, errors };
}

/** Assertion-friendly message for a failed validation. */
export function formatErrors(result, label = 'value') {
  return `${label} failed schema: ${result.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`;
}

export default {
  schemas,
  validate,
  formatErrors,
  fixtureFiles,
  taskContractSchema,
  workerResultSchema,
  outboxSchema,
  elevationResponseSchema,
  reviewVerdictSchema,
  gateResultSetSchema,
  evidenceBundleSchema,
};
