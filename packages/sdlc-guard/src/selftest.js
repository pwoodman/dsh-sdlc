/**
 * selftest.js — deterministic boot hook (spec v3 C.9).
 *
 * There is NO CLI for listing registered tools/commands (verification Q8), and
 * asking a model is neither deterministic nor free. This module implements the
 * `SDLC_SELFTEST` hook: when the env var is an ABSOLUTE path, the plugin suite
 * writes a registration report there.
 *
 * Contract and limits:
 *   - inert unless `SDLC_SELFTEST` is an absolute path; a non-absolute or
 *     unwritable path is a start-up error, never a silent pass;
 *   - the hook reports REGISTRATION ONLY — behaviour is covered by tests;
 *   - the report is flushed only after the composition goes quiet (debounced),
 *     so it is independent of bundle load order.
 *
 * NOTE: this file is intentionally duplicated verbatim in sdlc-core, sdlc-tools
 * and sdlc-presets. Those packages must remain independently installable (E6):
 * the worker profile has sdlc-tools WITHOUT sdlc-core. The shared state lives on
 * globalThis, so every copy contributes to one report.
 */

import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const STATE_KEY = '__SDLC_SELFTEST_STATE__';
const FLUSH_DELAY_MS = 50;

function state() {
  const g = globalThis;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      version: null,
      dsh: null,
      tools: new Set(),
      commands: new Set(),
      services: new Set(),
      presets: new Set(),
      guard: {},
      timer: null,
      written: false,
    };
  }
  return g[STATE_KEY];
}

/** Set the runtime/DSH versions exactly once. */
export function setSelftestMeta({ version = null, dsh = null } = {}) {
  const s = state();
  if (version) s.version = version;
  if (dsh) s.dsh = dsh;
}

/** Contribute registration names. Safe to call from any package's apply(). */
export function contributeSelftest({ tools = [], commands = [], services = [], presets = [], guard = null } = {}) {
  const s = state();
  for (const t of tools) s.tools.add(t);
  for (const c of commands) s.commands.add(c);
  for (const sv of services) s.services.add(sv);
  for (const p of presets) s.presets.add(p);
  if (guard) {
    // MERGE, do not clobber: a later contributor that does not know the policy
    // (sdlc-core contributes a placeholder) must not overwrite a richer value
    // already reported by the owner (sdlc-guard). An empty array never wins
    // over a populated one.
    const merged = { ...s.guard };
    for (const [k, v] of Object.entries(guard)) {
      const isEmpty = v == null || (Array.isArray(v) && v.length === 0);
      if (isEmpty && Array.isArray(merged[k]) && merged[k].length > 0) continue;
      if (isEmpty && merged[k] !== undefined) continue;
      merged[k] = v;
    }
    s.guard = merged;
  }

  if (!process.env.SDLC_SELFTEST) return null;

  if (!isAbsolute(process.env.SDLC_SELFTEST)) {
    throw new Error(`SDLC_SELFTEST must be an absolute path (got "${process.env.SDLC_SELFTEST}")`);
  }
  clearTimeout(s.timer);
  s.timer = setTimeout(flushSelftest, FLUSH_DELAY_MS);
  if (typeof s.timer?.unref === 'function') s.timer.unref();
  return s.timer;
}

export function buildSelftestReport() {
  const s = state();
  const sort = (set) => [...set].sort();
  return {
    version: s.version,
    dsh: s.dsh,
    tools: sort(s.tools),
    commands: sort(s.commands),
    services: sort(s.services),
    presets: sort(s.presets),
    guard: {
      orchestratorPaths: s.guard.orchestratorPaths ?? ['.sdlc/**', '.dsh/**'],
      patterns: s.guard.forbiddenPatterns ?? s.guard.patterns ?? [],
      forbiddenPatterns: s.guard.forbiddenPatterns ?? s.guard.patterns ?? [],
    },
  };
}

/** Write the report. Exported so the M0 harness can force a flush in tests. */
export function flushSelftest() {
  const path = process.env.SDLC_SELFTEST;
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error(`SDLC_SELFTEST must be an absolute path (got "${path}")`);
  const report = buildSelftestReport();
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  state().written = true;
  return report;
}

export function selftestWritten() {
  return state().written;
}

export default { contributeSelftest, setSelftestMeta, flushSelftest, buildSelftestReport };
