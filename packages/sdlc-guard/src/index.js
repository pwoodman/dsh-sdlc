/**
 * packages/sdlc-guard/src/index.js — pure policy matcher (spec v3 C.7).
 *
 * WHAT THIS IS (normative, spec v3 L.3):
 *   `sdlc-sandbox-policy` governs FILE EFFECTS ONLY. The worker's sandbox root
 *   is the worktree, so the sandbox — not this module — makes writes outside
 *   the worktree impossible. This module is a *policy* layer that keeps a
 *   cooperative worker inside its declared `allowed_paths` and blocks a
 *   documented list of destructive commands. Command-string matching is
 *   defence-in-depth and is defeatable (`bash -c`, `python -c`, `git apply`,
 *   encodings). The authoritative controls are (a) the sandbox root and
 *   (b) the post-hoc git diff (`out_of_scope_files` ⇒ SCOPE_VIOLATION).
 *
 * The matcher is importable and unit-testable without a DSH boot — that is what
 * `scripts/validate-m0.mjs` (M0-07-guard) and tests/unit/guard.test.mjs import.
 */

import { asArray, defaultCaseInsensitive, matchAny, normalizePath } from './glob.js';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export { globToRegExp, matchGlob, matchAny, normalizePath } from './glob.js';

/**
 * Symlink/TOCTOU containment (spec v3 L.4 T11).
 *
 * The lexical matcher cannot see a symlink whose target is outside the worktree
 * (`link/secret.txt` is lexically in-scope). This helper resolves the nearest
 * EXISTING ancestor with `realpath` and reports whether the resolved path
 * escapes `root`. It is applied by the plugin layer, not by the pure matcher —
 * the lexical decision is unchanged, which keeps `checkFsWrite` pure.
 */
export function escapesRoot(candidatePath, root, { realpath = realpathSync, exists = existsSync } = {}) {
  try {
    if (!root) return { escapes: false, reason: 'no-root' };
    const realRoot = realpath(root);
    let existing = candidatePath;
    for (let i = 0; i < 64 && !exists(existing); i += 1) {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = realpath(existing);
    const suffix = relative(existing, candidatePath);
    const resolved = suffix ? join(realExisting, suffix) : realExisting;
    const rel = relative(realRoot, resolved);
    const escapes = rel.startsWith('..') || isAbsolute(rel);
    return { escapes, realPath: resolved, realRoot, relative: rel };
  } catch (err) {
    // A path we cannot resolve is treated as an escape: fail closed.
    return { escapes: true, reason: `realpath-failed:${err?.code ?? err?.message ?? 'unknown'}` };
  }
}

/** Orchestrator-managed path set (spec v3 B.3.2 / E7), worktree-relative. */
export const ORCHESTRATOR_PATHS = ['.sdlc/**', '.dsh/**'];

/** Inside ORCHESTRATOR_PATHS these are readable but never writable by a worker. */
export const PROTECTED_ORCHESTRATOR_PATHS = [
  '.sdlc/sdlc.db',
  '.sdlc/sdlc.db-*',
  '.sdlc/sdlc.lock',
  '.sdlc/instance.lock',
  '.sdlc/task-contract.json',
  '.sdlc/backup/**',
];

/** Versioned default destructive-command list (spec v3 C.7.4 / H.1 safety). */
export const DEFAULT_FORBIDDEN_PATTERNS = [
  'git push --force*',
  'git push -f*',
  'git clean -fdx*',
  'git reset --hard*',
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -fr /',
  'chmod -R 777 /',
  'sudo rm -rf*',
];

/** Default secret-read / exfiltration shapes. Best-effort, like all command policy. */
export const DEFAULT_FORBIDDEN_SECRET_READS = [
  '.credentials.yaml',
  '.credentials.yml',
  'id_rsa',
  'id_ed25519',
  '.aws/credentials',
  '.npmrc',
  '.netrc',
];

function toPatternList(value) {
  return asArray(value).map((p) => String(p));
}

/** Compile a glob-ish command pattern (`*` → `.*`) to an unanchored RegExp. */
export function commandPatternToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(escaped);
}

