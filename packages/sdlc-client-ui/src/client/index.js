/**
 * packages/sdlc-client-ui/src/client/index.js — browser half of the SDLC web UI.
 *
 * Registers the `sdlc` right-sidebar tab type + body + title (the files-tab
 * pattern): the type into `ctx.sidebarRightTabs`, the body into the keyed
 * `sidebar.right.pane.tab` seat and the title into
 * `sidebar.right.pane.tab.title`, both under the type's id.
 */

import { api } from './api.js';
import { createSdlcStores, createSdlcStoreHandle } from './store.js';
import { NS, en, zh } from './locales.js';
import { SDLC_ID, SDLC_KIND, sdlcDefinition } from './definition.js';
import { SdlcTab, SdlcTitle } from './SdlcTab.jsx';

/** Required browser services: tab registry, keyed seats, Remote, session cwd, copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote', 'sessions', 'uiSession'];

/** The cwd of the session on screen, when the shell exposes it. */
function currentSessionCwd(ctx) {
  try {
    const key = ctx.uiSession?.adapter?.current?.getSnapshot?.()?.key;
    if (key == null) return undefined;
    return ctx.sessions?.list?.getSnapshot?.()?.byId?.[key]?.cwd;
  } catch {
    return undefined;
  }
}

/**
 * Client plugin body: register dictionaries, the tab type, and the tab body.
 * @param ctx - client root context.
 */
export function apply(ctx, config = {}) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sdlc-ui: dictionaries');
  ctx.effect(() => ctx.sidebarRightTabs.register(sdlcDefinition(t)), 'sdlc-ui: sdlc tab type');

  const stores = createSdlcStores(api);
  const storeHandle = createSdlcStoreHandle(stores);
  ctx.effect(() => () => stores.dispose(), 'sdlc-ui: dispose');
  ctx.on('connection/reset', () => stores.reset());

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: SDLC_ID, locale: NS, store: storeHandle,
      inject: () => ({ stores, t }),
    },
    SdlcTab,
  )), 'sdlc-ui: sdlc tab body');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: SDLC_ID },
    (props) => SdlcTitle({ ...props, t }),
  )), 'sdlc-ui: sdlc tab title');

  // The right sidebar has no surface without a session, and a page type is
  // reachable only through the guide or an explicit openTab. Open the flow
  // panel once per page load for the first session that has an SDLC project,
  // so the visualizer is actually seen (config.autoOpen === false opts out).
  if (config.autoOpen !== false && typeof ctx.sidebarRight?.mounted?.subscribe === 'function') {
    let opened = false;
    let checking = false;
    const maybeOpen = async () => {
      if (opened || checking || !ctx.sidebarRight.mounted.getSnapshot()) return;
      checking = true;
      try {
        // The host is not session-scoped: without cwd it reads the Harness
        // profile directory under the Desktop app and finds no project.
        const status = await api.fetchStatus(currentSessionCwd(ctx));
        if (status.available && status.data.tasks.total > 0) {
          opened = true;
          try { ctx.sidebarRight.openTab(SDLC_KIND); } catch { /* no surface yet */ }
        }
      } finally {
        checking = false;
      }
    };
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(() => { void maybeOpen(); });
    // The selected session and its cwd can arrive after mount; re-check when
    // the catalog settles so the panel still opens on the first real session.
    const unsubscribeSessions = ctx.sessions?.list?.subscribe?.(() => { void maybeOpen(); });
    ctx.effect(() => () => {
      unsubscribe?.();
      unsubscribeSessions?.();
    }, 'sdlc-ui: auto-open flow panel');
  }
}

// The closure bundle strips this line and re-attaches the same object as
// `exports.default` (see scripts/build-ui.mjs). The web loader's unwrapExports
// prefers `.default`; the object — not the bare apply function — is what keeps
// `inject` visible, so the sidebar tab actually receives slots/locale/remote.
export default { apply, inject };
