/**
 * packages/sdlc-core/src/gates.js — gate command detection & execution (spec v3 F.5, B.4.1).
 *
 * The spec repeatedly requires "syntax, lint, unit, integration, api, e2e,
 * visual, security, perf, build" gates without saying how a command is chosen.
 * F.5 closes that: commands are DETECTED per stack, written to `.sdlc/config.yml`
 * as concrete runnable argv arrays, and every gate command is argv-based (no
 * shell interpolation), run through an injected runner so tests need no
 * real toolchain.
 *
 * Skipped gates are recorded as `skipped:<reason>` — evidence is explicit.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GATE_ORDER, requiredGates as riskRequiredGates } from './risk.js';
import { normalizeFailureText, sha1 } from './loop.js';

export const STACKS = {
  pnpm: {
    markers: ['pnpm-lock.yaml'],
    bootstrap: ['pnpm', 'install', '--prefer-offline'],
    commands: {
      unit: ['pnpm', 'test'],
      build: ['pnpm', 'build'],
      lint: ['pnpm', 'exec', 'eslint', '.'],
      types: ['pnpm', 'exec', 'tsc', '--noEmit'],
    },
  },
  npm: {
    // package-lock.json ONLY: `npm ci` requires the lockfile, so a bare
    // package.json must not be "detected" as npm — that would write gate
    // commands that can never run (the guessing F.5 forbids). A
    // package.json-only project gets manual gates from auto-setup instead.
    markers: ['package-lock.json'],
    bootstrap: ['npm', 'ci'],
    commands: { unit: ['npm', 'test'], build: ['npm', 'run', 'build'] },
  },
  python: {
    markers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    bootstrap: ['pip', 'install', '-e', '.'],
    commands: { unit: ['pytest', '-q'] },
  },
  go: {
    markers: ['go.mod'],
    bootstrap: ['go', 'mod', 'download'],
    commands: { build: ['go', 'build', './...'], unit: ['go', 'test', './...'] },
  },
  cargo: {
    markers: ['Cargo.toml'],
    bootstrap: ['cargo', 'fetch'],
    commands: { build: ['cargo', 'build'], unit: ['cargo', 'test'] },
  },
};

/** Detection order matters: pnpm before npm, so a workspace holding both
 *  lockfiles resolves to the stricter package manager. */
export const STACK_ORDER = ['pnpm', 'npm', 'python', 'go', 'cargo'];

export function detectStack(presentFiles = []) {
  const present = new Set(presentFiles);
  for (const name of STACK_ORDER) {
    if (STACKS[name].markers.some((m) => present.has(m))) return name;
  }
  return null;
}

export function detectPlaywright(packageJson) {
  if (!packageJson) return false;
  const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
  return Boolean(deps['@playwright/test'] || deps.playwright);
}

/**
 * Build the `.sdlc/config.yml` `verification.gates` block for a detected stack.
 * Returns null when nothing is recognised — F.5: "init fails and asks for
 * explicit commands; it never guesses".
 */
export function detectGateCommands({ stack, packageJson = null, playwright = false } = {}) {
  if (!stack) return null;
  const entry = STACKS[stack];
  const gates = {
    syntax: { command: ['node', '--check', '{file}'], scope: 'changed-files' },
    lint: { command: entry.commands.lint ?? ['true'], skipIf: entry.commands.lint ? [] : ['not-configured'] },
    unit: { command: entry.commands.unit, timeoutMs: 900000 },
    integration: { command: entry.commands.integration ?? entry.commands.unit, timeoutMs: 1800000 },
    build: { command: entry.commands.build ?? ['true'], skipIf: entry.commands.build ? [] : ['not-configured'] },
  };
  if (entry.commands.types) gates.types = { command: entry.commands.types, skipIf: ['no-tsconfig'] };
  if (playwright) {
    gates.e2e = { command: ['npx', 'playwright', 'test'] };
    gates.visual = { kind: 'playwright', config: '.sdlc/visual.config.ts' };
  }
  return {
    gates,
    bootstrap: entry.bootstrap,
    skipWhen: playwright ? {} : { 'no-browser-stack': ['e2e', 'visual'] },
  };
}

