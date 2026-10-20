/**
 * scripts/lib/release-excludes.mjs — pure release-artifact exclusion rules.
 *
 * `build-release.mjs` copies the checkout into a staged tree and tars it. The
 * copy must exclude everything git ignores (DSH homes, evaluation output,
 * package stores) except the prebuilt `lib/` trees the artifact exists to ship.
 *
 * This module exists because the original inline parser silently matched
 * nothing: `git status --porcelain --ignored=matching -z` emits `!! path`, but
 * the parser required `! path` (entry[1] === ' '). The fallback list then missed
 * `.pnpm-store`, so an 11 MiB pnpm store (including a previous release tarball)
 * travelled to every beta tester. Pure functions make that class testable.
 */

/** Paths that must never travel in a release artifact, even outside git. */
export const RELEASE_EXCLUDE = [
  '.git', 'node_modules', '.tools', '.validation', '.sdlc', '.probe-dsh', 'dist',
  '.pnpm-store', 'pnpm-store',
  '.eval-home', '.eval-tarball-home', '.eval-tarball-home2', '.eval-out', '.eval-out-live', '.eval-out-pilot',
  '.eval-out-shard0', '.eval-out-shard1', '.eval-out-merged',
  // The repo keeps no workspace lockfile (zero-dependency build); a stray one
  // must not travel in a release artifact where it would look authoritative.
  'pnpm-lock.yaml',
];

/** Ignored build output that the artifact MUST carry (prebuilt host entries). */
export const RELEASE_KEEP_IGNORED = [
  /^packages\/[^/]+\/lib(\/|$)/,
  /^lib(\/|$)/,
];

/** Any `.eval-*` scratch home is excluded by prefix as well as by exact name. */
export function isScratchPath(rel) {
  return /(^|\/)\.eval-[^/]+(\/|$)/.test(rel);
}

/**
 * Parse `git status --porcelain --ignored=matching -z` output into the set of
 * ignored paths. Only `!! ` entries are ignored; `?? ` (untracked) and ` M`
 * (modified) are not, because those must be reviewed/committed, not silently
 * dropped from the artifact.
 *
 * @param {string} stdout
 * @returns {Set<string>} repo-relative POSIX paths without trailing slashes
 */
export function parseIgnoredPaths(stdout) {
  const set = new Set();
  for (const entry of String(stdout ?? '').split('\0')) {
    if (!entry.startsWith('!! ')) continue;
    const path = entry.slice(3).replace(/\/+$/, '');
    if (path !== '') set.add(path);
  }
  return set;
}

/**
 * Build the `excluded(rel) -> boolean` predicate used by the copy filter.
 *
 * A path is excluded when it is ignored by git (or is a known scratch path) and
 * is not one of the kept build-output prefixes, or when it matches the static
 * fallback list. An ancestor match excludes the whole subtree.
 *
 * @param {object} [options]
 * @param {Set<string>|null} [options.ignored] paths from `parseIgnoredPaths`
 * @param {string[]} [options.exclude] static fallback prefixes
 * @param {RegExp[]} [options.keepIgnored] ignored prefixes that must travel
 * @returns {(rel: string) => boolean}
 */
export function makeReleaseExcluder({
  ignored = null,
  exclude = RELEASE_EXCLUDE,
  keepIgnored = RELEASE_KEEP_IGNORED,
} = {}) {
  const keep = (rel) => keepIgnored.some((re) => re.test(rel));
  return function excluded(rel) {
    const posix = String(rel ?? '').split('\\').join('/');
    if (posix === '') return false;
    if (isScratchPath(posix) && !keep(posix)) return true;
    if (ignored && !keep(posix)) {
      const parts = posix.split('/');
      for (let i = 1; i <= parts.length; i += 1) {
        if (ignored.has(parts.slice(0, i).join('/'))) return true;
      }
    }
    return exclude.some((entry) => posix === entry || posix.startsWith(`${entry}/`));
  };
}
