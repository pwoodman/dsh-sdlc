/**
 * packages/sdlc-core/src/config.js — configuration schema, defaults and validation.
 *
 * Implements spec v3 H.1 (full schema), H.2 (environment overrides) and H.3
 * (`config validate`). The spec uses schemastery `Config` inside DSH plugins;
 * the same shape is reproduced here as a plain validator so the CLI, the
 * installer and the tests can validate configuration WITHOUT a DSH boot.
 */

import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseYaml, dumpYaml } from './yaml-lite.js';

export const DEFAULT_CONFIG = Object.freeze({
  tiers: {
    cheap: [{ provider: 'openai', model: 'gpt-4o-mini', reasoningEffort: 'low', maxTokens: 8192 }],
    base: [
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'anthropic', model: 'claude-sonnet-4' },
    ],
    elevated: [
      { provider: 'anthropic', model: 'claude-opus-4' },
      { provider: 'openai', model: 'o3' },
    ],
  },
  pricing: {
    'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
    'openai/gpt-4o': { input: 2.5, output: 10.0 },
    'openai/o3': { input: 10.0, output: 40.0 },
    'anthropic/claude-sonnet-4': { input: 3.0, output: 15.0 },
    'anthropic/claude-opus-4': { input: 15.0, output: 75.0 },
  },
  execution: {
    workerMode: 'process',
    maxParallelWorkers: 'auto',
    maxParallelE2e: 2,
    basePort: 4100,
    worktreeRetentionDays: 7,
    bootstrapTimeoutMs: 600000,
    dependencyCache: true,
    workerEnvKeys: [],
    egress: { mode: 'allowlist', hosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'] },
  },
  budgets: {
    perTask: {
      R1: { maxAttempts: 2, maxDurationMs: 1800000, maxCostUsd: 2.0, maxTokens: 200000 },
      R2: { maxAttempts: 3, maxDurationMs: 3600000, maxCostUsd: 5.0, maxTokens: 400000 },
      R3: { maxAttempts: 3, maxDurationMs: 7200000, maxCostUsd: 15.0, maxTokens: 1000000 },
      R4: { maxAttempts: 4, maxDurationMs: 14400000, maxCostUsd: 50.0, maxTokens: 3000000 },
    },
    perProject: { maxCostUsd: 200.0, maxDurationMs: 86400000, maxParallelWorkers: 'auto' },
  },
  verification: {
    gateTimeoutMs: 300000,
    retryFailedGate: 1,
    visualViewports: ['1440x900', '1024x768', '390x844'],
    visualFullMatrix: 'auto',
    a11yFloor: true,
    gates: {},
    detection: 'auto',
    skipWhen: { 'no-browser-stack': ['e2e', 'visual'] },
  },
  escalation: {
    loopThreshold: 2,
    maxFailedAttempts: 3,
    visualFailureThreshold: 2,
    collaborativeTriggers: [
      'architecture_dispute', 'security_r4', 'elevated_double_fail', 'major_refactor',
    ],
  },
  context: { tokenBudget: 24000, maxLinesPerFile: 200, truncationPriority: [4, 5, 7] },
  storage: {
    dbPath: '.sdlc/sdlc.db',
    fallbackChain: ['node-sqlite', 'better-sqlite3', 'storage-domain'],
    requireQuickCheckOnOpen: true,
  },
  safety: {
    instanceLock: true,
    orchestratorPaths: ['.sdlc/**', '.dsh/**'],
    guardForbiddenPatterns: ['git push --force*', 'rm -rf /', 'git clean -fdx*'],
    guardMode: 'deny',
  },
  router: { historyWindow: 1000, laplaceSmoothing: true, tieBreak: 'cost' },
  observability: { logLevel: 'info', eventLog: true, metricsExport: false },
});

