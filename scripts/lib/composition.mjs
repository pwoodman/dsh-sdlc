/**
 * scripts/lib/composition.mjs — STATIC composition validation for the bundles.
 *
 * WHY THIS EXISTS. `dsh --dump-config` proves composition, but it requires pnpm
 * (to install bundles into a profile) and a writable `$DSH_HOME`. On a host
 * without pnpm every composition check would silently skip — so the same
 * questions are answered statically here, from the artifacts themselves:
 *
 *   - does every declared patch file exist, and is the declaration a string or
 *     an ordered list (P1/C1)?
 *   - are the loader row ids unique WITHIN each patch file, and across the
 *     bundles a profile composes?
 *   - does every row's plugin `name` resolve to a real module in this repo?
 *   - does the worker profile stay free of `sdlc-core` (errata E6)?
 *   - does the interactive lead expose only the public role presets, while the
 *     member bundle declares all 26 role compositions?
 *
 * This is a *static* proof: it shows the composition is well-formed. It does
 * not replace the runtime `--dump-config` check, which remains the preferred
 * evidence when a profile can be installed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../../packages/sdlc-core/src/yaml-lite.js';

export const ROOT = join(import.meta.dirname, '..', '..');

/**
 * The one deliberate bundle-patch id-targeted override.
 *
 * The web template ships `agent-preset-registry`. The lead bundle must set its
 * default to `sdlc-lead`; inserting a second row with the same id+name is
 * loader-accepted but makes the plugin manager's uninstall audit report
 * "bundle-in-use" forever (the shipped row matches the removed bundle's row).
 * An id-targeted override changes the shipped row without contributing a row.
 * Keep the exception narrow: the id AND the expected config must match.
 */
export function isSanctionedBundleOverride(override) {
  return override?.id === 'agent-preset-registry' && override?.config?.default === 'sdlc-lead';
}

// E6 is checked on the BASENAME, so a re-scoped tree is still caught. See
// `isOwnBundleName` for why the basename (not the current prefix) is the right key.
// Derived from the workspace manifests, not a literal: the suite renamed from
// `orchestrator-core` to `dsh-sdlc-flow-core`, and a literal would have made
// this check pass on a worker that mounts the host bundle (E6 gone silent).
// Resolved lazily so synthetic package maps in tests keep working.
function workerForbiddenBasename(packages = loadPackages()) {
  for (const name of packages.keys()) {
    const m = /^@[^/]+\/(.+)$/.exec(name);
    if (m && m[1].endsWith('-core')) return m[1];
  }
  return 'dsh-sdlc-flow-core';
}

