/**
 * packages/sdlc-guard/src/glob.js — the fixed glob dialect of spec v3 C.7.3.
 *
 * Dialect (published as a versioned JSON Schema in schema/path-policy.schema.json):
 *   `*`   matches within one path segment (never `/`)
 *   `**`  matches across segments, including zero
 *   `?`   matches a single character within a segment
 *   a leading `./` is stripped; matching is on the repo-relative POSIX path
 *
 * Normalization is idempotent and NFKC-based, so full-width and compatibility
 * forms of `..` (a documented traversal trick) normalize to `..` before the
 * safety check runs.
 */

export const GLOB_DIALECT_VERSION = '1.0.0';

const FULLWIDTH = /[\uFF0E\u2024\uFE52\uFF61]/g; // ．․﹒｡ — dot variants

/**
 * Normalize a candidate path. Returns `{ ok, path }`; `ok:false` means the path
 * is unsafe (absolute, traversal, NUL) and MUST be denied.
 */
export function normalizePath(input, { caseInsensitive = defaultCaseInsensitive() } = {}) {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'empty-path' };
  if (input.includes('\0')) return { ok: false, reason: 'nul-byte' };

  let p = input.normalize('NFKC').replace(FULLWIDTH, '.');
  p = p.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  // Repeatedly strip leading `./` introduced by NFKC.
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);

  if (p.startsWith('/')) return { ok: false, reason: 'absolute-path' };
  if (/^[A-Za-z]:\//.test(p)) return { ok: false, reason: 'absolute-path' };
  if (/^~/.test(p)) return { ok: false, reason: 'home-relative-path' };

  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '..') return { ok: false, reason: 'traversal' };
    if (seg === '.' && segments.length > 1) return { ok: false, reason: 'traversal' };
  }
  if (p === '..' || p === '.') return { ok: false, reason: 'traversal' };

  p = caseInsensitive ? p.toLowerCase() : p;
  return { ok: true, path: p };
}

export function defaultCaseInsensitive() {
  return process.platform === 'darwin' || process.platform === 'win32';
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Compile one glob pattern to an anchored RegExp. */
export function globToRegExp(pattern, { caseInsensitive = defaultCaseInsensitive() } = {}) {
  let p = String(pattern).normalize('NFKC').replace(FULLWIDTH, '.').replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (caseInsensitive) p = p.toLowerCase();
  if (p === '') return /^$/;

  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '*') {
      let stars = 0;
      while (p[i] === '*') { stars += 1; i += 1; }
      i -= 1;
      if (stars >= 2) {
        if (p[i + 1] === '/') { out += '(?:.*/)?'; i += 1; } else out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      // Character classes are not part of the dialect; treat literally.
      out += '\\[';
    } else {
      out += ch.replace(REGEX_SPECIALS, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '');
}

const cache = new Map();

/** True when `path` matches `pattern` under the dialect. */
export function matchGlob(pattern, path, opts = {}) {
  const key = `${pattern}\u0000${opts.caseInsensitive ?? defaultCaseInsensitive()}`;
  let re = cache.get(key);
  if (!re) { re = globToRegExp(pattern, opts); cache.set(key, re); }
  const norm = normalizePath(path, opts);
  if (!norm.ok) return false;
  return re.test(norm.path);
}

/** True when any pattern matches. `patterns` is normalized to an array. */
export function matchAny(patterns, path, opts = {}) {
  for (const p of asArray(patterns)) if (matchGlob(p, path, opts)) return p;
  return null;
}

export function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length > 0) : [value];
}