export function listRootFiles(dir, { readdir = readdirSync } = {}) {
  try {
    return readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Run the required gates for a task.
 * @param {object} input
 * @param {string} input.cwd
 * @param {string[]} [input.gates]        explicit gate list (defaults: risk-derived)
 * @param {object} [input.config]         full config (verification.gates + timeouts)
 * @param {(argv:string[], opts:object)=>object} [input.runner]  injected executor
 * @param {string} [input.taskId]
 * @param {string} [input.logDir]
 */
export function runVerification({
  cwd,
  gates,
  config = {},
  runner = defaultRunner,
  taskId = 'TASK',
  logDir = join(cwd, '.sdlc', 'verification', taskId),
  skipGates = [],
  changedFiles = [],
  env = process.env,
} = {}) {
  const configured = config.verification?.gates ?? {};
  const gateTimeoutMs = config.verification?.gateTimeoutMs ?? 300000;
  const selected = gates ?? GATE_ORDER.filter((g) => configured[g]);

  mkdirSync(logDir, { recursive: true });
  const results = {};

  for (const gate of selected) {
    if (skipGates.includes(gate)) {
      results[gate] = { status: 'skipped:policy' };
      continue;
    }
    const spec = configured[gate];
    if (spec === false || spec?.skip === true) {
      results[gate] = { status: `skipped:${spec?.reason ?? 'not-configured'}` };
      continue;
    }
    if (!spec || !spec.command) {
      // visual is a pipeline kind, not a command; anything else needs a command.
      results[gate] = { status: spec ? `skipped:${spec.kind ?? 'no-command'}` : 'skipped:not-configured' };
      continue;
    }
    const started = Date.now();

    // F.5 / H.1: `scope: changed-files` with a `{file}`/`{files}` placeholder
    // means one run PER changed file. With no changed files there is nothing to
    // check, so the gate is SKIPPED with a reason rather than run against a
    // literal "{file}" — which would always fail.
    const usesFilePlaceholder = spec.command.some((a) => /[{]files?[}]/.test(String(a)));
    const fileScoped = spec.scope === 'changed-files' || usesFilePlaceholder;
    let invocations;
    if (fileScoped) {
      if (changedFiles.length === 0) {
        results[gate] = { status: 'skipped:no-changed-files' };
        continue;
      }
      invocations = changedFiles.map((file) => ({
        argv: spec.command.flatMap((arg) => {
          const text = String(arg);
          if (text.includes('{files}')) return changedFiles;
          return text.replace(/\{file\}/g, file);
        }),
        file,
      }));
    } else {
      invocations = [{ argv: spec.command, file: null }];
    }

    const outputs = [];
    let status = 'pass';
    let exitCode = 0;
    for (const invocation of invocations) {
      const res = runner(invocation.argv, { cwd, timeoutMs: spec.timeoutMs ?? gateTimeoutMs, env });
      const code = res.status ?? res.code;
      outputs.push(`$ ${invocation.argv.join(' ')}\n# exit ${code}\n\n${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim());
      if (code !== 0) { status = `fail:${code}`; exitCode = code; break; } // fail-fast within the gate
    }
    const durationMs = Date.now() - started;
    const output = outputs.join('\n\n').trim();
    const logPath = join(logDir, `${gate}.log`);
    writeFileSync(logPath, `${output}\n`);
    results[gate] = {
      status, exitCode, durationMs, logPath,
      ...(fileScoped ? { files: [...changedFiles] } : {}),
    };
    if (status !== 'pass') {
      results[gate].signature = `${gate}:${sha1(normalizeFailureText(output))}`;
      break; // fail-fast in GATE_ORDER (B.4.1)
    }
  }

  const failures = Object.entries(results).filter(([, r]) => String(r.status).startsWith('fail'));
  return {
    overall: failures.length === 0 ? 'pass' : 'fail',
    gates: results,
    firstFailure: failures.length ? { gate: failures[0][0], ...failures[0][1] } : null,
  };
}

export function defaultRunner(argv, { cwd, timeoutMs = 300000, env = process.env } = {}) {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    // Same widening as project.js (Oct 2026): gate commands (`node --check`,
    // `pnpm test`, …) must resolve when workers/containers carry a thin PATH.
    // An explicit env.PATH from the caller still wins.
    env: env?.PATH !== undefined ? env : widenedEnvLike(env),
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? (res.error ? 127 : 0), stdout: res.stdout ?? '', stderr: res.stderr ?? res.error?.message ?? '' };
}

/** Widen PATH without clobbering caller-provided overrides. */
function widenedEnvLike(env = {}) {
  if (env.PATH !== undefined && env !== process.env) return { ...env };
  const dir = process.execPath ? process.execPath.slice(0, process.execPath.lastIndexOf('/')) || '/' : null;
  const parts = [dir, process.env.PATH, env.PATH, '/usr/bin', '/bin', '/usr/local/bin', '/app/bin'].filter(Boolean);
  return { ...env, PATH: [...new Set(parts)].join(':') };
}

/** Convenience: derive the required gates for a task via risk.js. */
export function gatesForTask(risk, options = {}) {
  return riskRequiredGates(risk, options);
}

/** Read a gate log as evidence for the elevation packet. */
export function readGateLog(logPath, { maxBytes = 8192 } = {}) {
  try {
    return readFileSync(logPath, 'utf8').slice(0, maxBytes);
  } catch {
    return null;
  }
}

export default { detectStack, detectGateCommands, runVerification, gatesForTask, STACKS, GATE_ORDER };
