/**
 * packages/sdlc-client-ui/src/index.js — public surface of the UI bundle.
 *
 * The loader activates the `sdlc-ui` row through THIS module: `unwrapExports`
 * finds no default export, so the module namespace itself is the plugin object
 * and the loader reads `inject` from these exports. The re-export below is
 * therefore load-bearing — the `sdlc-ui` row cannot reach `apply` without it
 * (see server/plugin.js for the failure mode).
 */

export { apply, registerRoutes, inject } from './server/plugin.js';
export * as routes from './routes.js';
export * as handlers from './server/handlers.js';

export const PACKAGE = '@patwoodman/orchestrator-ui';
