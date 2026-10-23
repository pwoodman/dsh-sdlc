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
  SDLC_CONFIG_PATH, SDLC_HOST_PATH, SDLC_METRICS_PATH, SDLC_FLOW_PATH,
} from '../routes.js';
import {
  handleStatus, handleBoard, handleTask, handleCompare,
  handleConfigGet, handleConfigPost, handleHostAdopt, handleMetrics,
} from './handlers.js';
import { handleFlow } from './flow.js';
import { ensureProject } from '../../../sdlc-core/src/project.js';
import { resolveHostModel } from '../../../sdlc-core/src/host-model.js';
import { readPackageVersion } from '../../../sdlc-guard/src/package-version.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

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
    return require('@patwoodman/dsh-sdlc-flow-core/selftest');
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
  return readPackageVersion(import.meta.url, 3);
}

/**
 * Resolve the project root for one request.
 *
 * The browser is session-scoped, the host plugin is not: `process.cwd()` is
 * the Harness installation/profile directory under the Desktop app, so the
 * panel would read the wrong `.sdlc` (or none). The tab body therefore sends
 * the active session's `cwd`, and this resolver accepts it only when it is an
 * absolute, existing directory. Anything else keeps the configured root, so a
 * malformed query can never escape to a path that does not exist.
 *
 * The route fence already authenticates the request; this adds no filesystem
 * authority beyond "an `.sdlc` under a directory this user can enter".
 *
 * @param {object} config - the row config (`projectRoot` override).
 * @param {Request} [request] - the fetcher request carrying `?cwd=`.
 * @returns {string} absolute project root.
 */
