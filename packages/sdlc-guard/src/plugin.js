/**
 * packages/sdlc-guard/src/plugin.js — the DSH-side of the guard (spec v3 C.7, C.9).
 *
 * Registers, in BOTH the lead and worker compositions:
 *   - a `tools/pre-execute` waterfall listener (PreToolDecision allow|deny|cancel|ask)
 *   - `fs/*` intent deciders for write intent
 *
 * The plugin is deliberately defensive: it feature-detects the host API surface
 * so the module can be imported (and its policy unit-tested) without a DSH boot.
 * Nothing here is a security boundary — see ./index.js for the normative note.
 *
 * The guard OWNS the path/command policy, so it — not sdlc-core — reports the
 * policy through the `SDLC_SELFTEST` boot hook (C.9). sdlc-core contributes a
 * placeholder only when the guard is not composed.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GuardPlugin, guardForContract, DEFAULT_FORBIDDEN_PATTERNS,
  PROTECTED_ORCHESTRATOR_PATHS, ORCHESTRATOR_PATHS,
} from './index.js';
import { contributeSelftest, setSelftestMeta } from './selftest.js';

export const CONTRACT_PATH = '.sdlc/task-contract.json';

const BASH_TOOLS = new Set(['bash', 'shell', 'run_command', 'terminal']);

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

/** Read the task contract materialized by the orchestrator before worker launch. */
export function loadContract(worktreeRoot, contractPath = CONTRACT_PATH) {
  try {
    return JSON.parse(readFileSync(join(worktreeRoot, contractPath), 'utf8'));
  } catch {
    return null;
  }
}

export function guardFromWorktree(worktreeRoot, config = {}) {
  const contract = loadContract(worktreeRoot) ?? {};
  return guardForContract(contract, {
    mode: config.guardMode ?? 'deny',
    forbidden_patterns: config.guardForbiddenPatterns,
    orchestratorPaths: config.orchestratorPaths,
    protectedOrchestratorPaths: config.protectedOrchestratorPaths,
    worktreeRoot,
  });
}

/**
 * Extract candidate paths from a tool call. Handles the shapes the fs and bash
 * tools actually use; returns `[]` when nothing path-shaped is present.
 */
export function pathsFromToolCall(toolName, args = {}) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v) out.push(v); };
  push(args.path);
  push(args.file_path);
  push(args.filePath);
  push(args.target);
  push(args.to);
  push(args.from);
  if (Array.isArray(args.paths)) args.paths.forEach(push);
  if (Array.isArray(args.files)) args.files.forEach(push);
  return out;
}

export function isBashTool(toolName) {
  return BASH_TOOLS.has(toolName);
}

/**
 * Pure decision function — the single place the policy is applied to a tool
 * call. Returned shape matches `PreToolDecision`.
 */
export function decideToolCall(guard, { toolName, args = {} } = {}) {
  if (isBashTool(toolName)) {
    const command = args.command ?? args.cmd ?? args.script ?? '';
    const decision = guard.decideCommand(command);
    return decision.kind === 'deny'
      ? { kind: 'deny', reason: `sdlc-guard: ${decision.reason}` }
      : { kind: 'allow' };
  }
  for (const p of pathsFromToolCall(toolName, args)) {
    // L.4 T11: resolve symlinks so an in-scope-looking path cannot point
    // outside the worktree. Requires the guard to know its worktree root.
    const decision = guard.policy.worktreeRoot
      ? guard.decideFsWriteReal(p)
      : guard.decideFsWrite(p);
    if (decision.kind === 'deny') return { kind: 'deny', reason: `sdlc-guard: ${decision.reason} (${p})` };
  }
  return { kind: 'allow' };
}

function recordDenial(worktreeRoot, entry) {
  try {
    const dir = join(worktreeRoot, '.sdlc');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'guard-denials.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* evidence-only; never fatal */ }
}

/**
 * Install the guard on a DSH context. Returns the guard even when the host API
 * is absent, so callers can still use it programmatically.
 */
export function installGuard(ctx, config = {}) {
  const worktreeRoot = config.worktreeRoot ?? process.cwd();
  const guard = guardFromWorktree(worktreeRoot, config);

  const handler = async (event) => {
    const decision = decideToolCall(guard, event);
    if (decision.kind === 'deny') recordDenial(worktreeRoot, { ...decision, toolName: event?.toolName });
    return decision;
  };

  try {
    if (typeof ctx?.on === 'function') ctx.on('tools/pre-execute', handler);
    else if (typeof ctx?.waterfall === 'function') ctx.waterfall('tools/pre-execute', handler);
    if (typeof ctx?.provide === 'function') {
      ctx.provide('sdlcGuard', { guard, decideToolCall: (call) => decideToolCall(guard, call) });
    }
    if (ctx?.logger?.debug) ctx.logger.debug('sdlc-guard: installed (worktree=%s)', worktreeRoot);
  } catch (err) {
    // A guard that cannot register must not silently permit: log loudly.
    if (ctx?.logger?.warn) ctx.logger.warn('sdlc-guard: failed to register: %s', err?.message ?? err);
  }

  return guard;
}

export function apply(ctx, config = {}) {
  setSelftestMeta({ version: pkgVersion() });
  const guard = installGuard(ctx, config);
  contributeSelftest({
    guard: {
      orchestratorPaths: guard.policy.orchestratorPaths ?? ORCHESTRATOR_PATHS,
      forbiddenPatterns: guard.policy.forbidden_patterns ?? DEFAULT_FORBIDDEN_PATTERNS,
      protectedOrchestratorPaths: guard.policy.protectedOrchestratorPaths ?? PROTECTED_ORCHESTRATOR_PATHS,
    },
  });
  return guard;
}

export default apply;

export { GuardPlugin, ORCHESTRATOR_PATHS, PROTECTED_ORCHESTRATOR_PATHS };