/** Every package directory with a package.json, keyed by package name. */
export function loadPackages(root = ROOT) {
  const dir = join(root, 'packages');
  const out = new Map();
  for (const name of readdirSync(dir)) {
    const pkgPath = join(dir, name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    out.set(pkg.name, { dir: join(dir, name), pkg, name: pkg.name });
  }
  return out;
}

/**
 * The npm scope THIS tree's packages live under (e.g. `@patwoodman`).
 *
 * Derived from the workspace manifests, never a constant: `scripts/set-scope.mjs`
 * renames the whole suite in one pass, so any consumer that hardcoded the old
 * scope would silently stop recognising the suite's own bundles after a rename.
 * That is not hypothetical — the installer's bundle-sync step used to filter on
 * a literal `@patwoodman/`, so after a rename it left the previous scope in
 * `dsh.profile.bundles` and composed every row twice (M0-02). The majority
 * scope of `packages/*` is used, and pinned to the meta-bundle when present.
 */
export function ownScope(packages = loadPackages()) {
  const counts = new Map();
  for (const name of packages.keys()) {
    const m = /^(@[^/]+)\//.exec(name);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  // The meta-bundle is the one WITHOUT a member suffix (-core/-tools/-guard/…),
  // whatever its stem: the suite renamed from `orchestrator` to `dsh-sdlc-flow`,
  // and a stem literal would pin the scope to the wrong package (or none).
  for (const name of packages.keys()) {
    const m = /^(@[^/]+)\/(.+)$/.exec(name);
    if (!m) continue;
    if (/-core$|-tools$|-presets$|-ui$|-guard$|-cli$|-mock-llm$/.test(m[2])) continue;
    if (counts.get(m[1]) === Math.max(...counts.values())) return m[1];
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '@sdlc';
}

/** `@scope/` — the prefix that marks a bundle as this suite's own. */
export function ownBundlePrefix(packages = loadPackages()) {
  return `${ownScope(packages)}/`;
}

/**
 * Is `bundleName` one of THIS suite's bundles, whatever scope it carries?
 *
 * Matches on the slash-free basename against the workspace manifests, so a
 * bundle left behind under a scope the tree no longer uses (`@old-scope/...`,
 * `@new-scope/...`) is still recognised as ours. Filtering on the *current*
 * prefix alone would miss exactly the entries an upgrade has to clean up.
 */
export function isOwnBundleName(bundleName, packages = loadPackages()) {
  if (typeof bundleName !== 'string') return false;
  const m = /^@[^/]+\/(.+)$/.exec(bundleName);
  if (!m) return false;
  const base = m[1];
  for (const name of packages.keys()) {
    const own = /^@[^/]+\/(.+)$/.exec(name);
    if (own && own[1] === base) return true;
  }
  return false;
}

/** The patch files a package declares, normalized to an array (P1/C1). */
export function patchesOf(pkg, pkgDir) {
  const declared = pkg?.dsh?.bundle?.patch;
  const list = Array.isArray(declared) ? declared : declared ? [declared] : [];
  return list.map((p) => join(pkgDir, p));
}

/**
 * Rows declared by one patch file. A patch file is a YAML list of entries; each
 * entry is either `- insert:` with a list of rows or an id-targeted override
 * (`- id:` + `config:` WITHOUT a `name:` — PLAT-12 proves the id-targeted
 * form replaces a same-id row instead of appending a duplicate).
 *
 * One deliberate exception: the MEMBER sdlc-presets patch declares the
 * `agent-preset-registry` row (a FULL row: id + name + config) INSIDE its
 * insert: list. The platform dialect has no "insert if missing" — a bare
 * top-level row warns "entry not found" and is skipped — so the registry can
 * only reach headless/sdk profiles via insert:. The LEAD meta-bundle instead
 * carries an id-targeted override of the row the web template already ships;
 * a duplicate id+name is loader-accepted but blocks plugin-manager uninstall.
 * The static checker records both forms and allow-lists the lead override.
 */
export function loadPatchRows(patchPath) {
  const text = readFileSync(patchPath, 'utf8');
  const doc = parseYaml(text);
  if (!Array.isArray(doc)) throw new Error(`${patchPath}: a patch file must be a YAML list of entries`);
  const rows = [];
  const overrides = [];
  doc.forEach((entry, index) => {
    if (entry == null || typeof entry !== 'object') throw new Error(`${patchPath}: entry ${index} is not a mapping`);
    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) rows.push({ ...row, __form: 'insert' });
    } else if (entry.id && entry.config) {
      overrides.push({ ...entry, __form: 'id-override' });
    } else if (entry.remove !== undefined) {
      throw new Error(`${patchPath}: a patch declares \`remove:\`, which the dialect does not support (spec C.1)`);
    } else {
      throw new Error(`${patchPath}: entry ${index} is neither an insert list nor an id-targeted override`);
    }
  });
  return { rows, overrides, raw: text, doc };
}

/** Resolve a row's plugin `name` to a file in this repo; external names pass. */
export function resolveRowName(name, packages = loadPackages()) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: 'missing-name' };
  if (name.startsWith('@deepseek-ai/')) return { ok: true, external: true };
  const match = name.match(/^(@[^/]+\/[^/]+)(?:\/(.+))?$/);
  if (!match) return { ok: false, reason: `unparseable plugin name ${name}` };
  const [, pkgName, subpath] = match;
  const entry = packages.get(pkgName);
  if (!entry) return { ok: false, reason: `package ${pkgName} is not in this workspace` };
  if (!subpath) {
    const main = entry.pkg.main ?? 'lib/index.js';
    return existsSync(join(entry.dir, main))
      ? { ok: true, file: join(entry.dir, main) }
      : { ok: false, reason: `${pkgName} main ${main} does not exist` };
  }
  // Folded member rows: the meta-bundle copies its members' lib/ trees under
  // lib/rows/<member>/ and its patch points rows at `meta/rows/<member>[/<x>]`,
  // resolved through the member's own inner lib/ (see scripts/gen-bundle-patch.mjs).
  const folded = /^rows\/([a-z-]+)(?:\/(.+))?$/.exec(subpath);
  if (folded) {
    const [, member, rest] = folded;
    const stemDir = join(entry.dir, 'lib', 'rows', member, 'lib');
    if (!rest) {
      const main = join(stemDir, 'index.js');
      return existsSync(main)
        ? { ok: true, file: main }
        : { ok: false, reason: `${pkgName}/${subpath} does not resolve to a file` };
    }
    const candidates = [join(stemDir, `${rest}.js`), join(stemDir, rest, 'index.js')];
    const found = candidates.find((c) => existsSync(c));
    return found ? { ok: true, file: found } : { ok: false, reason: `${pkgName}/${subpath} does not resolve to a file` };
  }
  const candidates = [
    join(entry.dir, 'src', `${subpath}.js`),
    join(entry.dir, 'lib', `${subpath}.js`),
    join(entry.dir, subpath),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found) return { ok: true, file: found };
  // The loader resolves subpaths through the package `exports` map; the folded
  // meta-bundle (`@patwoodman/dsh-sdlc-flow/services`, `…/ui`, …) has no file at
  // the literal subpath — its exports map is the resolution.
  const exported = entry.pkg.exports?.[`./${subpath}`];
  const target = typeof exported === 'string' ? exported : typeof exported?.default === 'string' ? exported.default : null;
  if (target) {
    const file = join(entry.dir, target);
    if (existsSync(file)) return { ok: true, file };
  }
  return { ok: false, reason: `${pkgName}/${subpath} does not resolve to a file` };
}

