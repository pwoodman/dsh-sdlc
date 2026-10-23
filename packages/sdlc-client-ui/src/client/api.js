/**
 * packages/sdlc-client-ui/src/client/api.js — browser fetch face over the `sdlc.*` routes.
 *
 * Zero dependencies, no framework: thin JSON helpers with the same
 * never-fabricate rule as the eval collectors — an unmeasurable endpoint
 * resolves to `{ available: false, reason }`, never to a zero.
 *
 * Every call carries the active session's `cwd`. The host plugin is not
 * session-scoped, so without it the Desktop app reads the Harness profile
 * directory instead of the open workspace.
 */

import {
  SDLC_STATUS_ROUTE, SDLC_BOARD_ROUTE, SDLC_TASK_ROUTE, SDLC_COMPARE_ROUTE,
  SDLC_CONFIG_ROUTE, SDLC_HOST_ROUTE, SDLC_METRICS_ROUTE, SDLC_FLOW_ROUTE,
  isStatusPayload, isBoardPayload, isConfigPayload, isFlowPayload,
} from '../routes.js';

/**
 * Build-time constant injected by scripts/build-ui.mjs (`var __SDLC_VERSION__`).
 * Source-level test imports see the guarded fallback instead of a ReferenceError.
 */
const PANEL_VERSION = typeof __SDLC_VERSION__ === 'string' ? __SDLC_VERSION__ : 'dev';

/** The panel build, for mismatch diagnostics. */
export function clientVersion() {
  return PANEL_VERSION;
}

/** Attach the session workspace to a route without losing existing params. */
function withCwd(path, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return path;
  return `${path}${path.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(cwd)}`;
}

