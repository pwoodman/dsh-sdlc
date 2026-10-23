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
 *
 * It also owns the package layering contract (C16/C17): ALLOWED_EDGES lists
 * every permitted cross-package `src/` import direction, enforced by
 * tests/contract/layering.test.mjs. The partition behind it is spec v3 E6:
 * `sdlc-core` (host services) must never be mounted into a worker profile —
 * the worker gets guard + tools only. An edge that would mount host services
 * in a worker (a scheduler/DB import) may never be added here.
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

/**
 * Recursively list files under `dir`, relative to `dir`, sorted.
 * The one implementation every build script shares (C16): scripts/build.mjs,
 * scripts/build-ui.mjs and every packages/<name>/build.cjs previously carried
 * their own byte-identical copy.
 */
function walk(dir, base = dir, out = []) {
  const { readdirSync: ls, statSync } = require('node:fs');
  for (const entry of ls(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

/**
 * Allowed cross-package `src/` import directions (`importer → imported`).
 *
 * Each entry names the source package directory and the target package
 * directory whose `src/` tree it may import relatively. The check is purely
 * directional — it allows the published `lib/` to keep resolving through
 * `node_modules` while the source tree shares one module instance.
 *
 *   cli → {core}:           the CLI is a thin host shell over core services.
 *   client-ui → {core,cli}:  the UI host half renders core state via CLI paths.
 *   client-ui → {guard}:     the ONE shared pkgVersion reader lives in the
 *                            lowest layer (guard imports only node:fs); the UI
 *                            reaches it without pulling core services.
 *   core → {guard}:          the host runtime enforces task contracts through
 *                            the independently-installable guard plugin (E6's
 *                            worker profile carries guard + tools, never core).
 *   tools → {core,guard}:   core: the B.3.2 outbox channel DERIVED in
 *                            core/worker-result.js. The permit covers ONLY
 *                            worker-result.js (the derive/serialize half of
 *                            B.3.2, no scheduler/DB surface): the check below
 *                            pins the imported file list per edge. This edge is
 *                            B.3.2's own direction — the spec makes tools the
 *                            PRODUCER of outbox envelopes and core the CONSUMER
 *                            (ingest/resolve/derive/scopeVerdict) — so the import
 *                            points worker → core exactly as the data flows. It
 *                            is layering-documented, not layering-clean: tools
 *                            still ships in the worker while core never does,
 *                            and the tools lib/ resolves the import through its
 *                            declared @patwoodman/dsh-sdlc-flow-core dependency
 *                            (pinned by packed-deps-resolve).
 *                            guard: the shared pkgVersion reader (see client-ui).
 *   presets → {guard}:       same shared pkgVersion reader (see client-ui).
 *                            core/tools/presets reach it via the same edge;
 *                            cli reaches it transitively through core.
 *
 * E6 forbids the reverse (core → tools, anything → core from a worker
 * profile): core mounts a second scheduler + DB writer in a worker.
 */
const ALLOWED_EDGES = {
  'sdlc-cli': { targets: ['sdlc-core'], files: null },
  'sdlc-client-ui': { targets: ['sdlc-core', 'sdlc-cli', 'sdlc-guard'], files: null },
  'sdlc-core': { targets: ['sdlc-guard'], files: null },
  'sdlc-tools': { targets: ['sdlc-core', 'sdlc-guard'], files: { 'sdlc-core': ['worker-result.js'] } },
  'sdlc-presets': { targets: ['sdlc-guard'], files: null },
};

/**
 * Every cross-package relative `src/` import in the workspace.
 * @returns {{fromDir:string,fromFile:string,toDir:string,toFile:string,raw:string}[]}
 */
function listCrossPackageImports({ root = join(__dirname, '..', '..'), fs: fsOpts } = {}) {
  const { readdirSync: ls, readFileSync: read, statSync, existsSync: exists } =
    fsOpts ?? require('node:fs');
  const out = [];
  const packagesDir = join(root, 'packages');
  let dirs = [];
  try {
    dirs = ls(packagesDir).filter((d) => {
      try { return statSync(join(packagesDir, d)).isDirectory(); } catch { return false; }
    });
  } catch { return out; }
  const re = /from '((?:\.\.\/)+)sdlc-([a-z-]+)\/src\/([^']+?)\.(js|mjs)'/g;
  for (const dir of dirs) {
    const srcDir = join(packagesDir, dir, 'src');
    let files = [];
    try { if (!exists(srcDir)) continue; } catch { continue; }
    const collect = (d) => {
      for (const entry of ls(d).sort()) {
        const full = join(d, entry);
        if (statSync(full).isDirectory()) collect(full);
        else if (/\.(js|mjs|jsx|cjs)$/.test(entry)) files.push(full);
      }
    };
    collect(srcDir);
    for (const file of files) {
      let text = '';
      try { text = read(file, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(re)) {
        out.push({
          fromDir: dir,
          fromFile: file.slice(join(packagesDir, dir).length + 1),
          toDir: `sdlc-${m[2]}`,
          toFile: `${m[3]}.${m[4] ?? 'js'}`,
          raw: m[0],
        });
      }
    }
  }
  return out;
}

/**
 * Check the workspace against ALLOWED_EDGES. Returns `{ok, violations[]}` —
 * never throws, so the contract test can print every edge at once.
 */
function checkLayering({ root = join(__dirname, '..', '..') } = {}) {
  const violations = [];
  for (const edge of listCrossPackageImports({ root })) {
    const rule = ALLOWED_EDGES[edge.fromDir];
    if (!rule || !rule.targets.includes(edge.toDir)) {
      violations.push(
        `${edge.fromDir} → ${edge.toDir} not in ALLOWED_EDGES (${edge.fromFile} imports ${edge.toFile})`,
      );
      continue;
    }
    const pinned = rule.files?.[edge.toDir];
    if (pinned && !pinned.some((stem) => edge.toFile === stem || edge.toFile.endsWith(`/${stem}`))) {
      violations.push(
        `${edge.fromDir} → ${edge.toDir} limited to [${pinned.join(', ')}] but ${edge.fromFile} imports ${edge.toFile}`,
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

module.exports = { buildMap, rewriteImports, walk, ALLOWED_EDGES, listCrossPackageImports, checkLayering };
