/**
 * packages/sdlc-client-ui/src/client/flow.js — pure geometry/labels for the
 * flow visualizer. No React, no DOM: the panel stays declarative and this can
 * be unit-tested directly.
 */

export const STATE_TONE = {
  BACKLOG: 'idle',
  READY: 'ready',
  ASSIGNED: 'running',
  IN_PROGRESS: 'running',
  VERIFYING: 'verify',
  ACCEPTED: 'good',
  MERGING: 'merge',
  DONE: 'good',
  FAILED: 'bad',
  ESCALATED: 'bad',
  BLOCKED: 'warn',
  CANCELLED: 'idle',
};

export function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatTokens(tokens) {
  return tokens == null ? '—' : Number(tokens).toLocaleString('en-US');
}

export function formatCost(cost) {
  return cost == null ? '—' : `$${Number(cost).toFixed(4)}`;
}

/** Convert the host payload into render-ready geometry. */
export function buildFlowView(data) {
  const nodes = Array.isArray(data?.tasks) ? data.tasks : [];
  const rawEdges = Array.isArray(data?.edges) ? data.edges : [];
  const byLayer = new Map();
  for (const node of nodes) {
    const layer = Number.isFinite(node.layer) ? node.layer : 0;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(node);
  }

  const X = 210;
  const Y = 78;
  const placed = new Map();
  let maxPerLayer = 1;
  for (const [layer, list] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    maxPerLayer = Math.max(maxPerLayer, list.length);
    list.forEach((node, index) => {
      placed.set(node.id, { ...node, x: 24 + layer * X, y: 24 + index * Y });
    });
  }

  const edges = rawEdges.map((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return null;
    const x1 = from.x + 168;
    const y1 = from.y + 28;
    const x2 = to.x;
    const y2 = to.y + 28;
    const mid = x1 + Math.max(36, (x2 - x1) / 2);
    return {
      ...edge,
      key: `${edge.from}->${edge.to}`,
      d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
      bad: Boolean(edge.missing),
    };
  }).filter(Boolean);

  const layers = [...byLayer.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, list]) => ({ index, nodes: list.map((node) => placed.get(node.id)) }));
  return {
    nodes: [...placed.values()],
    edges,
    layers,
    width: 24 + (layers.length ? (layers.at(-1).index + 1) * X : X),
    height: 24 + maxPerLayer * Y,
    runs: Array.isArray(data?.runs) ? data.runs : [],
    routing: Array.isArray(data?.routing) ? data.routing : [],
    gates: Array.isArray(data?.gates) ? data.gates : [],
    gateSummary: data?.gateSummary ?? { pass: 0, fail: 0, skipped: 0, unknown: 0, total: 0 },
    events: Array.isArray(data?.events) ? data.events : [],
    escalations: Array.isArray(data?.escalations) ? data.escalations : [],
    locks: data?.locks ?? { cap: 1, resources: [], pathOwners: [], violations: [] },
    totals: data?.totals ?? {},
    project: data?.project ?? { available: false, reason: 'no payload' },
    unavailable: Array.isArray(data?.unavailable) ? data.unavailable : [],
    tasksTruncated: Boolean(data?.totals?.tasksTruncated),
  };
}

export default { buildFlowView, STATE_TONE, formatDuration, formatTokens, formatCost };
