/**
 * packages/sdlc-client-ui/src/client/flow.js — pure geometry/labels for the
 * flow visualizer. No React, no DOM: the panel stays declarative and this can
 * be unit-tested directly.
 *
 * The UI is attention-driven, so this module derives three things the host
 * payload does not pre-compute:
 *   - `attention`: everything that needs a human or is actively failing,
 *   - `taskDetail`: one task plus its runs, gates, routing and dependencies,
 *   - `reviewOptions`: the two-run picker input for the Review panel.
 * Nothing here invents data: unknown values stay null and render as "—".
 */

export const STATE_ORDER = [
  'BACKLOG', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'VERIFYING',
  'ACCEPTED', 'MERGING', 'DONE', 'FAILED', 'ESCALATED', 'BLOCKED', 'CANCELLED',
];

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

const ACTIVE_STATES = new Set(['ASSIGNED', 'IN_PROGRESS', 'VERIFYING', 'MERGING']);
const BLOCKED_STATES = new Set(['FAILED', 'ESCALATED', 'BLOCKED']);
const DONE_STATES = new Set(['DONE']);

export function toneOfState(state) {
  return STATE_TONE[state] ?? 'idle';
}

export function isActiveState(state) {
  return ACTIVE_STATES.has(state);
}

export function isBlockedState(state) {
  return BLOCKED_STATES.has(state);
}

export function isDoneState(state) {
  return DONE_STATES.has(state);
}

