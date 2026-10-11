/**
 * packages/sdlc-client-ui/src/server/plugin.js — host half of the SDLC web UI.
 *
 * Registers the `sdlc.*` routes inside the connection's authentication fence
 * (the deliverables-plugin pattern: `ctx.connection.fetch.register`). All
 * state comes from the live `sdlc.db` via the pure handlers — the plugin
 * itself holds no DB handle and never takes the instance lock.
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
const require = createRequire(import.meta.url);
function selftest() {
  try {
    return require('@sdlc/orchestrator-core/selftest.js');
  } catch {
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
      ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch });
      registered.push(`GET ${path}`);
    } catch (err) {
      if (ctx?.logger?.warn) ctx.logger.warn('sdlc-ui: failed to register %s: %s', path, err?.message ?? err);
    }
  }
  try {
    ctx.connection.fetch.register({
      path: SDLC_CONFIG_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJson(request);
        if (!body) return statusResponse({ status: 400, body: { ok: false, error: 'BAD_JSON' } });
        return statusResponse(handleConfigPost(root(), body));
      },
    });
    registered.push(`POST ${SDLC_CONFIG_PATH}`);
  } catch (err) {
    if (ctx?.logger?.warn) ctx.logger.warn('sdlc-ui: failed to register POST %s: %s', SDLC_CONFIG_PATH, err?.message ?? err);
  }
  return registered;
}

export function apply(ctx, config = {}) {
  const st = selftest();
  st?.setSelftestMeta?.({ version: pkgVersion() });
  const routes = registerRoutes(ctx, config);
  // The boot-hook report has no uiRoutes field (it is pinned by M0-12); the
  // UI reports through the tools surface so the composed product stays
  // observable without changing the contract.
  st?.contributeSelftest?.({ tools: routes.length ? ['sdlc_ui_routes'] : [] });
  return { routes };
}

export default apply;
