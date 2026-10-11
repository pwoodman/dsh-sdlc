/**
 * packages/sdlc-presets/src/index.js — roster data + patch declaration helpers.
 */

export {
  ROLES, ROLE_IDS, ROLE_COUNT, presetRows, presetRow, presetRegistryRow, presetIdFor, presetConfigIdFor,
  rolesForDomains, WORKER_TOOL_ROWS, LEAD_TOOL_ROWS, POLICY_SUFFIX,
} from './roles.js';
export { apply, declaredPresetIds } from './plugin.js';

export const PACKAGE = '@patwoodman/orchestrator-presets';
