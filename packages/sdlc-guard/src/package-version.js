/**
 * packages/sdlc-guard/src/package-version.js — the one shared pkgVersion reader (C16 v).
 *
 * Eight hand-duplicates of this 5-line helper (`guard/plugin.js`,
 * `core/services.js`, `tools/plugin.js`, `presets/plugin.js`,
 * `client-ui/server/{plugin,handlers,flow}.js`) each read their own
 * package.json beside a different `import.meta.url` depth. The behaviour is
 * identical — return the `version` field, null when unreadable — so the only
 * parameter is how many levels to walk up from the CALLER's module URL.
 *
 * The guard package owns it because guard is the lowest layer every other
 * package may already reach (core → guard is an allowed layering edge; the
 * helper itself imports only node:fs, so it adds no cycle risk). Callers in
 * core/tools/presets import it relatively (src/ shares one module instance);
 * the published lib/ resolves the same import through the declared
 * `@patwoodman/dsh-sdlc-flow-guard` dependency via the cross-package rewrite.
 */

import { readFileSync } from 'node:fs';

/**
 * Read the `version` field of the package.json `levelsUp` URL segments above
 * the caller's module URL. Returns null (never throws) when the file is
 * missing or unparseable — the selftest report tolerates a null version.
 *
 * URL math mirrors `new URL('../package.json', import.meta.url)`: each `..`
 * segment pops one path component (the file name, then each directory). So
 * `levelsUp = 2` reproduces `../package.json` (one `..`), `levelsUp = 3`
 * reproduces `../../package.json` (two `..`s).
 *
 * @param {string|URL} callerUrl - the caller's `import.meta.url`.
 * @param {number} [levelsUp=2] - `2` for `src/<file>.js` (same as
 *   `../package.json`), `3` for `src/server/<file>.js` (same as
 *   `../../package.json`).
 * @returns {string|null}
 */
export function readPackageVersion(callerUrl, levelsUp = 2) {
  try {
    const dots = '../'.repeat(Math.max(1, levelsUp - 1));
    return JSON.parse(readFileSync(new URL(`${dots}package.json`, String(callerUrl)), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** The caller's own package version (the common case: `src/<file>.js`). */
export function pkgVersion(callerUrl) {
  const version = readPackageVersion(callerUrl, 2);
  return version ?? null;
}

export default { readPackageVersion, pkgVersion };
