/**
 * scripts/lib/cross-package-imports.cjs — rewrite cross-package imports.
 *
 * `src/` uses relative imports (`../../sdlc-guard/src/index.js`) so the monorepo
 * tests see one module instance and `instanceof` works across packages.
 * `lib/` must use bare npm specifiers (`@patwoodman/dsh-sdlc-flow-guard`) so a
 * published package resolves through `node_modules`.
 *
 * This module is the single source of truth for that transform. It is used by:
 *   - scripts/build.mjs       (local build)
 *   - scripts/build-ui.mjs    (UI build)
 *   - packages/<name>/build.cjs  (publish-time prepack)
 */

const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

/** Build the directory-name → npm-package-name map from packages/ manifests. */
function buildMap(packagesDir) {
  const dirToPkg = {};
  const mainStems = {};
  for (const d of readdirSync(packagesDir)) {
    const pj = join(packagesDir, d, 'package.json');
    if (!existsSync(pj)) continue;
    const m = JSON.parse(readFileSync(pj, 'utf8'));
    if (!m.name) continue;
    dirToPkg[d] = m.name;
    mainStems[m.name] = (m.main ?? 'lib/index.js').split('/').pop().replace(/\.\w+$/, '');
  }
  return { dirToPkg, mainStems };
}

/**
 * Rewrite cross-package relative imports to bare npm specifiers.
 * @param {string} text  source file content
 * @param {{dirToPkg:object, mainStems:object}} map  from buildMap()
 */
function rewriteImports(text, map) {
  return text.replace(
    /from '((?:\.\.\/)+)sdlc-([a-z-]+)\/src\/([^']+?)\.(js|mjs)'/g,
    (_m, _dots, dir, file, _ext) => {
      const pkg = map.dirToPkg[`sdlc-${dir}`];
      if (!pkg) return _m;
      const stem = file.split('/').pop();
      return (stem === 'index' || stem === map.mainStems[pkg])
        ? `from '${pkg}'`
        : `from '${pkg}/${file}'`;
    },
  );
}

module.exports = { buildMap, rewriteImports };