/** Lifecycle rank; unknown states sort last, deterministically. */
export function stateRank(state) {
  const index = STATE_ORDER.indexOf(state);
  return index === -1 ? STATE_ORDER.length : index;
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatTokens(tokens) {
  return tokens == null ? '—' : Number(tokens).toLocaleString('en-US');
}

/** Compact token counts for SVG labels: 69,600 → 69.6k. */
export function formatCompactTokens(tokens) {
  if (tokens == null) return '—';
  const value = Number(tokens);
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

/** Costs are tiny; keep four decimals below a cent, otherwise stay compact. */
export function formatCost(cost) {
  if (cost == null) return '—';
  const value = Number(cost);
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (Math.abs(value) < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Signed delta for the review table, e.g. +1.2s / −450 tok / 0. */
export function formatDelta(delta, unit = '') {
  if (delta == null || !Number.isFinite(Number(delta))) return '—';
  const value = Number(delta);
  if (value === 0) return '0';
  const sign = value > 0 ? '+' : '−';
  const abs = Math.abs(value);
  const shown = abs < 10 ? abs.toFixed(abs % 1 === 0 ? 0 : 1) : Math.round(abs).toLocaleString('en-US');
  return `${sign}${shown}${unit}`;
}

/** Signed cost delta: +$0.003 / −$0.001 / $0, never a bare number. */
export function formatCostDelta(delta) {
  if (delta == null || !Number.isFinite(Number(delta))) return '—';
  const value = Number(delta);
  if (value === 0) return '$0';
  return `${value > 0 ? '+' : '−'}${formatCost(Math.abs(value))}`;
}

/** "just now" / "3m ago" — used for run starts and event rows. */
export function formatRelativeTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1m ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Model ids are provider-specific; the sidebar shows the leaf name only. */
export function shortModel(model) {
  if (!model) return null;
  return String(model).split('/').at(-1);
}

/**
 * The tasks that need someone to act, in severity order.
 *
 * Derived only from the flow payload: failing gates, unresolved escalations,
 * failed tasks, orphaned runs and resource-lock violations. A healthy project
 * returns []. `taskId` is present whenever the issue can be traced to a task,
 * so the UI can open that task's detail.
 *
 * @param {object} view - output of buildFlowView().
 * @returns {object[]}
 */
export function buildAttention(view) {
  const issues = [];
  const failedGateTasks = new Map();
  for (const gate of view.gates) {
    if (gate.result !== 'fail') continue;
    if (!failedGateTasks.has(gate.taskId)) failedGateTasks.set(gate.taskId, []);
    failedGateTasks.get(gate.taskId).push(gate);
  }
  for (const [taskId, gates] of failedGateTasks) {
    issues.push({
      id: `gates:${taskId}`,
      kind: 'failedGates',
      severity: 1,
      tone: 'bad',
      taskId,
      count: gates.length,
      gate: gates[0]?.gate ?? null,
    });
  }

  const escalated = new Set();
  for (const item of view.escalations) {
    if (item.resolution) continue;
    if (item.taskId) escalated.add(item.taskId);
    issues.push({
      id: `escalation:${item.id}`,
      kind: 'escalation',
      severity: 0,
      tone: 'warn',
      taskId: item.taskId ?? null,
      level: item.level ?? null,
      question: item.question ?? null,
      source: item.source ?? null,
    });
  }

  for (const node of view.nodes) {
    if (node.state !== 'FAILED' || escalated.has(node.id)) continue;
    issues.push({
      id: `task:${node.id}`,
      kind: 'failedTask',
      severity: 1,
      tone: 'bad',
      taskId: node.id,
    });
  }

  const orphaned = view.runs.filter((run) => run.orphaned);
  if (orphaned.length > 0) {
    issues.push({
      id: 'orphaned',
      kind: 'orphanedRuns',
      severity: 2,
      tone: 'warn',
      taskId: orphaned[0].taskId ?? null,
      count: orphaned.length,
    });
  }

  for (const violation of view.locks.violations ?? []) {
    issues.push({
      id: `lock:${violation.kind}:${violation.a}:${violation.b}`,
      kind: 'lockViolation',
      severity: 0,
      tone: 'bad',
      taskId: violation.a ?? null,
      otherTaskId: violation.b ?? null,
      lockKind: violation.kind ?? null,
      a: violation.a ?? null,
      b: violation.b ?? null,
    });
  }

  return issues.sort((a, b) => a.severity - b.severity);
}

/** Attention issues for one task (used to badge task rows). */
export function attentionForTask(view, taskId) {
  return buildAttention(view).filter((issue) => issue.taskId === taskId || issue.otherTaskId === taskId);
}

/**
 * One task with everything the sidebar needs to explain it.
 *
 * @param {object} view
 * @param {string|null} taskId
 * @returns {object|null}
 */
export function buildTaskDetail(view, taskId) {
  if (!taskId) return null;
  const node = view.nodes.find((candidate) => candidate.id === taskId);
  if (!node) return null;
  const runs = view.runs.filter((run) => run.taskId === taskId);
  const gates = view.gates.filter((gate) => gate.taskId === taskId);
  const routing = view.routing.find((route) => route.taskId === taskId) ?? null;
  const dependencies = (node.dependsOn ?? []).map((id) => {
    const dep = view.nodes.find((candidate) => candidate.id === id);
    return dep ?? { id, title: null, state: null };
  });
  const latestEvent = view.events.filter((event) => event.taskId === taskId).at(-1) ?? null;
  const activeRun = runs.find((run) => run.finishedAt == null && run.status !== 'completed' && run.status !== 'failed')
    ?? runs.find((run) => run.durationSource === 'live' && run.status !== 'completed' && run.status !== 'failed')
    ?? null;
  return {
    ...node,
    runs,
    activeRun,
    gates,
    failingGates: gates.filter((gate) => gate.result === 'fail'),
    routing,
    dependencies,
    blockedBy: dependencies.filter((dep) => dep.state != null && !isDoneState(dep.state)),
    latestEvent,
    attention: attentionForTask(view, taskId),
    canCompare: runs.length >= 2,
  };
}

/**
 * Review-panel input for a task: its runs, newest first, plus the default
 * A/B pair (A = older baseline, B = newest run). `canCompare` is false when
 * the task has fewer than two recorded runs.
 *
 * @param {object} view
 * @param {string|null} taskId
 * @returns {{runs: object[], a: string, b: string, canCompare: boolean}}
 */
export function reviewOptions(view, taskId) {
  const runs = taskId ? view.runs.filter((run) => run.taskId === taskId) : [];
  return {
    runs,
    a: runs[1]?.runId ?? '',
    b: runs[0]?.runId ?? '',
    canCompare: runs.length >= 2,
  };
}

/**
 * Stage summary for the DAG rail: counts per tone plus a short human line
 * ("1 active · 8 ready"). Locale-free: the component translates the counts.
 *
 * @param {object[]} nodes
 * @returns {{total:number, active:number, done:number, blocked:number, byState:object}}
 */
export function summarizeNodes(nodes) {
  const byState = {};
  let active = 0;
  let done = 0;
  let blocked = 0;
  for (const node of nodes) {
    byState[node.state] = (byState[node.state] ?? 0) + 1;
    if (isActiveState(node.state)) active += 1;
    if (isDoneState(node.state)) done += 1;
    if (isBlockedState(node.state)) blocked += 1;
  }
  return { total: nodes.length, active, done, blocked, byState };
}

/** Defaults for the animated DAG map (pure units; the panel only draws them). */
export const GRAPH_DEFAULTS = {
  width: 360,
  padX: 10,
  padTop: 8,
  gapX: 8,
  gapY: 10,
  nodeHeight: 60,
  rowLabel: 15,
  rowGap: 26,
  minNodeWidth: 100,
  maxNodeWidth: 190,
  maxPerRow: 3,
  maxNodes: 60,
};

function svgRound(value) {
  return Math.round(value * 100) / 100;
}

/** Truncate a label to the node width without measuring in the DOM. */
export function svgTruncate(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Split a title into at most two SVG lines sized for the node. */
export function svgTitleLines(title, width) {
  const maxChars = Math.max(8, Math.floor((width - 20) / 6));
  const words = String(title ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === 1) break;
  }
  if (current && lines.length < 2) lines.push(current);
  if (lines.length === 2 && words.join(' ').length > lines.join(' ').length) {
    lines[1] = svgTruncate(lines[1], maxChars);
  }
  if (lines.length === 0) lines.push(svgTruncate(title ?? '', maxChars));
  return lines.slice(0, 2);
}

/**
 * How one dependency edge should light up.
 *
 * The map answers "where is work moving": an edge into or out of a running
 * task streams, a fully completed dependency is a steady lit path, a blocked
 * or failed target is a red warning edge, and everything else stays quiet.
 *
 * @param {object} from
 * @param {object} to
 * @param {object} [edge]
 * @returns {'active'|'done'|'ready'|'blocked'|'pending'}
 */
export function edgeVisualState(from, to, edge = {}) {
  if (!from || !to) return 'pending';
  if (edge.missing) return 'blocked';
  if (isBlockedState(to.state)) return 'blocked';
  if (isActiveState(to.state) || isActiveState(from.state)) return 'active';
  if (isDoneState(to.state) && isDoneState(from.state)) return 'done';
  if (isDoneState(from.state)) return 'ready';
  return 'pending';
}

/** Rank a node for the map: live work first, then blocked, ready, done, idle. */
function graphNodeRank(node, view) {
  if (isActiveState(node.state) || view.activeRuns.some((run) => run.taskId === node.id)) return 0;
  if (isBlockedState(node.state)) return 1;
  if (isDoneState(node.state)) return 3;
  if (node.state === 'READY') return 2;
  return 4;
}

/**
 * Layout the DAG as vertical stage bands with parallel tasks side by side.
 *
 * Returns SVG-ready geometry: nodes carry x/y/w/h, edges carry a bezier `d`
 * and the number of travelling packets, and `rows` carry stage labels. The
 * layout is deterministic and bounded (maxNodes); a layer wider than
 * `maxPerRow` wraps into sub-rows so the sidebar never scrolls sideways for a
 * normal fan-out. Within a layer, live work sorts first, then blocked, ready,
 * done and idle, so the wrapped row keeps the urgent nodes visible.
 *
 * @param {object} view - buildFlowView() output.
 * @param {object} [options]
 * @returns {{width:number,height:number,rows:object[],nodes:object[],edges:object[],omitted:number}}
 */
export function buildFlowGraph(view, options = {}) {
  const o = { ...GRAPH_DEFAULTS, ...options };
  const usable = Math.max(1, o.width - o.padX * 2);
  const rows = [];
  const nodes = new Map();
  let rowY = o.padTop;
  let maxRowWidth = 0;
  let lastNodeBottom = 0;
  let included = 0;

  for (const layer of view.layers) {
    if (included >= o.maxNodes) break;
    const remaining = o.maxNodes - included;
    const take = layer.nodes.slice(0, remaining).sort((a, b) => (
      graphNodeRank(a, view) - graphNodeRank(b, view)
      || String(a.id).localeCompare(String(b.id))
    ));
    if (take.length === 0) continue;
    const count = take.length;
    // At most `maxPerRow` parallel nodes share a sub-row. Three 104-unit nodes
    // plus gaps fit a 360-unit sidebar, so a wide fan-out wraps vertically
    // instead of forcing a long horizontal scroll.
    const chunks = [];
    for (let start = 0; start < count; start += o.maxPerRow) {
      chunks.push(take.slice(start, start + o.maxPerRow));
    }
    const chunkY = rowY + o.rowLabel;
    let cursorY = chunkY;
    let firstOffset = o.padX;
    let layerRowWidth = 0;

    for (let c = 0; c < chunks.length; c += 1) {
      const chunk = chunks[c];
      const n = chunk.length;
      const rawWidth = n > 1
        ? (usable - o.gapX * (n - 1)) / n
        : Math.min(usable, o.maxNodeWidth);
      const nodeWidth = Math.max(o.minNodeWidth, Math.min(o.maxNodeWidth, rawWidth));
      const rowWidth = n * nodeWidth + o.gapX * (n - 1);
      const offset = o.padX + Math.max(0, (usable - rowWidth) / 2);
      if (c === 0) firstOffset = offset;
      layerRowWidth = Math.max(layerRowWidth, rowWidth);
      maxRowWidth = Math.max(maxRowWidth, rowWidth);

      for (let index = 0; index < n; index += 1) {
        const node = chunk[index];
        const activeRun = view.activeRuns.find((run) => run.taskId === node.id) ?? null;
        nodes.set(node.id, {
          ...node,
          x: svgRound(offset + index * (nodeWidth + o.gapX)),
          y: svgRound(cursorY),
          w: svgRound(nodeWidth),
          h: o.nodeHeight,
          stage: layer.index,
          live: isActiveState(node.state) || activeRun != null,
          activeRun,
        });
      }
      cursorY += o.nodeHeight + o.gapY;
    }

    lastNodeBottom = cursorY - o.gapY;
    rows.push({
      index: layer.index,
      y: svgRound(rowY),
      labelY: svgRound(rowY + 9),
      x: svgRound(firstOffset),
      width: svgRound(layerRowWidth),
      nodeY: svgRound(chunkY),
      nodes: take.map((node) => node.id),
      summary: layer.summary,
      parallel: count > 1,
      subrows: chunks.length,
    });

    included += count;
    rowY = lastNodeBottom + o.rowGap;
    if (take.length < layer.nodes.length) break;
  }

  const edges = [];
  for (let index = 0; index < view.edges.length; index += 1) {
    const edge = view.edges[index];
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to || to.y <= from.y) continue;
    const sx = svgRound(from.x + from.w / 2);
    const sy = svgRound(from.y + from.h);
    const tx = svgRound(to.x + to.w / 2);
    const ty = svgRound(to.y);
    const dy = ty - sy;
    const state = edgeVisualState(from, to, edge);
    const activeRuns = view.activeRuns.filter((run) => run.taskId === edge.to || run.taskId === edge.from);
    edges.push({
      ...edge,
      index,
      key: edge.key ?? `${edge.from}->${edge.to}`,
      fromNode: from,
      toNode: to,
      d: `M ${sx} ${sy} C ${sx} ${svgRound(sy + dy * 0.45)}, ${tx} ${svgRound(ty - dy * 0.45)}, ${tx} ${ty}`,
      state,
      packets: state === 'active' ? Math.min(3, Math.max(1, activeRuns.length)) : 0,
      parallel: activeRuns.length > 1,
    });
  }

  const graphWidth = Math.max(o.width, maxRowWidth + o.padX * 2);
  const height = rows.length === 0
    ? o.nodeHeight + o.rowLabel + o.padTop * 2
    : svgRound(lastNodeBottom + o.padTop);

  return {
    width: svgRound(graphWidth),
    height,
    rows,
    nodes: [...nodes.values()],
    edges,
    omitted: Math.max(0, view.nodes.length - included),
  };
}

/**
 * Everything upstream (dependencies) and downstream (dependants) of a task.
 * Used for path tracing on hover/selection — the Archify-style "light the
 * route" interaction, computed locally from the snapshot.
 *
 * @param {object} view
 * @param {string|null} taskId
 * @returns {{focus:string,nodes:Set,edges:Set}|null}
 */
export function buildTrace(view, taskId) {
  if (!taskId || !view.nodes.some((node) => node.id === taskId)) return null;
  const upstream = new Map();
  const downstream = new Map();
  for (const edge of view.edges) {
    const key = edge.key ?? `${edge.from}->${edge.to}`;
    if (!downstream.has(edge.from)) downstream.set(edge.from, []);
    downstream.get(edge.from).push({ id: edge.to, key });
    if (!upstream.has(edge.to)) upstream.set(edge.to, []);
    upstream.get(edge.to).push({ id: edge.from, key });
  }
  const nodes = new Set([taskId]);
  const edges = new Set();
  const walk = (graph) => {
    const queue = [taskId];
    while (queue.length > 0) {
      const id = queue.shift();
      for (const link of graph.get(id) ?? []) {
        edges.add(link.key);
        if (!nodes.has(link.id)) {
          nodes.add(link.id);
          queue.push(link.id);
        }
      }
    }
  };
  walk(upstream);
  walk(downstream);
  return { focus: taskId, nodes, edges };
}

/**
 * Concurrency actually visible in the snapshot.
 *
 * `effective` comes from the host (host CPU/RAM + config); when an older host
 * omits it, `cap` stays null rather than inventing a number. `active` counts
 * both active tasks and active runs so the panel never under-reports work.
 *
 * @param {object} view
 * @returns {{cap:number|null,configured:number|string|null,effective:number|null,active:number,activeRuns:number,activeTasks:number,saturated:boolean,free:number|null}}
 */
export function summarizeParallel(view) {
  const info = view?.totals?.parallelism ?? null;
  const configured = info?.configured ?? view?.totals?.maxParallelWorkers ?? null;
  const effective = Number.isFinite(info?.effective) ? info.effective : null;
  const numericConfigured = configured == null || configured === '' ? NaN : Number(configured);
  const cap = effective ?? (Number.isFinite(numericConfigured) && numericConfigured > 0 ? numericConfigured : null);
  const activeRuns = view?.activeRuns?.length ?? 0;
  const activeTasks = (view?.nodes ?? []).filter((node) => isActiveState(node.state)).length;
  const active = Math.max(activeRuns, activeTasks);
  return {
    cap,
    configured,
    effective,
    active,
    activeRuns,
    activeTasks,
    saturated: cap != null && active >= cap,
    free: cap == null ? null : Math.max(0, cap - active),
  };
}

/**
 * Token-per-outcome view derived only from recorded run totals. If no run has
 * a token count, the derived rates are null (never a fabricated zero).
 *
 * @param {object} view
 */
export function summarizeEfficiency(view) {
  const runs = view?.runs ?? [];
  const tokenRuns = runs.filter((run) => run.tokensTotal != null);
  const tokens = tokenRuns.length > 0
    ? tokenRuns.reduce((sum, run) => sum + Number(run.tokensTotal ?? 0), 0)
    : null;
  const done = view?.done ?? 0;
  const activeRuns = view?.activeRuns ?? [];
  const activeTokenRuns = activeRuns.filter((run) => run.tokensTotal != null);
  return {
    tokens,
    tokensPerDoneTask: tokens != null && done > 0 ? Math.round(tokens / done) : null,
    activeTokens: activeTokenRuns.length > 0
      ? activeTokenRuns.reduce((sum, run) => sum + Number(run.tokensTotal ?? 0), 0)
      : null,
  };
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

  // Runs are newest-first within a task (see server/flow.js). Index them so a
  // task card can show "2 runs" / its latest outcome without a second pass.
  const runsByTask = new Map();
  for (const run of Array.isArray(data?.runs) ? data.runs : []) {
    if (!runsByTask.has(run.taskId)) runsByTask.set(run.taskId, []);
    runsByTask.get(run.taskId).push(run);
  }
  const failingGatesByTask = new Map();
  for (const gate of Array.isArray(data?.gates) ? data.gates : []) {
    if (gate.result !== 'fail') continue;
    failingGatesByTask.set(gate.taskId, (failingGatesByTask.get(gate.taskId) ?? 0) + 1);
  }
  for (const [id, node] of placed) {
    const taskRuns = runsByTask.get(id) ?? [];
    placed.set(id, {
      ...node,
      runCount: taskRuns.length,
      latestRun: taskRuns[0] ?? null,
      failingGates: failingGatesByTask.get(id) ?? 0,
    });
  }

  const layers = [...byLayer.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, list]) => {
      const layerNodes = list.map((node) => placed.get(node.id));
      return { index, nodes: layerNodes, summary: summarizeNodes(layerNodes) };
    });

  const stateCounts = {};
  for (const node of nodes) stateCounts[node.state] = (stateCounts[node.state] ?? 0) + 1;
  const stateSegments = Object.entries(stateCounts)
    .sort((a, b) => stateRank(a[0]) - stateRank(b[0]))
    .map(([state, count]) => ({ state, count, tone: STATE_TONE[state] ?? 'idle' }));
  const done = stateCounts.DONE ?? 0;
  const activeRuns = (Array.isArray(data?.runs) ? data.runs : []).filter((run) => (
    run.finishedAt == null && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled'
  ));
  return {
    nodes: [...placed.values()],
    edges,
    layers,
    width: 24 + (layers.length ? (layers.at(-1).index + 1) * X : X),
    height: 24 + maxPerLayer * Y,
    runs: Array.isArray(data?.runs) ? data.runs : [],
    activeRuns,
    routing: Array.isArray(data?.routing) ? data.routing : [],
    gates: Array.isArray(data?.gates) ? data.gates : [],
    gateSummary: data?.gateSummary ?? { pass: 0, fail: 0, skipped: 0, unknown: 0, total: 0 },
    events: Array.isArray(data?.events) ? data.events : [],
    escalations: Array.isArray(data?.escalations) ? data.escalations : [],
    locks: data?.locks ?? { cap: 1, resources: [], pathOwners: [], violations: [] },
    totals: data?.totals ?? {},
    stateCounts,
    stateSegments,
    done,
    generatedAt: data?.generatedAt ?? null,
    project: data?.project ?? { available: false, reason: 'no payload' },
    unavailable: Array.isArray(data?.unavailable) ? data.unavailable : [],
    tasksTruncated: Boolean(data?.totals?.tasksTruncated),
  };
}

export default {
  buildFlowView, buildAttention, attentionForTask, buildTaskDetail, reviewOptions,
  summarizeNodes, buildFlowGraph, edgeVisualState, buildTrace, summarizeParallel, summarizeEfficiency,
  svgTitleLines, svgTruncate, GRAPH_DEFAULTS,
  formatDuration, formatTokens, formatCompactTokens, formatCost, formatDelta, formatCostDelta,
  formatRelativeTime, shortModel, isActiveState, isBlockedState, isDoneState,
  stateRank, toneOfState, STATE_TONE, STATE_ORDER,
};