/** All rows a profile composes, from its recipe's `bundles` list.
 *
 * ONLY the listed bundles contribute rows — this mirrors the loader exactly.
 * `loadProfileDirectory` iterates `package.json`'s `dsh.profile.bundles` and,
 * for each name, loads that package's own `dsh.bundle.patch` files. It does NOT
 * descend into a bundle's `dependencies`: a dependency that happens to declare
 * `dsh.bundle.patch` is an ordinary npm dependency whose patch is never mounted
 * unless the profile also lists it as a bundle.
 *
 * An earlier version recursed into dependencies "so the static composition
 * matches what pnpm + the loader compose live". That was wrong and expensive:
 * it let the static gate report a complete lead for the `['@patwoodman/dsh-sdlc-flow']`
 * recipe while a live single-spec install composed only the meta-bundle's own
 * row. A bundle that is meant to supply rows must declare them in its own
 * patch — see `@patwoodman/dsh-sdlc-flow`, whose patch is generated as the union of
 * its members' rows by scripts/gen-bundle-patch.mjs.
 */
export function composeProfile(profile, { packages = loadPackages(), seen = new Set() } = {}) {
  const rows = [];
  const problems = [];
  const bundleDirs = [];
  // A bundle listed twice at the same level composes twice (the loader applies
  // each listed layer), which is what lets the M0-02 negative control detect a
  // duplicated bundle.
  const explicit = new Set();
  for (const bundleName of profile.bundles ?? []) {
    const isRepeat = explicit.has(bundleName);
    explicit.add(bundleName);
    const entry = packages.get(bundleName);
    if (!entry) { problems.push(`bundle ${bundleName} is not in this workspace`); continue; }
    if (seen.has(bundleName) && !isRepeat) continue;
    seen.add(bundleName);
    bundleDirs.push(entry.dir);
    for (const patchPath of patchesOf(entry.pkg, entry.dir)) {
      if (!existsSync(patchPath)) { problems.push(`${bundleName}: declared patch ${patchPath} is missing`); continue; }
      const { rows: patchRows, overrides } = loadPatchRows(patchPath);
      for (const row of patchRows) rows.push({ ...row, __bundle: bundleName, __patch: patchPath });
      // Pure config overrides (id + config, no name) in a BUNDLE patch are
      // unexpected — the tier overlay is the sanctioned override path. The one
      // exception is a shipped row a bundle must co-configure rather than
      // duplicate: the web template ships `agent-preset-registry`, and a
      // second same-id/same-name insert blocks plugin-manager uninstall.
      for (const o of overrides) {
        if (o.__form !== 'id-override') continue;
        if (isSanctionedBundleOverride(o)) continue;
        problems.push(`${bundleName}: unexpected id-targeted override ${o.id} in a bundle patch`);
      }
    }
  }

  const counts = new Map();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([id, n]) => ({ id, n }));

  const unresolved = [];
  for (const row of rows) {
    const resolved = resolveRowName(row.name, packages);
    if (!resolved.ok) unresolved.push({ id: row.id, name: row.name, reason: resolved.reason });
  }

  return {
    profile: profile.name,
    bundles: profile.bundles ?? [],
    bundleDirs,
    rows,
    ids: rows.map((r) => r.id),
    duplicates,
    unresolved,
    problems,
    presetRows: rows.filter((r) => /^preset-sdlc-/.test(String(r.id))),
  };
}

