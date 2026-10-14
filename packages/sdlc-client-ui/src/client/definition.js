/**
 * packages/sdlc-client-ui/src/client/definition.js — what the `sdlc` tab type IS.
 *
 * A right-sidebar page (the files-tab pattern): it claims the
 * `dsh-resource://sdlc-review/task/…` addresses the board mints for per-task
 * review, and offers the SDLC entry as a guide box otherwise.
 */

export const SDLC_KIND = 'sdlc';

/** This implementation's identity in the tab system, and the key its body registers under. */
export const SDLC_ID = '@patwoodman/dsh-sdlc-flow-ui';

export function sdlcDefinition(t) {
  return {
    id: SDLC_ID,
    kind: SDLC_KIND,
    priority: 'builtin',
    title: () => t('tab.title'),
  };
}

export default { SDLC_KIND, SDLC_ID, sdlcDefinition };
