/**
 * packages/sdlc-tools/src/plan.js — the Lead's plan-delta slice (spec v3
 * C.3/C.4). Kept separate so the preset row can name exactly the tool it
 * grants instead of re-mounting the whole tools plugin.
 */

import { PLAN_TOOLS } from './index.js';
import { toolSubsetPlugin } from './plugin.js';

export { inject } from './plugin.js';
export const name = 'sdlc-tools/plan';
export const apply = toolSubsetPlugin(PLAN_TOOLS);
