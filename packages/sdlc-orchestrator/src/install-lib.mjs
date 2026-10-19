/**
 * packages/sdlc-orchestrator/src/install-lib.mjs — pure text helpers for the
 * registry installer. Kept separate from `install.mjs` so tests can import it
 * without running the CLI.
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/**
 * Normalize `minimumReleaseAgeExclude` in a pnpm-workspace.yaml body and add
 * exact-version entries for the suite.
 *
 * pnpm accepts ONE `name@version` pattern per list item. A value such as
 * `@patwoodman/dsh-sdlc-flow@0.4.0-beta.19 || 0.4.0-beta.20` (written by an
 * earlier install path) is not a valid pattern, so pnpm ignores the exemption
 * and a fresh beta silently resolves to the previous one. This splits such
 * entries into valid items, carries the package name onto a bare version, adds
 * the requested specs, deduplicates, sorts, and leaves every other setting in
 * the file untouched.
 *
 * @param {string} text - existing pnpm-workspace.yaml (may be empty).
 * @param {string[]} specs - exact `name@version` patterns to add.
 * @returns {string} the rewritten YAML body with a trailing newline.
 */
export function normalizeReleaseAgeExcludes(text, specs) {
  const lines = String(text ?? '').split('\n');
  const wanted = [];
  const kept = [];
  const add = (raw) => {
    for (const entry of expandReleaseAgeEntry(raw)) wanted.push(entry);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^minimumReleaseAgeExclude:\s*(.*)$/.exec(lines[index]);
    if (match === null) {
      kept.push(lines[index]);
      continue;
    }
    // Inline forms (`[]`, `[a@1, b@2]`) and block list forms are both valid
    // YAML. The original regex only matched the empty-value form, so an
    // existing `minimumReleaseAgeExclude: []` gained a SECOND key.
    const inline = match[1].trim();
    if (inline !== '' && !inline.startsWith('#')) {
      const body = inline.replace(/^\[/, '').replace(/\]$/, '');
      for (const part of body.split(',')) add(part);
    }
    let next = index + 1;
    while (next < lines.length && (/^\s*-\s+/.test(lines[next]) || lines[next].trim() === '')) {
      const raw = lines[next].replace(/^\s*-\s+/, '').trim();
      if (raw !== '' && !raw.startsWith('#')) add(raw);
      next += 1;
    }
    index = next - 1;
  }

  wanted.push(...specs);
  const unique = [...new Set(wanted.filter(Boolean))].sort();
  kept.push('minimumReleaseAgeExclude:');
  for (const spec of unique) kept.push(`  - '${spec}'`);
  return `${kept.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Split one exemption entry into valid pnpm patterns.
 *
 * Accepts the malformed `pkg@old || pkg@new` / `pkg@old || new` forms written
 * by earlier installers, strips quotes and trailing comments, and returns one
 * `name@version` pattern per entry.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function expandReleaseAgeEntry(raw) {
  const value = String(raw ?? '')
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  const out = [];
  let packageName = null;
  for (const part of value.split(/\s*\|\|\s*/)) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const named = /^((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(trimmed);
    if (named) {
      packageName = named[1];
      out.push(trimmed);
    } else if (packageName && /^[0-9]/.test(trimmed)) {
      out.push(`${packageName}@${trimmed}`);
    } else {
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Parse a semver string (the subset npm uses for these packages).
 *
 * @param {string} value version, optionally prefixed with `v`
 * @returns {{major:number, minor:number, patch:number, prerelease:string[]}|null}
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * Compare two semver versions, including prerelease ordering.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} -1, 0, or 1
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) {
    throw new Error(`compareVersions: not a semver version: ${a === null ? left : right}`);
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** The npm dist-tag a currently installed version follows. */
export function channelForVersion(version) {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.prerelease.length > 0 ? 'beta' : 'latest';
}

/**
 * Whether a profile dependency came from the npm registry (as opposed to a
 * local path, link, git checkout or tarball). Auto-update must never replace a
 * developer's link.
 *
 * @param {unknown} source - `BundleInfo.source` from the DSH plugin manager
 * @returns {boolean}
 */
export function isRegistrySource(source) {
  if (typeof source !== 'string' || source.trim() === '') return false;
  const spec = source.trim();
  if (/^(link|file|workspace|portal):/i.test(spec)) return false;
  if (/^(git\+|git@|github:|gitlab:|bitbucket:)/i.test(spec)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) return false;
  if (/^(\.{0,2}\/|~[\\/]|[A-Za-z]:[\\/])/.test(spec)) return false;
  // An npm alias or a version/range/tag: both are registry specs.
  return true;
}

/**
 * Whether a periodic update check is due.
 *
 * @param {number|null|undefined} lastCheckedAt epoch milliseconds of the last successful check
 * @param {number} now epoch milliseconds
 * @param {number} intervalMs minimum time between checks
 * @returns {boolean}
 */
export function shouldCheckForUpdate(lastCheckedAt, now, intervalMs) {
  if (!Number.isFinite(lastCheckedAt)) return true;
  if (!Number.isFinite(now) || !Number.isFinite(intervalMs)) return true;
  // A clock that moved backwards also forces a check; otherwise a future
  // timestamp from a clock skew would suppress updates forever.
  return now < lastCheckedAt || now - lastCheckedAt >= intervalMs;
}

/**
 * Decide what to do about a newer published version.
 *
 * @param {object} input
 * @param {string} input.currentVersion installed version
 * @param {string|null} input.latestVersion newest version for the channel
 * @param {string} [input.source] profile dependency spec
 * @returns {{action:'up-to-date'|'update'|'skip', reason?:string, version?:string}}
 */
export function updateDecision({ currentVersion, latestVersion, source, allowMajor = false }) {
  if (!latestVersion) return { action: 'skip', reason: 'no-latest' };
  if (!isRegistrySource(source)) return { action: 'skip', reason: 'non-registry-install' };
  let comparison;
  try {
    comparison = compareVersions(latestVersion, currentVersion);
  } catch {
    return { action: 'skip', reason: 'unparsable-version' };
  }
  if (comparison <= 0) return { action: 'up-to-date' };
  // A major release is a product decision, not a background side effect. The
  // installer / `--check` still reports it; auto-update does not install it
  // unless the profile explicitly opts in (SDLC_ALLOW_MAJOR_UPDATE=1).
  if (!allowMajor) {
    const current = parseVersion(currentVersion);
    const latest = parseVersion(latestVersion);
    if (current !== null && latest !== null && latest.major > current.major) {
      return { action: 'skip', reason: 'major-update-requires-consent', version: latestVersion };
    }
  }
  return { action: 'update', version: latestVersion };
}

/** The basename of a package name, e.g. `@scope/pkg` → `pkg`. */
export function packageBasename(name) {
  return String(name ?? '').split('/').at(-1) ?? '';
}

/**
 * Whether a dependency is one of this suite's packages, including legacy
 * member packages left by older releases and the pre-rename `orchestrator`
 * family. Used to prune ghosts before an upgrade.
 *
 * @param {string} name dependency name
 * @param {string} metaName current meta-bundle package name
 * @param {string[]} memberNames current member package names
 * @returns {boolean}
 */
export function isSuitePackage(name, metaName, memberNames = []) {
  const base = packageBasename(name);
  const known = new Set([packageBasename(metaName), ...memberNames.map(packageBasename)]);
  if (known.has(base)) return true;
  return /^(orchestrator|dsh-sdlc-flow)(-core|-tools|-presets|-ui|-guard|-cli|-mock-llm)?$/.test(base);
}

/**
 * Remove this suite's packages from a dependency map, keeping the packages the
 * caller explicitly wants.
 *
 * @param {Record<string,string>} dependencies
 * @param {object} options
 * @param {string} options.metaName current meta-bundle name
 * @param {string[]} [options.memberNames] current member names
 * @param {string[]} [options.keep] package names to keep
 * @returns {{dependencies:Record<string,string>, removed:string[]}}
 */
export function pruneSuiteDependencies(dependencies, { metaName, memberNames = [], keep = [] }) {
  const kept = new Set(keep);
  const removed = [];
  const next = {};
  for (const [name, spec] of Object.entries(dependencies ?? {})) {
    if (!kept.has(name) && isSuitePackage(name, metaName, memberNames)) {
      removed.push(name);
      continue;
    }
    next[name] = spec;
  }
  return { dependencies: next, removed };
}

/**
 * Keep every non-suite bundle and replace the suite's own selection with the
 * recipe's list. This is the upgrade path from a profile that selected the
 * meta-bundle plus its members.
 *
 * @param {string[]} current selected bundle names
 * @param {string[]} wanted suite bundles for this profile
 * @param {object} options
 * @param {string} options.metaName current meta-bundle name
 * @param {string[]} [options.memberNames] current member names
 * @returns {{bundles:string[], removed:string[]}}
 */
export function syncSuiteBundles(current, wanted, { metaName, memberNames = [] }) {
  const kept = (current ?? []).filter((name) => !isSuitePackage(name, metaName, memberNames));
  const removed = (current ?? []).filter((name) => isSuitePackage(name, metaName, memberNames) && !wanted.includes(name));
  return { bundles: [...kept, ...wanted], removed };
}


/** Write a file through a same-directory temp + fsync + rename (never torn). */
export function writeFileAtomic(path, content, { mode = 0o644 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Cross-process installer lock. A second install/update exits INSTALL_LOCKED
 * instead of interleaving read-modify-write on the profile files. A lock from a
 * dead pid or older than `staleMs` is reclaimed.
 *
 * @param {string} lockPath
 * @param {object} [options]
 * @returns {() => void} release
 */
export function acquireInstallLock(lockPath, {
  now = () => Date.now(),
  staleMs = 10 * 60 * 1000,
  isAlive = pidAlive,
} = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: now(), token });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (current?.token === token) unlinkSync(lockPath);
        } catch { /* another owner or already released */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { holder = null; }
      const startedAt = Number(holder?.startedAt);
      const stale = holder === null
        || !Number.isFinite(startedAt)
        || now() - startedAt > staleMs
        || !isAlive(Number(holder.pid));
      if (!stale) {
        const locked = new Error(
          `INSTALL_LOCKED: another installer (pid ${holder.pid ?? '?'} on ${holder.host ?? '?'}) is running; `
          + 'wait for it to finish or remove the lock if it is stale',
        );
        locked.code = 'INSTALL_LOCKED';
        locked.holder = holder;
        throw locked;
      }
      try { unlinkSync(lockPath); } catch { /* raced with the owner */ }
    }
  }
  const error = new Error('INSTALL_LOCKED: could not acquire the installer lock');
  error.code = 'INSTALL_LOCKED';
  throw error;
}

/** Host command shape for `dsh` on POSIX vs Windows (dsh.cmd needs cmd.exe). */
export function resolveDshSpawn(argv = [], { platform = process.platform, comspec = process.env.ComSpec } = {}) {
  if (platform === 'win32') {
    return { command: comspec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'dsh.cmd', ...argv], shell: false };
  }
  return { command: 'dsh', args: [...argv], shell: false };
}