export function resolveProjectRoot(config = {}, request = undefined) {
  const fallback = config.projectRoot ?? process.env.SDLC_PROJECT_ROOT ?? process.cwd();
  if (request === undefined) return fallback;
  let requested;
  try {
    requested = new URL(request.url, 'http://localhost').searchParams.get('cwd');
  } catch {
    return fallback;
  }
  if (typeof requested !== 'string' || requested === '' || !isAbsolute(requested) || requested.includes('\0')) {
    return fallback;
  }
  try {
    const resolved = resolve(requested);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return fallback;
    return resolved;
  } catch {
    return fallback;
  }
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

/** The provider/model the Harness resolves for new Agents, when available. */
function currentHostModel(ctx) {
  try {
    const service = ctx?.get?.('agentDefaultModel') ?? ctx?.agentDefaultModel;
    const selection = service?.currentSelection?.();
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null;
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The route every bootstrap should adopt.
 *
 * Priority: an explicit row-config override (tests, unusual deployments), the
 * live `agentDefaultModel` service, then on-disk profile discovery. Discovery
 * NEVER returns null — its last resort is DSH's own base default — so a
 * bootstrapped config always names a Harness route, never a provider that
 * would require the user to paste a second API key.
 */
function effectiveHostModel(ctx, config = {}) {
  if (config.hostModel && typeof config.hostModel.provider === 'string' && typeof config.hostModel.model === 'string') {
    return { reasoningEffort: null, source: 'row-config', ...config.hostModel };
  }
  return currentHostModel(ctx) ?? resolveHostModel({ dshHome: config.dshHome });
}

/**
 * Auto-bootstrap policy (spec v3 F.4 — no init ritual), fail-closed.
 *
 * The first request against a workspace root materialises `.sdlc/` with the
 * Harness's model route, so the panel never greets the user with "run
 * `sdlc init`". This is the single bootstrap entry point and it is UNMEMOISED
 * by design: ensureProject's complete-project fast path is two existsSync
 * calls (a memo would save nothing), while a memo of successes would keep
 * answering from a `.sdlc` the user deleted, and a memo of failures would
 * need a host restart to recover after the workspace is fixed. An existing
 * config.yml is never rewritten by bootstrap — adopting the route into a
 * config the user already authored is the explicit Settings action, not a
 * side effect of a read.
 *
 * Bootstrap performs real filesystem work (mkdir, git, sqlite) inside a
 * request handler, so every failure mode — including a throw, e.g. EACCES on
 * an unwritable root — must resolve into a response, never reject the fetch.
 */
function bootstrapGuarded(projectRoot, hostModel) {
  try {
    return { result: ensureProject({ projectRoot, hostModel }) };
  } catch (err) {
    return {
      result: {
        ok: false,
        message: err?.code === 'EACCES' || err?.code === 'EPERM'
          ? 'this workspace is not writable'
          : (err?.message ?? 'unexpected error during auto-setup'),
      },
    };
  }
}

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
  const root = (request) => resolveProjectRoot(config, request);
  const registered = [];
  if (typeof ctx?.connection?.fetch?.register !== 'function') return registered;

  /**
   * One auto-bootstrapping request: resolve the root and the CURRENT Harness
   * model (a mid-session model switch is reflected on the next request),
   * materialise `.sdlc/` on first touch, then run the pure handler. Bootstrap
   * failure — undescribable workspace, unwritable root, or a throw — keeps
   * the NO_PROJECT code (so every panel build renders the guided state) but
   * the detail carries the actionable reason instead of pretending the user
   * merely forgot a step.
   */
  const guarded = (invoke) => async (request) => {
    const projectRoot = root(request);
    const hostModel = effectiveHostModel(ctx, config);
    const { result: ensured } = bootstrapGuarded(projectRoot, hostModel);
    if (!ensured.ok) {
      return statusResponse({
        status: 404,
        body: {
          ok: false,
          error: 'NO_PROJECT',
          detail: `auto-setup failed: ${ensured.message ?? 'this workspace has no recognised stack marker'}`,
          root: projectRoot,
          pluginVersion: pkgVersion(),
        },
      });
    }
    return statusResponse(await invoke(projectRoot, request, hostModel));
  };

  const routes = [
    [SDLC_STATUS_PATH, guarded((r) => handleStatus(r))],
    [SDLC_BOARD_PATH, guarded((r) => handleBoard(r))],
    [SDLC_TASK_PATH, guarded((r, req) => handleTask(r, queryOf(req)))],
    [SDLC_COMPARE_PATH, guarded((r, req) => handleCompare(r, queryOf(req)))],
    [SDLC_CONFIG_PATH, guarded((r, _req, hostModel) => handleConfigGet(r, hostModel))],
    [SDLC_METRICS_PATH, guarded((r) => handleMetrics(r))],
    [SDLC_FLOW_PATH, guarded((r, req) => handleFlow(r, queryOf(req)))],
  ];
  for (const [path, fetch] of routes) {
    try {
      registerFenced(ctx, { path, methods: ['GET'], requestBody: 'buffered', fetch }, `sdlc-ui: ${path} Fetch route`);
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
      // The write fence is deliberate: a config write never creates .sdlc/,
      // because a POST must not materialise a project the reader never saw.
      fetch: async (request) => {
        const body = await readJson(request);
        if (!body) return statusResponse({ status: 400, body: { ok: false, error: 'BAD_JSON' } });
        return statusResponse(handleConfigPost(root(request), body));
      },
    }, `sdlc-ui: POST ${SDLC_CONFIG_PATH} Fetch route`);
    registered.push(`POST ${SDLC_CONFIG_PATH}`);
  } catch (err) {
    if (ctx?.logger?.warn) ctx.logger.warn('sdlc-ui: failed to register POST %s: %s', SDLC_CONFIG_PATH, err?.message ?? err);
  }
  try {
    registerFenced(ctx, {
      path: SDLC_HOST_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      // Explicit adoption may materialise .sdlc/ on first touch: the whole
      // point of the action is to write the Harness route into the config.
      fetch: guarded((r, _req, hostModel) => handleHostAdopt(r, hostModel)),
    }, `sdlc-ui: POST ${SDLC_HOST_PATH} Fetch route`);
    registered.push(`POST ${SDLC_HOST_PATH}`);
  } catch (err) {
    if (ctx?.logger?.warn) ctx.logger.warn('sdlc-ui: failed to register POST %s: %s', SDLC_HOST_PATH, err?.message ?? err);
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
