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
 *
 * MUST return nothing: the Cordis runner interprets a plugin's return value as
 * an effect (`TypeError: Invalid effect` for a non-constructible apply;
 * silently dropped for this regular-function apply). The composition is
 * declared by the exported BUNDLES constant and the generated patch file.
 * @returns {undefined}
 */
export function apply(ctx, config = {}) {}

export default { PACKAGE, BUNDLES, apply };