/** H.2 environment overrides. */
export const ENV_MAP = {
  SDLC_DB_PATH: ['storage', 'dbPath'],
  SDLC_LOG_LEVEL: ['observability', 'logLevel'],
  SDLC_WORKER_MODE: ['execution', 'workerMode'],
  SDLC_MAX_PARALLEL: ['execution', 'maxParallelWorkers'],
};

export function deepMerge(base, override) {
  if (override === undefined) return structuredClone(base);
  if (Array.isArray(base) || Array.isArray(override)) return structuredClone(override);
  if (base && override && typeof base === 'object' && typeof override === 'object') {
    const out = structuredClone(base);
    for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return structuredClone(override);
}

function coerceEnvValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export function applyEnvOverrides(config, env = process.env) {
  const out = structuredClone(config);
  for (const [name, path] of Object.entries(ENV_MAP)) {
    if (env[name] === undefined) continue;
    let cursor = out;
    for (const key of path.slice(0, -1)) {
      cursor[key] ??= {};
      cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = coerceEnvValue(env[name]);
  }
  return out;
}

export function sortTierEntries(tiers) {
  const out = {};
  for (const [name, list] of Object.entries(tiers ?? {})) {
    out[name] = [...list].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  }
  return out;
}

export function configPathFor(projectRoot, env = process.env) {
  const configured = env.SDLC_CONFIG_PATH ?? '.sdlc/config.yml';
  return isAbsolute(configured) ? configured : join(projectRoot, configured);
}

export function loadConfig(projectRoot, { env = process.env, configPath } = {}) {
  const path = configPath ?? configPathFor(projectRoot, env);
  const fileConfig = existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) ?? {}) : {};
  const merged = deepMerge(DEFAULT_CONFIG, fileConfig);
  merged.tiers = sortTierEntries(merged.tiers);
  return { config: applyEnvOverrides(merged, env), path, exists: existsSync(path) };
}

export function modelKey(entry) {
  return `${entry.provider}/${entry.model}`;
}

/** Walk up to the nearest directory that exists, so a not-yet-created
 *  `.sdlc/` is validated against its parent rather than reported missing. */
export function nearestExistingDir(path) {
  let cursor = path;
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(cursor)) return cursor;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return cursor;
}

/**
 * H.3 checks 1–7. Returns `{ok, errors, warnings}`; errors block dispatch,
 * warnings are printed. Pure: no network, no model.
 */
