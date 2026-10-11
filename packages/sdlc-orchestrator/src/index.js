/**
 * packages/sdlc-orchestrator/src/index.js — meta-bundle entry.
 *
 * The bundle's composition comes from its dependencies' patch files; this
 * module exists so the package has a resolvable host entry (the `sdlc-ui`
 * self-report pattern: data-only patches never run code, so the boot hook
 * needs one row that executes). It contributes nothing to the selftest
 * beyond its own presence.
 */

export const PACKAGE = '@sdlc/orchestrator';
export const BUNDLES = [
  '@sdlc/orchestrator-core',
  '@sdlc/orchestrator-tools',
  '@sdlc/orchestrator-presets',
  '@sdlc/orchestrator-ui',
];

export default { PACKAGE, BUNDLES };
