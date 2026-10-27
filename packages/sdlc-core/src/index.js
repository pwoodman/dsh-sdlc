/**
 * packages/sdlc-core/src/index.js — public surface of the host bundle.
 *
 * `apply(ctx, config)` is the plugin entry used by the sdlc-probe profile; the
 * per-service rows declared in cordis.patch.yml use `./services.js`, which
 * shares the same single runtime.
 */

export { apply, SERVICE_NAMES, getRuntime, closeRuntime, makeService } from './services.js';
export { Runtime, RuntimeLockedError } from './runtime.js';
export * as schema from './schema.js';
export * as complexity from './complexity/index.js';
export * as stateMachine from './state-machine.js';
export * as workerResult from './worker-result.js';
export * as risk from './risk.js';
export * as a11y from './a11y.js';
export * as visual from './visual.js';
export * as loop from './loop.js';
export * as router from './router.js';
export * as budget from './budget.js';
export * as configModule from './config.js';
export * as gates from './gates.js';
export * as context from './context.js';
export * as scheduler from './scheduler.js';
export * as verifier from './verifier.js';
export * as escalation from './escalation.js';
export * as integration from './integration.js';
export * as recovery from './recovery.js';
export * as workerMgr from './worker-mgr.js';
export * as executor from './executor.js';
export * as runLoop from './run-loop.js';
export * as project from './project.js';
export * as metrics from './metrics.js';
export * as debug from './debug.js';
export * as yaml from './yaml-lite.js';
export * as instanceLock from './instance-lock.js';
export { contributeSelftest, setSelftestMeta, flushSelftest, buildSelftestReport } from './selftest.js';

export const PACKAGE = '@patwoodman/dsh-sdlc-flow-core';