export function validateConfig(config, { env = process.env, projectRoot = process.cwd() } = {}) {
  const errors = [];
  const warnings = [];

  // 1. schema shape
  const required = ['tiers', 'pricing', 'execution', 'budgets', 'verification', 'storage', 'safety'];
  for (const key of required) {
    if (config[key] === undefined) errors.push(`schema: missing section "${key}"`);
  }
  if (config.tiers && typeof config.tiers !== 'object') errors.push('schema: tiers must be a mapping');

  // 2. tier completeness
  const tiers = config.tiers ?? {};
  for (const tier of ['cheap', 'base']) {
    if (!Array.isArray(tiers[tier]) || tiers[tier].length === 0) {
      errors.push(`tier: "${tier}" must contain at least one model`);
    }
  }
  if (!Array.isArray(tiers.elevated) || tiers.elevated.length === 0) {
    warnings.push('tier: "elevated" is empty — escalations will resolve NO_ELIGIBLE_MODEL and block');
  }
  for (const [tier, list] of Object.entries(tiers)) {
    for (const entry of list ?? []) {
      if (!entry.provider || !entry.model) errors.push(`tier ${tier}: entry missing provider/model`);
    }
  }

  // 3. price table completeness
  for (const [tier, list] of Object.entries(tiers)) {
    for (const entry of list ?? []) {
      const key = modelKey(entry);
      const price = config.pricing?.[key];
      if (!price || typeof price.input !== 'number' || typeof price.output !== 'number') {
        errors.push(`pricing: ${key} (tier ${tier}) has no price entry — init fails rather than guessing`);
      }
    }
  }

  // 4. provider keys — only relevant for env-key deployments
  const providers = new Set();
  for (const list of Object.values(tiers)) for (const e of list ?? []) providers.add(e.provider);
  for (const provider of providers) {
    const keyName = `${String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    const hasEnv = Boolean(env[keyName]);
    const workerEnv = config.execution?.workerEnvKeys ?? [];
    const storeAuth = config.execution?.credentialStore !== false; // default: credential store
    if (!hasEnv && !storeAuth) {
      errors.push(`provider keys: ${provider} needs ${keyName} (no credential store configured)`);
    } else if (!hasEnv) {
      warnings.push(`provider keys: ${keyName} not set — assuming $DSH_HOME/.credentials.yaml`);
    }
    if (hasEnv && !workerEnv.includes(keyName) && config.execution?.workerMode === 'process') {
      // Informational: this is the E5 default, not a misconfiguration.
      warnings.push(`worker auth: ${keyName} is not in execution.workerEnvKeys — workers use the credential store (E5 default)`);
    }
  }

  // 5. budget sanity
  const perProject = config.budgets?.perProject ?? {};
  for (const [risk, b] of Object.entries(config.budgets?.perTask ?? {})) {
    if (perProject.maxCostUsd != null && b.maxCostUsd > perProject.maxCostUsd) {
      errors.push(`budgets: ${risk} per-task maxCostUsd ${b.maxCostUsd} exceeds per-project ${perProject.maxCostUsd}`);
    }
    if (perProject.maxDurationMs != null && b.maxDurationMs > perProject.maxDurationMs) {
      errors.push(`budgets: ${risk} per-task maxDurationMs exceeds per-project maxDurationMs`);
    }
  }

  // 6. port range
  const basePort = config.execution?.basePort ?? 4100;
  const parallel = config.execution?.maxParallelWorkers === 'auto'
    ? Math.max(1, Math.floor((cpus()?.length ?? 2) / 2))
    : Number(config.execution?.maxParallelWorkers ?? 1);
  const high = basePort + parallel * 10;
  for (const common of [3000, 5000, 8000, 8080]) {
    if (common >= basePort && common <= high) {
      warnings.push(`port range: ${basePort}-${high} contains the common port ${common}`);
    }
  }

  // 7. path validity
  const dbPath = config.storage?.dbPath ?? '.sdlc/sdlc.db';
  const resolved = isAbsolute(dbPath) ? dbPath : join(projectRoot, dbPath);
  const parent = nearestExistingDir(dirname(resolved));
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    errors.push(`path validity: dbPath directory ${parent} is not writable`);
  }
  if (!(config.execution?.worktreeRetentionDays > 0)) {
    errors.push('path validity: execution.worktreeRetentionDays must be > 0');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Generate the id-targeted tier overlay (C.6/E4). The `- insert:` form would
 * append a SECOND `agent-default-model` row; this form replaces it.
 */
export function buildTierOverlay(entry) {
  const config = { provider: entry.provider, model: entry.model };
  if (entry.reasoningEffort) config.reasoningEffort = entry.reasoningEffort;
  if (entry.maxTokens) config.maxTokens = entry.maxTokens;
  return [{ id: 'agent-default-model', config }];
}

/** Serialize a project config to `.sdlc/config.yml` in the document order of H.1. */
export function dumpConfigYaml(config) {
  const order = [
    'tiers', 'pricing', 'execution', 'budgets', 'verification', 'escalation',
    'context', 'storage', 'safety', 'router', 'observability',
  ];
  const ordered = {};
  for (const key of order) if (config[key] !== undefined) ordered[key] = config[key];
  for (const [k, v] of Object.entries(config)) if (!(k in ordered)) ordered[k] = v;
  return `# .sdlc/config.yml — generated by \`sdlc init\` (spec v3 H.1)\n${dumpYaml(ordered)}\n`;
}

export default {
  DEFAULT_CONFIG, loadConfig, validateConfig, buildTierOverlay, applyEnvOverrides, deepMerge, modelKey,
};
