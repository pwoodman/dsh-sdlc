/**
 * packages/sdlc-client-ui/src/server/spawn-adapter.js — the host spawn seam.
 *
 * The executor and run loop take `spawn` as an injected dependency (E6: core
 * never statically imports host-only modules; the engine stays offline
 * testable). This adapter is what the panel's host plugin injects:
 *
 *   1. `ctx.subprocess.spawn` when the Harness exposes it (P25) — the
 *      platform's own argv-based, credential-scrubbed executor;
 *   2. otherwise Node's `child_process.spawn`, wrapped into the same handle
 *      contract. The env the executor passes is ALREADY scrubbed by
 *      `buildWorkerEnv` (E5), so the fallback keeps the same guarantees.
 *
 * `ctx.subprocess` is read DEFENSIVELY and without adding it to `inject`: a
 * wrong service name in the inject list would hold the plugin's fiber open
 * forever and the tab would never mount, whereas a failed property read is
 * caught here and falls back to a spawn that works everywhere.
 */

import { spawn as cpSpawn } from 'node:child_process';

/**
 * Normalize a child process into the handle shape the executor awaits:
 * { pid, stdout, stderr, waitForExit(), terminate(signal), readOutput() }.
 * `stdout`/`stderr` are live getters over the accumulated output so a caller
 * that reads after waitForExit() sees the whole stream.
 */
function nodeHandle(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  return {
    pid: child.pid ?? null,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    waitForExit: () => new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null) {
        resolve({ exitCode: child.exitCode, signal: child.signalCode });
        return;
      }
      child.once('close', (code, signal) => resolve({ exitCode: code, signal }));
    }),
    terminate: (signal = 'SIGTERM') => {
      try { child.kill(signal); } catch { /* already gone */ }
    },
    readOutput: async () => ({ stdout, stderr }),
  };
}

/** A ctx.subprocess handle normalized to the same contract. */
function serviceHandle(handle) {
  const readOutput = async () => {
    if (typeof handle?.readOutput === 'function') {
      try {
        const out = await handle.readOutput();
        if (out && typeof out === 'object') return out;
      } catch { /* fall through to the fields */ }
    }
    return { stdout: typeof handle?.stdout === 'string' ? handle.stdout : '', stderr: typeof handle?.stderr === 'string' ? handle.stderr : '' };
  };
  return {
    pid: handle?.pid ?? null,
    get stdout() { return typeof handle?.stdout === 'string' ? handle.stdout : ''; },
    get stderr() { return typeof handle?.stderr === 'string' ? handle.stderr : ''; },
    waitForExit: () => {
      if (typeof handle?.waitForExit === 'function') return Promise.resolve(handle.waitForExit());
      // The bare `exited` form carries the outcome itself (an object), while
      // a numeric `exitCode` is the flat form; unwrap either.
      if (handle?.exited != null && typeof handle.exited === 'object') {
        return Promise.resolve({ exitCode: handle.exited.exitCode ?? null, signal: handle.exited.signal ?? null });
      }
      return Promise.resolve({ exitCode: handle?.exitCode ?? handle?.exited ?? null, signal: handle?.signal ?? null });
    },
    terminate: (signal) => {
      try { handle?.terminate?.(signal); } catch { /* already gone */ }
    },
    readOutput,
  };
}

/**
 * Build the spawn function the run loop receives.
 *
 * @param {object} [ctx] host plugin context (may be null in tests).
 * @returns {Function} async ({ argv, cwd, env }) → normalized handle.
 */
export function hostSpawn(ctx = null) {
  const service = (() => {
    try {
      return ctx?.subprocess?.spawn ?? ctx?.get?.('subprocess')?.spawn ?? null;
    } catch {
      return null; // service not declared in inject — the documented fallback
    }
  })();
  if (typeof service === 'function') {
    return async ({ argv, cwd, env }) => serviceHandle(await service({ argv, cwd, env }));
  }
  return async ({ argv, cwd, env }) => {
    const child = cpSpawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // A spawn that cannot start (ENOENT) must surface as a described failure
    // on the handle, not an unhandled 'error' event that kills the host.
    const errored = new Promise((resolve) => {
      child.once('error', (err) => resolve({ exitCode: null, signal: null, error: err?.message ?? String(err) }));
    });
    const handle = nodeHandle(child);
    const originalWait = handle.waitForExit;
    handle.waitForExit = async () => {
      const outcome = await Promise.race([originalWait(), errored]);
      if (outcome && outcome.error) {
        return { exitCode: outcome.exitCode, signal: outcome.signal, error: outcome.error };
      }
      return outcome;
    };
    return handle;
  };
}

export default { hostSpawn };
