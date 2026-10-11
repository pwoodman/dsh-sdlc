/**
 * packages/sdlc-core/src/glob-lite.js — the glob dialect (spec v3 C.7.3), copied.
 *
 * WHY COPIED, NOT IMPORTED: `sdlc-core` and `sdlc-guard` are deliberately
 * separate packages (errata E6) so that `sdlc-core` — which must never run in a
 * worker profile — has no runtime dependency on the worker-side package and
 * vice versa. The dialect is ~70 lines, frozen at version 1.0.0, and published
 * as a JSON Schema on both sides; the duplication is intentional and is pinned
 * by a cross-package equivalence property test (tests/unit/glob.test.mjs).
 */

export const GLOB_DIALECT_VERSION = '1.0.0';

const FULLWIDTH = /[\uFF0E\u2024\uFE52\uFF61]/g;

export function defaultCaseInsensitive() {
  return process.platform === 'darwin' || process.platform === 'win32';
}

export function normalizePath(input, { caseInsensitive = defaultCaseInsensitive() } = {}) {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'empty-path' };
  if (input.includes('\0')) return { ok: false, reason: 'nul-byte' };
  let p = input.normalize('NFKC').replace(FULLWIDTH, '.').replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
  if (p.startsWith('/')) return { ok: false, reason: 'absolute-path' };
  if (/^[A-Za-z]:\//.test(p)) return { ok: false, reason: 'absolute-path' };
  if (/^~/.test(p)) return { ok: false, reason: 'home-relative-path' };
  for (const seg of p.split('/')) {
    if (seg === '..') return { ok: false, reason: 'traversal' };
  }
  if (p === '.' || p === '') return { ok: false, reason: 'traversal' };
  return { ok: true, path: caseInsensitive ? p.toLowerCase() : p };
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern, { caseInsensitive = defaultCaseInsensitive() } = {}) {
  let p = String(pattern).normalize('NFKC').replace(FULLWIDTH, '.').replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
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
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '[') out += '\\[';
    else out += ch.replace(REGEX_SPECIALS, '\\$&');
  }
  return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '');
}

export function matchGlob(pattern, path, opts = {}) {
  const norm = normalizePath(path, opts);
  if (!norm.ok) return false;
  return globToRegExp(pattern, opts).test(norm.path);
}

export function matchAny(patterns, path, opts = {}) {
  for (const p of asArray(patterns)) if (matchGlob(p, path, opts)) return p;
  return null;
}

export function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length > 0) : [value];
}
