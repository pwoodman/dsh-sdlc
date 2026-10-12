/**
 * packages/sdlc-client-ui/src/client/api.js — browser fetch face over the `sdlc.*` routes.
 *
 * Zero dependencies, no framework: thin JSON helpers with the same
 * never-fabricate rule as the eval collectors — an unmeasurable endpoint
 * resolves to `{ available: false, reason }`, never to a zero.
 */

import {
  SDLC_STATUS_ROUTE, SDLC_BOARD_ROUTE, SDLC_TASK_ROUTE, SDLC_COMPARE_ROUTE,
  SDLC_CONFIG_ROUTE, SDLC_METRICS_ROUTE,
  isStatusPayload, isBoardPayload, isConfigPayload,
} from '../routes.js';

async function getJson(path) {
  let res;
  try {
    res = await fetch(`/${path}`, { headers: { accept: 'application/json' } });
  } catch (err) {
    return { available: false, reason: `network: ${err?.message ?? err}` };
  }
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { detail = res.statusText; }
    return { available: false, reason: `http ${res.status}: ${detail.slice(0, 200)}` };
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

export async function fetchStatus() {
  const res = await getJson(SDLC_STATUS_ROUTE);
  if (!res.available) return res;
  if (!isStatusPayload(res.data)) return { available: false, reason: 'host returned a malformed status payload' };
  return res;
}

export async function fetchBoard() {
  const res = await getJson(SDLC_BOARD_ROUTE);
  if (!res.available) return res;
  if (!isBoardPayload(res.data)) return { available: false, reason: 'host returned a malformed board payload' };
  return res;
}

export async function fetchTask(id) {
  return getJson(`${SDLC_TASK_ROUTE}?id=${encodeURIComponent(id)}`);
}

export async function fetchCompare(task, a, b) {
  const q = `task=${encodeURIComponent(task)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
  return getJson(`${SDLC_COMPARE_ROUTE}?${q}`);
}

export async function fetchConfig() {
  const res = await getJson(SDLC_CONFIG_ROUTE);
  if (!res.available) return res;
  if (!isConfigPayload(res.data)) return { available: false, reason: 'host returned a malformed config payload' };
  return res;
}

export async function writeConfig(path, value) {
  return postJson(SDLC_CONFIG_ROUTE, { path, value });
}

export async function fetchMetrics() {
  try {
    const res = await fetch(`/${SDLC_METRICS_ROUTE}`, { headers: { accept: 'text/plain' } });
    if (!res.ok) return { available: false, reason: `http ${res.status}` };
    return { available: true, data: await res.text() };
  } catch (err) {
    return { available: false, reason: `network: ${err?.message ?? err}` };
  }
}

/**
 * The single api face the client consumes. NAMED on purpose: the closure-factory
 * bundle concatenates the client sources into one scope, where a default import
 * of this module would be stripped UNBOUND (`api is not defined` at client
 * apply — shipped broken until the entry contract test called apply). The
 * default export stays for source-level ergonomics; the bundler strips it.
 */
export const api = { fetchStatus, fetchBoard, fetchTask, fetchCompare, fetchConfig, writeConfig, fetchMetrics };

export default api;
