/**
 * packages/sdlc-client-ui/src/server/execution.js — the panel's scheduler tick.
 *
 * One instance per host plugin process. `advance()` is what the run/dispatch/
 * retry handlers call: it opens its OWN runtime (the HTTP request's runtime is
 * closed by its handler), runs `advanceFlow` with the host spawn adapter, and
 * keeps the background drain alive — closing the runtime when the DAG
 * settles. The `inFlight` map is shared by every advance from this process,
 * so a poll or a double click can never launch the same task twice.
 *
 * Nothing here grants authority: dispatch and verification run through the
 * runtime's own state machine; acceptance still requires gate evidence, and
 * R2+ work still waits for its independent review.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Runtime } from '../../../sdlc-core/src/runtime.js';
import { loadConfig } from '../../../sdlc-core/src/config.js';
import { advanceFlow } from '../../../sdlc-core/src/run-loop.js';
import { hostSpawn } from './spawn-adapter.js';

/**
 * @param {object} opts
 * @param {object} [opts.ctx] host plugin context (for ctx.subprocess, logger)
 * @param {Function} [opts.spawn] DI — overrides the host adapter (tests)
 * @param {number|null} [opts.maxParallel] DI — explicit parallel cap (tests)
 * @returns {{advance: Function, inFlight: Map}}
 */
export function createExecutionService({ ctx = null, spawn = null, maxParallel = null } = {}) {
  const spawnFn = spawn ?? hostSpawn(ctx);
  const logger = (() => {
    try { return ctx?.logger ?? null; } catch { return null; }
  })();
  const inFlight = new Map();

  /**
   * One scheduler tick for a workspace. Resolves after the first dispatch and
   * chain launches (fast, sqlite bound) with `{ report, completion }` — the
   * completion promise is the full DAG drain and is owned by this service.
   */
  async function advance({ projectRoot, projectId = null }) {
    if (!projectRoot || typeof projectRoot !== 'string') {
      throw new Error('advance: projectRoot is required');
    }
    if (!existsSync(join(projectRoot, '.sdlc', 'sdlc.db'))) {
      return { report: { dispatched: [], executed: [], verified: [], integrated: [], awaitingReview: [], skipped: [{ taskId: null, reason: 'no .sdlc project' }] }, completion: Promise.resolve(null) };
    }
    const { config } = loadConfig(projectRoot);
    const effective = { ...config, storage: { ...(config.storage ?? {}), requireQuickCheckOnOpen: false } };
    const runtime = new Runtime({ projectRoot, config: effective, useLock: false });
    runtime.open();
    let result;
    try {
      result = await advanceFlow({
        runtime, projectRoot, config: effective, projectId,
        spawn: spawnFn, inFlight, maxParallel, logger,
      });
    } catch (err) {
      try { runtime.close({ releaseLock: false }); } catch { /* already closed */ }
      throw err;
    }
    // The drain must outlive this request: the service owns the runtime's
    // lifetime and closes it when every launched chain has settled.
    void Promise.resolve(result.completion)
      .catch((err) => {
        if (logger?.warn) logger.warn('sdlc-ui: flow drain failed: %s', err?.message ?? err);
      })
      .finally(() => {
        try { runtime.close({ releaseLock: false }); } catch { /* already closed */ }
      });
    return result;
  }

  return { advance, inFlight };
}

export default { createExecutionService };
