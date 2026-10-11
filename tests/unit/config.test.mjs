/**
 * tests/unit/config.test.mjs — configuration schema, precedence and validation (spec v3 H.1–H.3, F.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const cfg = await core.config();
const yamlMod = await core.yaml();

test('defaults satisfy the H.3 validation checks', () => {
  const result = cfg.validateConfig(cfg.DEFAULT_CONFIG, { projectRoot: tempDir('sdlc-cfg-'), env: {} });
  assert.deepEqual(result.errors, []);
});

test('H.3 check: every routed model needs a price entry', () => {
  const config = cfg.deepMerge(cfg.DEFAULT_CONFIG, { pricing: null });
  const result = cfg.validateConfig(config, { projectRoot: '/tmp', env: {} });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('pricing:')), 'unpriced models must fail, not guess');
});

test('H.3 check: CHEAP and BASE need at least one model; ELEVATED empty warns', () => {
  const missing = cfg.validateConfig(cfg.deepMerge(cfg.DEFAULT_CONFIG, { tiers: { cheap: [], base: [] } }), { projectRoot: '/tmp', env: {} });
  assert.ok(missing.errors.some((e) => e.includes('tier: "cheap"')));
  assert.ok(missing.errors.some((e) => e.includes('tier: "base"')));
  const emptyElevated = cfg.validateConfig(cfg.deepMerge(cfg.DEFAULT_CONFIG, { tiers: { elevated: [] } }), { projectRoot: '/tmp', env: {} });
  assert.equal(emptyElevated.ok, true);
  assert.ok(emptyElevated.warnings.some((w) => w.includes('elevated')));
});

test('H.3 check: per-task budgets must not exceed the per-project budget', () => {
  const config = cfg.deepMerge(cfg.DEFAULT_CONFIG, { budgets: { perProject: { maxCostUsd: 1 } } });
  const result = cfg.validateConfig(config, { projectRoot: '/tmp', env: {} });
  assert.ok(result.errors.some((e) => e.includes('exceeds per-project')));
});

test('H.3 check: worktreeRetentionDays must be positive', () => {
  const result = cfg.validateConfig(cfg.deepMerge(cfg.DEFAULT_CONFIG, { execution: { worktreeRetentionDays: 0 } }), { projectRoot: '/tmp', env: {} });
  assert.ok(result.errors.some((e) => e.includes('worktreeRetentionDays')));
});

test('H.3 check: provider keys warn (not fail) under the credential-store default (E5)', () => {
  const result = cfg.validateConfig(cfg.DEFAULT_CONFIG, { projectRoot: '/tmp', env: {} });
  assert.ok(result.warnings.some((w) => w.includes('credentials.yaml')));
  assert.equal(result.errors.some((e) => e.includes('provider keys')), false);
});

test('H.3 check: an env-key deployment without the key is an error', () => {
  const config = cfg.deepMerge(cfg.DEFAULT_CONFIG, { execution: { credentialStore: false, workerMode: 'process' } });
  const result = cfg.validateConfig(config, { projectRoot: '/tmp', env: {} });
  assert.ok(result.errors.some((e) => e.includes('OPENAI_API_KEY')));
});

test('environment overrides follow H.2', () => {
  const config = cfg.applyEnvOverrides(cfg.DEFAULT_CONFIG, {
    SDLC_DB_PATH: '/custom/db.sqlite',
    SDLC_LOG_LEVEL: 'debug',
    SDLC_WORKER_MODE: 'in-process',
    SDLC_MAX_PARALLEL: '3',
  });
  assert.equal(config.storage.dbPath, '/custom/db.sqlite');
  assert.equal(config.observability.logLevel, 'debug');
  assert.equal(config.execution.workerMode, 'in-process');
  assert.equal(config.execution.maxParallelWorkers, 3);
});

test('loadConfig merges file over defaults and honours SDLC_CONFIG_PATH', () => {
  const dir = tempDir('sdlc-cfg-load-');
  try {
    mkdirSync(join(dir, '.sdlc'), { recursive: true });
    writeFileSync(join(dir, '.sdlc', 'config.yml'), 'observability:\n  logLevel: warn\n');
    const { config, exists } = cfg.loadConfig(dir, { env: {} });
    assert.equal(exists, true);
    assert.equal(config.observability.logLevel, 'warn');
    assert.equal(config.storage.dbPath, '.sdlc/sdlc.db', 'untouched defaults survive');
  } finally { cleanup(dir); }
});

test('tier overlays use the id-targeted form, never `- insert:` (E4)', () => {
  const overlay = cfg.buildTierOverlay({ provider: 'openai', model: 'gpt-4o', reasoningEffort: 'medium' });
  assert.deepEqual(overlay, [{ id: 'agent-default-model', config: { provider: 'openai', model: 'gpt-4o', reasoningEffort: 'medium' } }]);
  assert.equal('insert' in overlay[0], false);
  const yaml = yamlMod.dumpYaml(overlay);
  assert.match(yaml, /^- id: agent-default-model/m);
  assert.doesNotMatch(yaml, /insert:/);
});

test('dumpConfigYaml round-trips through the YAML subset (H.1 document order)', () => {
  const text = cfg.dumpConfigYaml(cfg.DEFAULT_CONFIG);
  const parsed = yamlMod.parseYaml(text);
  assert.equal(parsed.tiers.cheap[0].provider, 'openai');
  assert.equal(parsed.execution.basePort, 4100);
  assert.deepEqual(parsed.safety.orchestratorPaths, ['.sdlc/**', '.dsh/**']);
  assert.equal(parsed.budgets.perTask.R4.maxTokens, 3000000);
  assert.ok(text.indexOf('tiers:') < text.indexOf('pricing:'), 'document order follows H.1');
});

test('modelKey is provider/model', () => {
  assert.equal(cfg.modelKey({ provider: 'openai', model: 'gpt-4o' }), 'openai/gpt-4o');
});
