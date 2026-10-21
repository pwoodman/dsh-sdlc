/**
 * tests/unit/host-model.test.mjs — inherit the Harness's LLM route.
 *
 * The orchestrator must be able to use the provider/account DSH already
 * resolves, instead of requiring a second API key. These tests pin profile
 * discovery, the tier/price adoption shape, and the explicit-"unknown" price
 * rule that keeps cost honest when DSH exposes no currency metadata.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveHostModel, hostModelAdoption, applyHostModel, hostModelBootstrap, hostModelKey, HOST_MODEL_FALLBACK,
} from '../../packages/sdlc-core/src/host-model.js';
import { DEFAULT_CONFIG, deepMerge, validateConfig } from '../../packages/sdlc-core/src/config.js';
import { ModelRouter } from '../../packages/sdlc-core/src/router.js';
import { tempDir, cleanup } from '../lib/helpers.mjs';

function profileHome(patch) {
  const dir = tempDir('sdlc-host-model-');
  mkdirSync(join(dir, 'profiles', 'desktop'), { recursive: true });
  writeFileSync(join(dir, 'profiles', 'desktop', 'cordis.patch.yml'), patch);
  return dir;
}

test('resolveHostModel reads the active profile override', () => {
  const dir = profileHome([
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-account',
    '    model: deepseek-flash',
    '    reasoningEffort: high',
    '',
  ].join('\n'));
  try {
    const host = resolveHostModel({ dshHome: dir, profile: 'desktop' });
    assert.equal(host.provider, 'deepseek-account');
    assert.equal(host.model, 'deepseek-flash');
    assert.equal(host.reasoningEffort, 'high');
    assert.match(host.source, /profiles\/desktop\/cordis\.patch\.yml$/);
  } finally { cleanup(dir); }
});

test('explicit provider/model win and missing config falls back to DSH default', () => {
  const explicit = resolveHostModel({ provider: 'custom', model: 'route' });
  assert.deepEqual(explicit, { provider: 'custom', model: 'route', reasoningEffort: null, source: 'explicit' });

  const empty = tempDir('sdlc-host-model-empty-');
  try {
    const host = resolveHostModel({ dshHome: empty, profile: 'nope' });
    assert.equal(host.provider, HOST_MODEL_FALLBACK.provider);
    assert.equal(host.model, HOST_MODEL_FALLBACK.model);
  } finally { cleanup(empty); }
});

test('host adoption writes the same route into every tier with an unknown price', () => {
  const host = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' };
  const adoption = hostModelAdoption(host);
  // The effort is part of the route the Harness resolved, so the tier entry
  // carries it and buildTierOverlay can reproduce the exact selection.
  assert.deepEqual(adoption.tiers.cheap[0], { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' });
  assert.deepEqual(adoption.tiers.base[0], { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' });
  assert.deepEqual(adoption.tiers.elevated[0], { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' });
  assert.deepEqual(adoption.pricing[hostModelKey(host)], { input: null, output: null, unknown: true });

  // A route without an effort stays minimal — no `reasoningEffort: null` key.
  const bare = hostModelAdoption({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null });
  assert.deepEqual(Object.keys(bare.tiers.cheap[0]), ['provider', 'model']);

  const config = applyHostModel(deepMerge(DEFAULT_CONFIG, {}), host);
  const result = validateConfig(config, { projectRoot: process.cwd() });
  assert.equal(result.errors.length, 0, result.errors.join('; '));
  assert.ok(result.warnings.some((warning) => /declared unknown/.test(warning)));

  const router = new ModelRouter({ tiers: config.tiers, pricing: config.pricing });
  assert.equal(router.estimateCost(hostModelKey(host), { tokens_in: 1000, tokens_out: 1000 }), null);
});

test('a fresh bootstrap names exactly one provider; adoption keeps authored prices', () => {
  const host = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: null };

  // hostModelBootstrap REPLACES the price table: the written file names one
  // provider, with no legacy OpenAI/Anthropic tier or price row.
  const boot = hostModelBootstrap(host);
  assert.deepEqual(Object.keys(boot.pricing), ['deepseek-account/deepseek-flash']);
  assert.equal(boot.pricing['deepseek-account/deepseek-flash'].unknown, true);
  for (const list of Object.values(boot.tiers)) {
    assert.equal(list.length, 1);
    assert.equal(list[0].provider, 'deepseek-account');
  }
  const bootText = JSON.stringify(boot);
  assert.doesNotMatch(bootText, /openai|anthropic/);

  // applyHostModel MERGES: a config that already carries a user-authored
  // price keeps it alongside the adopted route.
  const existing = deepMerge(DEFAULT_CONFIG, {});
  existing.pricing['custom/model'] = { input: 1, output: 2 };
  const adopted = applyHostModel(existing, host);
  assert.deepEqual(adopted.pricing['custom/model'], { input: 1, output: 2 });
  assert.equal(adopted.pricing['deepseek-account/deepseek-flash'].unknown, true);
  // Misuse is loud, never a silent fallback to another provider.
  assert.throws(() => hostModelBootstrap(null), TypeError);
});