async function getJson(path) {
  let res;
  try {
    res = await fetch(`/${path}`, { headers: { accept: 'application/json' } });
  } catch (err) {
    return { available: false, reason: `network: ${err?.message ?? err}` };
  }
  if (!res.ok) {
    let detail = '';
    let code = null;
    let message = null;
    try {
      const payload = await res.json();
      code = typeof payload?.error === 'string' ? payload.error : null;
      message = typeof payload?.detail === 'string' ? payload.detail : null;
      detail = payload?.detail ? `${payload.error ?? 'error'}: ${payload.detail}` : JSON.stringify(payload);
    } catch {
      detail = res.statusText;
    }
    // `message` is the host's own detail string, unmunged, for callers that
    // render it to the user (e.g. the auto-setup failure card).
    return { available: false, status: res.status, code, message, reason: `http ${res.status}: ${detail.slice(0, 200)}` };
  }
  try {
    return { available: true, data: await res.json() };
  } catch {
    return { available: false, reason: 'invalid JSON from host' };
  }
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(`/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { available: false, reason: `network: ${err?.message ?? err}` };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data) {
    return { available: false, reason: `http ${res.status}: ${JSON.stringify(data)?.slice(0, 200) ?? res.statusText}` };
  }
  return { available: true, data };
}

/**
 * Classify a missing flow route instead of guessing "the host is old".
 *
 * - the status route answers (even NO_PROJECT) and flow 404s → the loaded host
 *   is an older build that predates the flow route;
 * - every SDLC route 404s → the host plugin is not registered/enabled;
 * - the probe cannot reach the server at all → network/transport problem.
 *
 * @param {string} [cwd] - active session workspace.
 * @returns {Promise<{answered: boolean, statusRoutePresent: boolean, status: number|null, code: string|null, pluginVersion: string|null}>}
 */
async function probeStatus(cwd) {
  const res = await getJson(withCwd(SDLC_STATUS_ROUTE, cwd));
  return {
    answered: res.available === true || res.status !== undefined,
    statusRoutePresent: res.available === true || res.code === 'NO_PROJECT'
      || (res.status !== undefined && res.status !== 404),
    status: res.status ?? null,
    code: res.code ?? null,
    pluginVersion: res.available && typeof res.data?.pluginVersion === 'string' ? res.data.pluginVersion : null,
  };
}

export async function fetchStatus(cwd) {
  const res = await getJson(withCwd(SDLC_STATUS_ROUTE, cwd));
  if (!res.available) return res;
  if (!isStatusPayload(res.data)) return { available: false, reason: 'host returned a malformed status payload' };
  return res;
}

export async function fetchBoard(cwd) {
  const res = await getJson(withCwd(SDLC_BOARD_ROUTE, cwd));
  if (!res.available) return res;
  if (!isBoardPayload(res.data)) return { available: false, reason: 'host returned a malformed board payload' };
  return res;
}

export async function fetchTask(id, cwd) {
  return getJson(withCwd(`${SDLC_TASK_ROUTE}?id=${encodeURIComponent(id)}`, cwd));
}

export async function fetchCompare(task, a, b, cwd) {
  const q = `task=${encodeURIComponent(task)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
  return getJson(withCwd(`${SDLC_COMPARE_ROUTE}?${q}`, cwd));
}

export async function fetchConfig(cwd) {
  const res = await getJson(withCwd(SDLC_CONFIG_ROUTE, cwd));
  if (!res.available) return res;
  if (!isConfigPayload(res.data)) return { available: false, reason: 'host returned a malformed config payload' };
  return res;
}

export async function writeConfig(path, value, cwd) {
  return postJson(withCwd(SDLC_CONFIG_ROUTE, cwd), { path, value });
}

/**
 * Adopt the Harness's current provider/model as the orchestrator tiers.
 * Explicit user action; no credential or API key is sent.
 * @param {string} [cwd] - active session workspace.
 */
export async function adoptHostModel(cwd) {
  return postJson(withCwd(SDLC_HOST_ROUTE, cwd), {});
}

export async function fetchMetrics(cwd) {
  try {
    const res = await fetch(`/${withCwd(SDLC_METRICS_ROUTE, cwd)}`, { headers: { accept: 'text/plain' } });
    if (!res.ok) return { available: false, reason: `http ${res.status}` };
    return { available: true, data: await res.text() };
  } catch (err) {
    return { available: false, reason: `network: ${err?.message ?? err}` };
  }
}

export async function fetchFlow({ task = null, events = 100, after = 0, cwd = undefined } = {}) {
  const params = new URLSearchParams({ events: String(events), after: String(after) });
  if (task) params.set('task', task);
  if (typeof cwd === 'string' && cwd !== '') params.set('cwd', cwd);
  const res = await getJson(`${SDLC_FLOW_ROUTE}?${params}`);
  if (!res.available) {
    // A 404 NO_PROJECT now means auto-setup genuinely failed on the host
    // (e.g. an unwritable workspace) — the panel card carries the real
    // reason; every other workspace is ready and active instead. Keep a
    // fallback for older hosts that send no detail. Any other 404 needs a
    // probe: "the panel is newer" is only one explanation, and the running
    // Desktop app is the common case (it keeps the old host loaded).
    if (res.status === 404 && res.code === 'NO_PROJECT') {
      return {
        available: false,
        code: 'NO_PROJECT',
        reason: res.message ?? 'auto-setup could not complete this workspace — `sdlc init` prints the same reason',
      };
    }
    // A workspace whose projects table has no row for THIS root is set up
    // and ready — a project is active as soon as the Lead is touched. The
    // panel shows the ready state with the goal-describing hint below.
    if (res.status === 404 && res.code === 'NO_PROJECT_ROW') {
      return {
        available: false,
        code: 'NO_PROJECT_ROW',
        reason: res.message ?? 'workspace is ready and a project is active — describe your goal to the Lead',
      };
    }
    if (res.status === 404) {
      const probe = await probeStatus(cwd);
      if (probe.statusRoutePresent) {
        return {
          available: false,
          code: 'HOST_OUTDATED',
          reason: '/api/sdlc.flow is not registered, but /api/sdlc.status does answer: the loaded host is an older build',
          probe,
          panelVersion: PANEL_VERSION,
        };
      }
      if (probe.answered) {
        return {
          available: false,
          code: 'HOST_MISSING',
          reason: 'no SDLC route answered — the host plugin is not registered or enabled in this profile',
          probe,
          panelVersion: PANEL_VERSION,
        };
      }
      return {
        available: false,
        code: 'HOST_UNREACHABLE',
        reason: 'could not reach the Harness host to diagnose /api/sdlc.flow',
        probe,
        panelVersion: PANEL_VERSION,
      };
    }
    return res;
  }
  if (!isFlowPayload(res.data)) return { available: false, reason: 'host returned a malformed flow payload' };
  return res;
}

/**
 * The single api face the client consumes. NAMED on purpose: the closure-factory
 * bundle concatenates the client sources into one scope, where a default import
 * of this module would be stripped UNBOUND (`api is not defined` at client
 * apply — shipped broken until the entry contract test called apply). The
 * default export stays for source-level ergonomics; the bundler strips it.
 */
export const api = {
  fetchStatus, fetchBoard, fetchTask, fetchCompare, fetchConfig, writeConfig, adoptHostModel, fetchMetrics, fetchFlow,
  clientVersion,
};

export default api;
