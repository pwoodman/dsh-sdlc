/**
 * packages/sdlc-presets/src/index.js — roster data + patch declaration helpers.
 */

export {
  ROLES, ROLE_IDS, ROLE_COUNT, PUBLIC_ROLE_IDS, PUBLIC_ROLE_COUNT, isPublicRole,
  presetRows, publicPresetRows, presetRow, presetRegistryRow, presetIdFor, presetConfigIdFor,
  rolesForDomains, WORKER_TOOL_ROWS, LEAD_TOOL_ROWS, POLICY_SUFFIX,
} from './roles.js';
export { apply, declaredPresetIds } from './plugin.js';

export const PACKAGE = '@patwoodman/dsh-sdlc-flow-presets';
