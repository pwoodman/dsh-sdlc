/**
 * packages/sdlc-client-ui/src/index.js — public surface of the UI bundle.
 */

export { apply, registerRoutes } from './server/plugin.js';
export * as routes from './routes.js';
export * as handlers from './server/handlers.js';

export const PACKAGE = '@patwoodman/orchestrator-ui';
