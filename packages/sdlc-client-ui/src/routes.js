/**
 * packages/sdlc-client-ui/src/routes.js — host route contract (paths + shapes).
 *
 * Single source of truth shared by the host implementation (`server/`) and
 * the browser bundle (`client/`) without importing host-only modules into the
 * browser. Every route is authenticated through `ctx.connection.fetch`
 * (inside the connection fence); GET routes are read-only over `sdlc.db`,
 * and the one POST route validates through the same `validateConfig` the CLI
 * uses before writing `.sdlc/config.yml`.
 *
 * Routes (all JSON):
 *   GET  /api/sdlc.status                      project + tasks + spend
 *   GET  /api/sdlc.board                       tasks grouped by state + blockers
 *   GET  /api/sdlc.task?id=<id>                one task + events + gates + runs
 *   GET  /api/sdlc.compare?task=<id>&a=<run>&b=<run>   compareRuns() JSON
 *   GET  /api/sdlc.config                      parsed config + validation
 *   POST /api/sdlc.config                      { path, value } → validate + write
 *   GET  /api/sdlc.metrics                     Prometheus exposition text
 */

export const SDLC_STATUS_PATH = '/api/sdlc.status';
export const SDLC_BOARD_PATH = '/api/sdlc.board';
export const SDLC_TASK_PATH = '/api/sdlc.task';
export const SDLC_COMPARE_PATH = '/api/sdlc.compare';
export const SDLC_CONFIG_PATH = '/api/sdlc.config';
export const SDLC_METRICS_PATH = '/api/sdlc.metrics';

/** Browser-relative forms (strip the leading slash for the Remote face). */
export const SDLC_STATUS_ROUTE = SDLC_STATUS_PATH.slice(1);
export const SDLC_BOARD_ROUTE = SDLC_BOARD_PATH.slice(1);
export const SDLC_TASK_ROUTE = SDLC_TASK_PATH.slice(1);
export const SDLC_COMPARE_ROUTE = SDLC_COMPARE_PATH.slice(1);
export const SDLC_CONFIG_ROUTE = SDLC_CONFIG_PATH.slice(1);
export const SDLC_METRICS_ROUTE = SDLC_METRICS_PATH.slice(1);

/** Resource-address prefix of an SDLC review tab in the right sidebar. */
export const SDLC_REVIEW_ADDRESS = 'dsh-resource://sdlc-review/task/';

export function sdlcReviewAddress(taskId) {
  return `${SDLC_REVIEW_ADDRESS}${encodeURIComponent(taskId)}`;
}

export function parseSdlcReviewAddress(address) {
  const prefix = SDLC_REVIEW_ADDRESS;
  if (typeof address !== 'string' || !address.startsWith(prefix)) return undefined;
  const taskId = decodeURIComponent(address.slice(prefix.length));
  return taskId ? { taskId } : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a status payload read from the status route. */
export function isStatusPayload(value) {
  if (!isRecord(value)) return false;
  return typeof value.ok === 'boolean'
    && isRecord(value.tasks) && typeof value.tasks.total === 'number'
    && isRecord(value.spend);
}

/** Validate a board payload: tasks grouped by state. */
export function isBoardPayload(value) {
  if (!isRecord(value)) return false;
  return Array.isArray(value.columns)
    && value.columns.every((c) => isRecord(c) && typeof c.state === 'string' && Array.isArray(c.tasks));
}

/** Validate the config payload: parsed config + validation result. */
export function isConfigPayload(value) {
  if (!isRecord(value)) return false;
  return isRecord(value.config) && isRecord(value.validation)
    && typeof value.validation.ok === 'boolean'
    && Array.isArray(value.validation.errors);
}

/** Validate a config-write request body. */
export function isConfigWrite(value) {
  if (!isRecord(value)) return false;
  return typeof value.path === 'string' && value.path.length > 0
    && 'value' in value;
}

export default {
  SDLC_STATUS_PATH, SDLC_BOARD_PATH, SDLC_TASK_PATH, SDLC_COMPARE_PATH,
  SDLC_CONFIG_PATH, SDLC_METRICS_PATH, sdlcReviewAddress, parseSdlcReviewAddress,
  isStatusPayload, isBoardPayload, isConfigPayload, isConfigWrite,
};
