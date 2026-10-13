/**
 * packages/sdlc-presets/src/plugin.js — declares the preset rows and reports the
 * registered preset ids through the SDLC_SELFTEST boot hook (C.3/C.9).
 *
 * The rows themselves live in cordis.patch.yml, generated from roles.js by
 * `node scripts/gen-presets.mjs`. This module exists so the probe profile can
 * report the roster deterministically and so `presetRows()` is importable by
 * tests and the installer.
 */

import { readFileSync } from 'node:fs';
import { ROLES, ROLE_IDS, ROLE_COUNT, presetRows, presetIdFor, presetConfigIdFor, rolesForDomains } from './roles.js';
import { contributeSelftest, setSelftestMeta } from './selftest.js';

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

/** Extract the preset ids actually declared by this bundle's patch file. */
export function declaredPresetIds(patchPath = new URL('../cordis.patch.yml', import.meta.url)) {
  const text = readFileSync(patchPath, 'utf8');
  return [...text.matchAll(/^\s*-\s*id:\s*(preset-sdlc-[A-Za-z0-9-]+)\s*$/gm)].map((m) => m[1]);
}

/**
 * Loader entry. MUST return nothing: the Cordis runner interprets a plugin's
 * return value as an effect (`TypeError: Invalid effect` for a
 * non-constructible apply; silently dropped for this regular-function apply).
 * Tests that want the roster call `declaredPresetIds()` directly.
 * @returns {undefined}
 */
export function apply(ctx, config = {}) {
  setSelftestMeta({ version: pkgVersion() });
  const presets = declaredPresetIds();
  contributeSelftest({ presets });
}

export {
  ROLES, ROLE_IDS, ROLE_COUNT, presetRows, presetIdFor, presetConfigIdFor, rolesForDomains,
};
