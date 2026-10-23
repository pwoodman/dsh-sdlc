/**
 * packages/sdlc-core/src/host-model.js — inherit the Harness's LLM selection.
 *
 * DeepSeek Harness already owns the signed-in provider/account (for example
 * `deepseek-account/deepseek-flash`) and resolves its credential per request.
 * The orchestrator's default tiers used to be OpenAI/Anthropic, which forced a
 * second API key. This module reads the active DSH profile's
 * `agent-default-model` row and turns it into orchestrator tiers, so the same
 * harness auth is used and no key is added.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG, deepMerge } from './config.js';
import { parseYaml } from './yaml-lite.js';

/**
 * DSH's own base default, used when no profile override is discoverable.
 * Verified against the runtime: `deepseek-official` is the route
 * `@deepseek-ai/dsh-llm-deepseek` registers, and an omitted `models` list
 * advertises `deepseek-flash` as its default entry. Inside the app this
 * fallback is unreachable (the live `agentDefaultModel` service and the
 * active profile's patch file both answer first); it exists for CLI runs
 * outside a configured Harness. Like every adopted route it resolves through
 * the shared credential store — the user is never asked for a key.
 */
export const HOST_MODEL_FALLBACK = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: null,
  source: 'dsh-default',
});

function readEntries(path) {
  if (!existsSync(path)) return [];
  try {
    const doc = parseYaml(readFileSync(path, 'utf8'));
    return Array.isArray(doc) ? doc : [];
  } catch (err) {
    // (ii): the old silent swallow hid WHICH profile patch was unparseable.
    // Warn with the file (and line when the YAML error carries one), then try
    // the next profile layer — a `!!js` patch is a skip, not a discovery
    // failure, but the user should see which layer was skipped.
    const where = err?.line != null ? `${path}:${err.line}` : path;
    console.warn(`host-model: skipping unparseable profile patch ${where}: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Resolve the provider/model the Harness would use for a new Agent.
 *
 * Explicit `provider` + `model` win. Otherwise every candidate profile's
 * user patch is checked in order, then the profile root, then DSH's base
 * default. The result is always a usable route, never null.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] - DSH home (default `$DSH_HOME` or `~/.dsh`).
 * @param {string} [options.profile] - active profile name (default `$DSH_PROFILE`).
 * @param {string} [options.provider] - explicit provider override.
 * @param {string} [options.model] - explicit model override.
 * @param {string} [options.reasoningEffort] - explicit effort override.
 * @returns {{provider:string,model:string,reasoningEffort:string|null,source:string}}
 */
export function resolveHostModel({
  dshHome,
  profile,
  provider,
  model,
  reasoningEffort,
} = {}) {
  if (provider && model) {
    return { provider, model, reasoningEffort: reasoningEffort ?? null, source: 'explicit' };
  }
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const names = [...new Set([
    profile,
    process.env.DSH_PROFILE,
    'desktop',
    'sdlc-web',
    'web',
  ].filter(Boolean))];
  for (const name of names) {
    for (const file of ['cordis.patch.yml', 'cordis.yml']) {
      const path = join(home, 'profiles', name, file);
      for (const entry of readEntries(path)) {
        const config = entry?.config ?? {};
        if (entry?.id !== 'agent-default-model') continue;
        if (typeof config.provider !== 'string' || typeof config.model !== 'string') continue;
        return {
          provider: config.provider,
          model: config.model,
          reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
          source: path,
        };
      }
    }
  }
  return { ...HOST_MODEL_FALLBACK };
}

/** Stable `provider/model` key used by the price table. */
export function hostModelKey(hostModel) {
  return `${hostModel.provider}/${hostModel.model}`;
}

/**
 * Orchestrator config fragments for one host route.
 *
 * The same route fills all three tiers: the Harness owns provider availability,
 * so inventing a second cheaper/stronger route would reintroduce the key
 * problem. The price entry is explicitly `unknown` — DSH exposes token counts
 * but no currency metadata, so cost renders as "—" rather than a fake zero.
 *
 * @param {{provider:string,model:string}} hostModel
 * @returns {{tiers:object,pricing:object}}
 */
export function hostModelAdoption(hostModel) {
  if (!hostModel || typeof hostModel.provider !== 'string' || typeof hostModel.model !== 'string'
    || !hostModel.provider || !hostModel.model) {
    // Callers gate on a resolved route before adopting; a null here is a
    // programming error and must be loud, never a silent OpenAI fallback.
    throw new TypeError('hostModelAdoption: a resolved { provider, model } route is required');
  }
  const route = { provider: hostModel.provider, model: hostModel.model };
  // The effort is part of the route the Harness resolved: carry it so the
  // worker tier overlay (`buildTierOverlay`) reproduces the exact selection.
  if (typeof hostModel.reasoningEffort === 'string' && hostModel.reasoningEffort) {
    route.reasoningEffort = hostModel.reasoningEffort;
  }
  return {
    tiers: {
      cheap: [{ ...route }],
      base: [{ ...route }],
      elevated: [{ ...route }],
    },
    pricing: {
      [hostModelKey(hostModel)]: { input: null, output: null, unknown: true },
    },
  };
}

/** Merge the host route into an existing config without dropping other sections. */
export function applyHostModel(config, hostModel) {
  return deepMerge(config, hostModelAdoption(hostModel));
}

/**
 * Full config for a FRESH bootstrap: the spec defaults with the tiers AND the
 * price table replaced by the single adopted route.
 *
 * The written file names exactly one provider — no OpenAI/Anthropic tier and
 * no legacy price row — so a new user is never prompted for a second
 * credential. Adoption into an EXISTING config is `applyHostModel`, which
 * merges and keeps the user's other prices; replacement is only for a config
 * that did not exist (or an explicit `init --force/--reconfigure` rewrite,
 * whose semantics are "rewrite from defaults" already).
 */
export function hostModelBootstrap(hostModel) {
  const adoption = hostModelAdoption(hostModel);
  const base = deepMerge(DEFAULT_CONFIG, {});
  base.tiers = adoption.tiers;
  base.pricing = adoption.pricing;
  return base;
}

export default {
  HOST_MODEL_FALLBACK,
  resolveHostModel,
  hostModelKey,
  hostModelAdoption,
  applyHostModel,
  hostModelBootstrap,
};