export function normalizeCommand(command) {
  const raw = Array.isArray(command) ? command.join(' ') : String(command ?? '');
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export class GuardPlugin {
  /**
   * @param {object} policy
   * @param {string[]} [policy.allowed_paths]
   * @param {string[]} [policy.forbidden_paths]
   * @param {string[]} [policy.forbidden_patterns]  command policy
   * @param {string[]} [policy.forbidden_commands]  alias used by G.2.4 / older configs
   * @param {string[]} [policy.orchestratorPaths]
   * @param {string[]} [policy.protectedOrchestratorPaths]
   * @param {'deny'|'warn'} [policy.mode]
   * @param {boolean} [policy.caseInsensitive]
   * @param {string} [policy.worktreeRoot]  absolute root; informational for pure decisions
   */
  constructor(policy = {}) {
    this.policy = {
      allowed_paths: toPatternList(policy.allowed_paths),
      forbidden_paths: toPatternList(policy.forbidden_paths),
      forbidden_patterns: toPatternList(
        policy.forbidden_patterns ?? policy.forbidden_commands ?? DEFAULT_FORBIDDEN_PATTERNS,
      ),
      forbidden_secret_reads: toPatternList(policy.forbidden_secret_reads ?? DEFAULT_FORBIDDEN_SECRET_READS),
      orchestratorPaths: toPatternList(policy.orchestratorPaths ?? ORCHESTRATOR_PATHS),
      protectedOrchestratorPaths: toPatternList(
        policy.protectedOrchestratorPaths ?? PROTECTED_ORCHESTRATOR_PATHS,
      ),
      mode: policy.mode === 'warn' ? 'warn' : 'deny',
      caseInsensitive: policy.caseInsensitive ?? defaultCaseInsensitive(),
      worktreeRoot: policy.worktreeRoot ?? null,
    };
    this._compiledCommands = this.policy.forbidden_patterns.map((p) => [p, commandPatternToRegExp(p)]);
    this.denials = [];
  }

  get opts() {
    return { caseInsensitive: this.policy.caseInsensitive };
  }

  _record(kind, subject, reason, pattern) {
    const entry = { kind, subject, reason, pattern: pattern ?? null, at: new Date().toISOString() };
    this.denials.push(entry);
    return entry;
  }

  _final(decision, kind, subject, reason, pattern) {
    if (decision === 'deny') this._record(kind, subject, reason, pattern);
    return this.policy.mode === 'warn' ? { kind: 'allow', reason: `${reason} (warn-mode)` } : { kind: decision, reason, pattern: pattern ?? null };
  }

  /** Detailed write decision. */
  decideFsWrite(path) {
    const norm = normalizePath(path, this.opts);
    if (!norm.ok) return this._final('deny', 'fs-write', String(path), `unsafe-path:${norm.reason}`);
    const p = norm.path;

    const forbidden = matchAny(this.policy.forbidden_paths, p, this.opts);
    if (forbidden) return this._final('deny', 'fs-write', p, `forbidden-path:${forbidden}`, forbidden);

    if (matchAny(this.policy.orchestratorPaths, p, this.opts)) {
      const protectedHit = matchAny(this.policy.protectedOrchestratorPaths, p, this.opts);
      if (protectedHit) {
        return this._final('deny', 'fs-write', p, `protected-orchestrator-path:${protectedHit}`, protectedHit);
      }
      return this._final('allow', 'fs-write', p, 'orchestrator-path');
    }

    const allowed = matchAny(this.policy.allowed_paths, p, this.opts);
    if (allowed) return this._final('allow', 'fs-write', p, `allowed-path:${allowed}`);
    return this._final('deny', 'fs-write', p, 'outside-allowed-paths');
  }

  /**
   * Write decision including symlink containment (T11). Falls back to the
   * lexical decision when no root is known (the pure-matcher path).
   */
  decideFsWriteReal(path, { root = this.policy.worktreeRoot, realpath = realpathSync, exists = existsSync } = {}) {
    const lexical = this.decideFsWrite(path);
    if (lexical.kind === 'deny') return lexical;
    if (!root) return lexical;
    const absolute = isAbsolute(String(path)) ? String(path) : join(root, String(path));
    const containment = escapesRoot(absolute, root, { realpath, exists });
    if (containment.escapes) {
      return this._final('deny', 'fs-write', String(path), `symlink-escape:${containment.reason ?? containment.relative}`, 'symlink-escape');
    }
    return lexical;
  }

  /** Detailed read decision: reads are not scoped by allowed_paths (B.3.2). */
  decideFsRead(path) {    const norm = normalizePath(path, this.opts);
    if (!norm.ok) return this._final('deny', 'fs-read', String(path), `unsafe-path:${norm.reason}`);
    const p = norm.path;
    const forbidden = matchAny(this.policy.forbidden_paths, p, this.opts);
    if (forbidden) return this._final('deny', 'fs-read', p, `forbidden-path:${forbidden}`, forbidden);
    return this._final('allow', 'fs-read', p, 'read-allowed');
  }

  /** Detailed command decision. */
  decideCommand(command) {
    const cmd = normalizeCommand(command);
    for (const [pattern, re] of this._compiledCommands) {
      if (re.test(cmd)) return this._final('deny', 'command', cmd, `forbidden-command:${pattern}`, pattern);
    }
    // Secret reads / obvious exfiltration (structural, not only pattern based).
    for (const secret of this.policy.forbidden_secret_reads) {
      const re = new RegExp(`(?:^|[\\s'"=/])${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\s'"]|$)`);
      if (re.test(cmd)) {
        return this._final('deny', 'command', cmd, `secret-read:${secret}`, secret);
      }
    }
    return this._final('allow', 'command', cmd, 'no-pattern-matched');
  }

  // ── string-returning API used by the validation harness and tests ──

  checkFsWrite(path) {
    return this.decideFsWrite(path).kind;
  }

  checkFsRead(path) {
    return this.decideFsRead(path).kind;
  }

  checkCommand(command) {
    return this.decideCommand(command).kind;
  }

  /**
   * Generic entry point for the DSH `tools/pre-execute` hook.
   * @param {{kind:'fs-write'|'fs-read'|'command', path?:string, command?:string}} intent
   */
  check(intent = {}) {
    if (intent.kind === 'command') return this.decideCommand(intent.command);
    if (intent.kind === 'fs-read') return this.decideFsRead(intent.path);
    return this.decideFsWrite(intent.path);
  }

  /** Pure convenience used by tests: check a list of paths, return violations. */
  violations(paths) {
    return asArray(paths).filter((p) => this.checkFsWrite(p) === 'deny');
  }
}

/**
 * Bound helper for the harness: build a guard from a task contract.
 * `allowed_paths` / `forbidden_paths` come straight from the task contract.
 */
export function guardForContract(contract = {}, overrides = {}) {
  return new GuardPlugin({
    allowed_paths: contract.allowed_paths ?? [],
    forbidden_paths: contract.forbidden_paths ?? [],
    ...overrides,
  });
}

export function defaultGuardPolicy() {
  return {
    orchestratorPaths: [...ORCHESTRATOR_PATHS],
    protectedOrchestratorPaths: [...PROTECTED_ORCHESTRATOR_PATHS],
    forbidden_patterns: [...DEFAULT_FORBIDDEN_PATTERNS],
  };
}

export default { GuardPlugin, ORCHESTRATOR_PATHS, guardForContract, defaultGuardPolicy };
