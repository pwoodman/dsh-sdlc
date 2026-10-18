/**
 * packages/sdlc-tools/src/report.js — the worker preset's propose-only result
 * slice (spec v3 C.3/C.4).
 *
 * The preset rows name this subpath, not the package root: `lib/index.js` is
 * data only, so the loader would reject it with "never started". Each slice is
 * a real loader entry and registers tools only — commands stay with the host
 * `sdlc-tools` row.
 */

import { REPORT_TOOLS } from './index.js';
import { toolSubsetPlugin } from './plugin.js';

export { inject } from './plugin.js';
export const name = 'sdlc-tools/report';
export const apply = toolSubsetPlugin(REPORT_TOOLS);
