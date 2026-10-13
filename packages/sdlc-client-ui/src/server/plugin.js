/**
 * packages/sdlc-client-ui/src/server/plugin.js — host half of the SDLC web UI.
 *
 * Registers the `sdlc.*` routes inside the connection's authentication fence
 * (the deliverables-plugin pattern: `ctx.connection.fetch.register`). All
 * state comes from the live `sdlc.db` via the pure handlers — the plugin
 * itself holds no DB handle and never takes the instance lock.
 *
 * The `connection` service lives in a sibling branch of the Cordis tree, so
 * reading `ctx.connection` from `apply()` requires the service to be declared
 * below: the loader reads `inject` from the ENTRY module's namespace when it
 * activates the row, holds the fiber until the service exists, and puts the
 * implementation in the fiber's store. Without the declaration the context
 * proxy throws `cannot get property "connection" without inject` and the row
 * never activates.
 *
 * This module must NOT `export default apply`. Cordis `Loader.unwrapExports`
 * prefers `.default`, and a bare function has no `.inject` — the loader then
 * starts the fiber with an empty dependency map and the same error fires at
 * `registerRoutes` even though the named `inject` export is present. The host
 * entry (`src/index.js`) therefore re-exports the named bindings only.
 */

import {
  SDLC_STATUS_PATH, SDLC_BOARD_PATH, SDLC_TASK_PATH, SDLC_COMPARE_PATH,
  SDLC_CONFIG_PATH, SDLC_METRICS_PATH,
} from '../routes.js';
import {
  handleStatus, handleBoard, handleTask, handleCompare,
  handleConfigGet, handleConfigPost, handleMetrics,
} from './handlers.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// sdlc-core is a host-only bundle (never installed beside the UI in a
// worker); resolve its selftest helper at runtime so the UI keeps the E6
// partition (no static import of core from the UI bundle).
//
// The specifier must be the STEM form (`/selftest`, no `.js`): core's exports
// map is `"./*": "./lib/*.js"`, so a `.js`-suffixed subpath would resolve to
// `lib/selftest.js.js` and silently never load — the catch below would hide
// it and every selftest contribution from this package would be dead.
const require = createRequire(import.meta.url);
function selftest(ctx = null) {
  try {
    return require('@patwoodman/orchestrator-core/selftest');
  } catch (err) {
    // Import-without-host (unit tests, partial installs) stays silent, but a
    // boot that EXPECTS the selftest report must not fail invisibly: the
    // never-fabricate rule cuts both ways, so say why the contribution is
    // missing instead of writing a report that quietly lacks this surface.
    if (process.env.SDLC_SELFTEST && ctx?.logger?.warn) {
      ctx.logger.warn('sdlc-ui: selftest helper not resolvable (%s) — no sdlc_ui_routes contribution', err?.message ?? err);
    }
    return null;
  }
}

function pkgVersion() {
  return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
}

function projectRootOf(config = {}) {
  return config.projectRoot ?? process.env.SDLC_PROJECT_ROOT ?? process.cwd();
}

function statusResponse({ status, body, contentType }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': contentType ?? 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function queryOf(request) {
  const url = new URL(request.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

/** Host services this plugin requires (read by the loader at activation). */
export const inject = ['connection'];

/**
 * Register one route on the connection fence, effect-scoped when the host
 * offers `ctx.effect` (the session-controller pattern): the disposer returned
 * by `connection.fetch.register` is then tied to this fiber, so a config
 * update or bundle reload removes the routes before `apply` runs again. Bare
 * re-registration would hit the connection's
 * `exact Fetch route … is already registered` guard and, through the
 * warn-only paths below, silently drop every route after the first restart.
 * Plain contexts (unit tests, import-without-host) register directly.
 */
function registerFenced(ctx, route, label) {
  if (typeof ctx?.effect === 'function') {
    return ctx.effect(() => ctx.connection.fetch.register(route), label);
  }
  return ctx.connection.fetch.register(route);
}

/** Register every route; defensive so the package imports without a host. */
export function registerRoutes(ctx, config = {}) {
  const root = () => projectRootOf(config);
  const registered = [];
  if (typeof ctx?.connection?.fetch?.register !== 'function') return registered;

  const routes = [
    [SDLC_STATUS_PATH, ['GET'], async () => statusResponse(handleStatus(root()))],
    [SDLC_BOARD_PATH, ['GET'], async () => statusResponse(handleBoard(root()))],
    [SDLC_TASK_PATH, ['GET'], async (request) => statusResponse(handleTask(root(), queryOf(request)))],
    [SDLC_COMPARE_PATH, ['GET'], async (request) => statusResponse(handleCompare(root(), queryOf(request)))],
    [SDLC_CONFIG_PATH, ['GET'], async () => statusResponse(handleConfigGet(root()))],
    [SDLC_METRICS_PATH, ['GET'], async () => statusResponse(handleMetrics(root()))],
  ];
  for (const [path, methods, fetch] of routes) {
    try {
      registerFenced(ctx, { path, methods, requestBody: 'buffered', fetch }, `sdlc-ui: ${path} Fetch route`);
      registered.push(`GET ${path}`);
    } catch (err) {
      if (ctx?.logger?.warn) ctx.logger.warn('sdlc-ui: failed to register %s: %s', path, err?.message ?? err);
    }
  }
  try {
    registerFenced(ctx, {
      path: SDLC_CONFIG_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJson(request);
        if (!body) return statusResponse({ status: 400, body: { ok: false, error: 'BAD_JSON' } });
        return statusResponse(handleConfigPost(root(), body));
      },
    }, `sdlc-ui: POST ${SDLC_CONFIG_PATH} Fetch route`);
    registered.push(`POST ${SDLC_CONFIG_PATH}`);
  } catch (err) {
    if (ctx?.logger?.warn) ctx.logger.warn('sdlc-ui: failed to register POST %s: %s', SDLC_CONFIG_PATH, err?.message ?? err);
  }
  return registered;
}

/**
 * Loader entry. MUST return nothing: the Cordis runner interprets a plugin's
 * return value as an effect, so a plain object is fatal for a
 * non-constructible apply (`TypeError: Invalid effect`) and — for a regular
 * function apply, which this is — is silently swallowed along with any
 * disposer. Resources are released through the `ctx.effect` wrappers in
 * `registerFenced`; tests that want the registration report call
 * `registerRoutes` directly.
 * @returns {undefined}
 */
export function apply(ctx, config = {}) {
  const st = selftest(ctx);
  st?.setSelftestMeta?.({ version: pkgVersion() });
  const routes = registerRoutes(ctx, config);
  // The boot-hook report has no uiRoutes field (it is pinned by M0-12); the
  // UI reports through the tools surface so the composed product stays
  // observable without changing the contract.
  st?.contributeSelftest?.({ tools: routes.length ? ['sdlc_ui_routes'] : [] });
}
