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
 *   GET  /api/sdlc.config                      parsed config + validation + host model
 *   POST /api/sdlc.config                      { path, value } → validate + write
 *   POST /api/sdlc.host                        adopt the Harness provider/model
 *   GET  /api/sdlc.metrics                     Prometheus exposition text
 *   GET  /api/sdlc.flow                        bounded visualizer snapshot
 */

export const SDLC_STATUS_PATH = '/api/sdlc.status';
export const SDLC_BOARD_PATH = '/api/sdlc.board';
export const SDLC_TASK_PATH = '/api/sdlc.task';
export const SDLC_RUN_PATH = '/api/sdlc.tasks.run';
export const SDLC_COMPARE_PATH = '/api/sdlc.compare';
export const SDLC_CONFIG_PATH = '/api/sdlc.config';
export const SDLC_HOST_PATH = '/api/sdlc.host';
export const SDLC_METRICS_PATH = '/api/sdlc.metrics';
export const SDLC_FLOW_PATH = '/api/sdlc.flow';

/** Browser-relative forms (strip the leading slash for the Remote face). */
export const SDLC_STATUS_ROUTE = SDLC_STATUS_PATH.slice(1);
export const SDLC_BOARD_ROUTE = SDLC_BOARD_PATH.slice(1);
export const SDLC_TASK_ROUTE = SDLC_TASK_PATH.slice(1);
export const SDLC_RUN_ROUTE = SDLC_RUN_PATH.slice(1);
export const SDLC_COMPARE_ROUTE = SDLC_COMPARE_PATH.slice(1);
export const SDLC_CONFIG_ROUTE = SDLC_CONFIG_PATH.slice(1);
export const SDLC_HOST_ROUTE = SDLC_HOST_PATH.slice(1);
export const SDLC_METRICS_ROUTE = SDLC_METRICS_PATH.slice(1);
export const SDLC_FLOW_ROUTE = SDLC_FLOW_PATH.slice(1);

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

/** Validate the visualizer payload; every rendered array must be present. */
export function isFlowPayload(value) {
  if (!isRecord(value) || value.ok !== true) return false;
  if (!isRecord(value.project) || !isRecord(value.totals) || !isRecord(value.gateSummary)) return false;
  if (typeof value.gateSummary.pass !== 'number') return false;
  if (!isRecord(value.locks) || !Array.isArray(value.locks.resources) || !Array.isArray(value.locks.violations)) return false;
  const arrays = ['tasks', 'edges', 'runs', 'routing', 'gates', 'events', 'escalations', 'unavailable'];
  if (!arrays.every((key) => Array.isArray(value[key]))) return false;
  return value.tasks.every((t) => isRecord(t) && typeof t.id === 'string'
      && typeof t.state === 'string' && typeof t.layer === 'number')
    && value.edges.every((e) => isRecord(e) && typeof e.from === 'string' && typeof e.to === 'string')
    && value.runs.every((r) => isRecord(r) && typeof r.runId === 'string' && typeof r.taskId === 'string')
    && value.routing.every((r) => isRecord(r) && typeof r.taskId === 'string'
      && 'tier' in r && typeof r.available === 'boolean')
    && value.gates.every((g) => isRecord(g) && typeof g.gate === 'string' && typeof g.result === 'string')
    && value.events.every((e) => isRecord(e) && typeof e.id === 'number');
}

/** Validate a config-write request body. */
export function isConfigWrite(value) {
  if (!isRecord(value)) return false;
  return typeof value.path === 'string' && value.path.length > 0
    && 'value' in value;
}

export default {
  SDLC_STATUS_PATH, SDLC_BOARD_PATH, SDLC_TASK_PATH, SDLC_RUN_PATH, SDLC_COMPARE_PATH,
  SDLC_CONFIG_PATH, SDLC_HOST_PATH, SDLC_METRICS_PATH, SDLC_FLOW_PATH, sdlcReviewAddress, parseSdlcReviewAddress,
  isStatusPayload, isBoardPayload, isConfigPayload, isConfigWrite, isFlowPayload,
};
