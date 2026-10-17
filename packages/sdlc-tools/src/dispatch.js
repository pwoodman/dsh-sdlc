/**
 * packages/sdlc-tools/src/dispatch.js — the Lead's dispatch/approval slice
 * (spec v3 C.3/C.4): propose a dispatch, approve a transition, record a
 * decision. `sdlc_plan_delta` has its own `./plan` entry.
 */

import { DISPATCH_TOOLS } from './index.js';
import { toolSubsetPlugin } from './plugin.js';

export const name = 'sdlc-tools/dispatch';
export const apply = toolSubsetPlugin(DISPATCH_TOOLS);
