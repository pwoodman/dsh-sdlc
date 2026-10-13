/**
 * packages/sdlc-client-ui/src/index.js — public surface of the UI bundle.
 *
 * The loader activates the `sdlc-ui` row through THIS module. `unwrapExports`
 * prefers a default export; a default that is the `apply` function has no
 * `.inject`, so the fiber starts with an empty dependency map and
 * `ctx.connection` throws `cannot get property "connection" without inject`
 * inside `registerRoutes`. There is therefore no default export here: the
 * module namespace is the plugin object, and the named `inject` re-export is
 * load-bearing (see server/plugin.js).
 */

export { apply, registerRoutes, inject } from './server/plugin.js';
export * as routes from './routes.js';
export * as handlers from './server/handlers.js';

export const PACKAGE = '@patwoodman/orchestrator-ui';
