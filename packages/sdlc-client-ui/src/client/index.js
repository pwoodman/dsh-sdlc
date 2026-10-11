/**
 * packages/sdlc-client-ui/src/client/index.js — browser half of the SDLC web UI.
 *
 * Registers the `sdlc` right-sidebar tab type + body + title (the files-tab
 * pattern): the type into `ctx.sidebarRightTabs`, the body into the keyed
 * `sidebar.right.pane.tab` seat and the title into
 * `sidebar.right.pane.tab.title`, both under the type's id.
 */

import api from './api.js';
import { createSdlcStores } from './store.js';
import { NS, en, zh } from './locales.js';
import { SDLC_ID, sdlcDefinition } from './definition.js';
import { SdlcTab, SdlcTitle } from './SdlcTab.jsx';

/** Required browser services: tab registry, keyed seats, Remote, copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote'];

/**
 * Client plugin body: register dictionaries, the tab type, and the tab body.
 * @param ctx - client root context.
 */
export function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sdlc-ui: dictionaries');
  ctx.effect(() => ctx.sidebarRightTabs.register(sdlcDefinition(t)), 'sdlc-ui: sdlc tab type');

  const stores = createSdlcStores(api);
  ctx.effect(() => () => stores.dispose(), 'sdlc-ui: dispose');
  ctx.on('connection/reset', () => stores.reset());

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: SDLC_ID, locale: NS, store: stores,
      inject: () => ({ stores, t }),
    },
    SdlcTab,
  )), 'sdlc-ui: sdlc tab body');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: SDLC_ID },
    (props) => SdlcTitle({ ...props, t }),
  )), 'sdlc-ui: sdlc tab title');
}

export default { apply, inject };