/** Every profile recipe under profiles/. */
export function loadProfiles(root = ROOT) {
  const dir = join(root, 'profiles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name, 'profile.json'))
    .filter((p) => existsSync(p) && statSync(p).isFile())
    .map((p) => ({ ...JSON.parse(readFileSync(p, 'utf8')), __path: p }));
}

/**
 * The full static verdict for one profile.
 * @returns {{ok:boolean, problems:string[], composition:object}}
 */
export function validateProfileStatic(profile, { packages = loadPackages() } = {}) {
  const problems = [];
  if (!['acp', 'web', 'headless', 'sdk', 'sdk-minimal'].includes(profile.template)) {
    problems.push(`template "${profile.template}" is not in the closed set (errata E2)`);
  }
  const composition = composeProfile(profile, { packages });
  problems.push(...composition.problems);
  for (const dup of composition.duplicates) problems.push(`duplicate loader row id ${dup.id} (x${dup.n})`);
  for (const u of composition.unresolved) problems.push(`row ${u.id}: ${u.reason}`);
  for (const forbidden of profile.mustNotContain ?? []) {
    if ((profile.bundles ?? []).includes(forbidden)) problems.push(`${profile.name} must not contain ${forbidden}`);
  }
  // E6: a WORKER profile may not compose the host bundle (directly or via a
  // bundle that needs it) — mounting sdlc-core in a worker starts a second
  // scheduler and a second writer against sdlc.db.
  if (profile.role === 'headless-worker') {
    const packages = loadPackages();
    for (const bundle of profile.bundles ?? []) {
      const m = /^@[^/]+\/(.+)$/.exec(bundle);
      if (m && m[1] === workerForbiddenBasename(packages) && isOwnBundleName(bundle, packages)) {
        problems.push(`${profile.name} composes host bundle ${bundle} — mounting sdlc-core in a worker starts a second scheduler (E6)`);
      }
    }
  }
  return { ok: problems.length === 0, problems, composition };
}

/** Validate every profile; used by the M0 gate, doctor and the installer. */
export function validateAllProfiles(root = ROOT) {
  const profiles = loadProfiles(root);
  return profiles.map((p) => ({ profile: p, ...validateProfileStatic(p, { packages: loadPackages(root) }) }));
}

/** Rows declared by every patch file in the workspace (for cross-checks). */
export function allPatchRows(root = ROOT) {
  const packages = loadPackages(root);
  const out = [];
  for (const [name, entry] of packages) {
    for (const patchPath of patchesOf(entry.pkg, entry.dir)) {
      if (!existsSync(patchPath)) { out.push({ bundle: name, patch: patchPath, missing: true, rows: [] }); continue; }
      const { rows } = loadPatchRows(patchPath);
      out.push({ bundle: name, patch: patchPath, rows, missing: false });
    }
  }
  return out;
}

export default {
  ROOT, loadPackages, patchesOf, loadPatchRows, resolveRowName, composeProfile,
  loadProfiles, validateProfileStatic, validateAllProfiles, allPatchRows,
};
