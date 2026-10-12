/**
 * packages/sdlc-orchestrator/src/index.js — meta-bundle entry.
 *
 * The bundle's composition comes from its dependencies' patch files; this
 * module exists so the package has a resolvable host entry (the `sdlc-ui`
 * self-report pattern: data-only patches never run code, so the boot hook
 * needs one row that executes). It contributes nothing to the selftest
 * beyond its own presence.
 */

export const PACKAGE = '@patwoodman/orchestrator';
export const BUNDLES = [
  '@patwoodman/orchestrator-core',
  '@patwoodman/orchestrator-tools',
  '@patwoodman/orchestrator-presets',
  '@patwoodman/orchestrator-ui',
];

/**
 * DSH plugin entry. The meta-bundle contributes no rows of its own — the
 * composition lives in its generated cordis.patch.yml — but the loader expects
 * every bundle listed in `dsh.profile.bundles` to export `apply`. Without it
 * the row silently fails to activate and the boot hook reports a missing plugin.
 */
export function apply(ctx, config = {}) {
  return { package: PACKAGE, bundles: BUNDLES };
}

export default { PACKAGE, BUNDLES, apply };
