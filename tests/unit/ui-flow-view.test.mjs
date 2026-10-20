/**
 * tests/unit/ui-flow-view.test.mjs — the panel's derived view model.
 *
 * Pure functions only: attention ordering, task detail, review defaults and the
 * formatting rules behind "—" (never a fabricated zero). These are the pieces
 * the sidebar's usability rests on, so they are pinned directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFlowView, buildAttention, attentionForTask, buildTaskDetail, reviewOptions,
  summarizeNodes, buildFlowGraph, edgeVisualState, buildTrace, summarizeParallel, summarizeEfficiency,
  svgTitleLines, svgTruncate, formatCompactTokens,
  formatDuration, formatTokens, formatCost, formatDelta, formatCostDelta,
  formatRelativeTime, shortModel, stateRank, isActiveState, isBlockedState, isDoneState,
} from '../../packages/sdlc-client-ui/src/client/flow.js';

function payload(overrides = {}) {
  return {
    ok: true,
    project: { available: true, id: 'P1', name: 'project', state: 'IMPLEMENTATION' },
    totals: { tasks: 5, activeTasks: 1, spend: { costUsd: 0.1736, tokens: 69_600 } },
    tasks: [
      {
        id: 'T-1', title: 'root', state: 'IN_PROGRESS', role: 'backend-engineer',
        riskClass: 'low', layer: 0, dependsOn: [], tier: 'standard', model: 'openai/gpt-4o',
      },
      {
        id: 'T-2', title: 'child', state: 'READY', role: 'qa-engineer',
        riskClass: 'medium', layer: 1, dependsOn: ['T-1'], tier: 'standard', model: 'openai/gpt-4o',
      },
      {
        id: 'T-3', title: 'sibling', state: 'DONE', role: 'frontend-engineer',
        riskClass: 'low', layer: 0, dependsOn: [], tier: 'cheap', model: 'x/y',
      },
      {
        id: 'T-4', title: 'broken', state: 'FAILED', role: 'qa-engineer',
        riskClass: 'high', layer: 1, dependsOn: ['T-1'], tier: null, model: null,
      },
      {
        id: 'T-5', title: 'blocked', state: 'BLOCKED', role: 'backend-engineer',
        riskClass: 'high', layer: 2, dependsOn: ['T-2'], tier: 'standard', model: null,
      },
    ],
    edges: [
      { from: 'T-1', to: 'T-2', missing: false },
      { from: 'T-1', to: 'T-4', missing: false },
      { from: 'T-2', to: 'T-5', missing: false },
    ],
    runs: [
      {
        taskId: 'T-1', runId: 'R-1b', status: 'running', durationMs: null, durationSource: 'live',
        tokensTotal: null, modelProvider: 'openai', modelId: 'gpt-4o', finishedAt: null, orphaned: false,
      },
      {
        taskId: 'T-1', runId: 'R-1a', status: 'completed', durationMs: 1000, durationSource: 'recorded',
        tokensTotal: 150, modelProvider: 'openai', modelId: 'gpt-4o', finishedAt: '2026-01-01T00:00:01Z', orphaned: false,
      },
      {
        taskId: 'T-4', runId: 'R-4a', status: 'failed', durationMs: 800, durationSource: 'recorded',
        tokensTotal: 10, modelProvider: 'openai', modelId: 'gpt-4o', finishedAt: '2026-01-01T00:00:02Z', orphaned: true,
      },
    ],
    routing: [
      { taskId: 'T-1', tier: 'standard', rule: 'default', source: 'recorded', available: true, partial: false, reason: 'recorded run' },
      { taskId: 'T-2', tier: null, rule: null, source: 'unavailable', available: false, partial: true, reason: 'unavailable' },
    ],
    gates: [
      { taskId: 'T-1', gate: 'unit', status: 'pass', result: 'pass' },
      { taskId: 'T-4', gate: 'unit', status: 'fail: 1 test', result: 'fail' },
      { taskId: 'T-4', gate: 'lint', status: 'fail: 3 errors', result: 'fail' },
      { taskId: 'T-3', gate: 'unit', status: 'skipped: n/a', result: 'skipped' },
    ],
    gateSummary: { pass: 1, fail: 2, skipped: 1, unknown: 0, total: 4 },
    events: [
      { id: 1, ts: '2026-01-01T00:00:00Z', taskId: 'T-1', actor: 'scheduler', action: 'dispatch' },
      { id: 2, ts: '2026-01-01T00:00:03Z', taskId: 'T-4', actor: 'worker', action: 'verify', result: 'fail' },
    ],
    escalations: [
      { id: 'E-1', taskId: 'T-5', level: 'L2', question: 'Which schema?', resolution: null, source: 'recorded' },
      { id: 'E-2', taskId: 'T-2', level: 'L1', question: 'Resolved already', resolution: 'accepted', source: 'recorded' },
    ],
    locks: {
      cap: 1,
      resources: [{ resource: 'package.json', holders: ['T-1'], status: 'held' }],
      pathOwners: [],
      violations: [{ kind: 'paths', a: 'T-1', b: 'T-4' }],
    },
    unavailable: [],
    ...overrides,
  };
}

test('buildFlowView derives layers, per-task runs and lifecycle-ordered segments', () => {
  const view = buildFlowView(payload());
  assert.equal(view.nodes.length, 5);
  assert.equal(view.layers.length, 3);
  assert.equal(view.layers[1].summary.total, 2);
  assert.equal(view.layers[0].summary.active, 1);
  assert.equal(view.layers[0].summary.done, 1);
  assert.equal(view.layers[1].summary.blocked, 1);
  assert.deepEqual(view.stateSegments.map((s) => s.state), ['READY', 'IN_PROGRESS', 'DONE', 'FAILED', 'BLOCKED']);
  const t1 = view.nodes.find((n) => n.id === 'T-1');
  assert.equal(t1.runCount, 2);
  assert.equal(t1.latestRun.runId, 'R-1b');
  const t4 = view.nodes.find((n) => n.id === 'T-4');
  assert.equal(t4.failingGates, 2);
  assert.equal(view.activeRuns.length, 1, 'only the run with no finish time is active');
  assert.equal(view.done, 1);
  assert.equal(view.totals.tasks, 5);
});

test('attention orders escalations and locks, then verification failures, then orphans', () => {
  const view = buildFlowView(payload());
  const issues = buildAttention(view);
  assert.deepEqual(issues.map((i) => i.kind), [
    'escalation', 'lockViolation', 'failedGates', 'failedTask', 'orphanedRuns',
  ]);
  const failedGates = issues.find((i) => i.kind === 'failedGates');
  assert.equal(failedGates.taskId, 'T-4');
  assert.equal(failedGates.count, 2);
  const escalation = issues.find((i) => i.kind === 'escalation');
  assert.equal(escalation.taskId, 'T-5');
  assert.equal(escalation.question, 'Which schema?');
  assert.ok(!issues.some((i) => i.taskId === 'T-2'), 'resolved escalations are not attention');
  assert.equal(issues.find((i) => i.kind === 'orphanedRuns').count, 1);
});

test('a healthy project has no attention issues', () => {
  const view = buildFlowView(payload({
    gates: [{ taskId: 'T-1', gate: 'unit', status: 'pass', result: 'pass' }],
    escalations: [],
    runs: [payload().runs[1]],
    tasks: [payload().tasks[0]],
    locks: { cap: 1, resources: [], pathOwners: [], violations: [] },
  }));
  assert.deepEqual(buildAttention(view), []);
  assert.deepEqual(attentionForTask(view, 'T-1'), []);
});

test('buildTaskDetail joins runs, gates, routing, dependencies and the latest event', () => {
  const view = buildFlowView(payload());
  const detail = buildTaskDetail(view, 'T-4');
  assert.equal(detail.id, 'T-4');
  assert.equal(detail.runs.length, 1);
  assert.equal(detail.failingGates.length, 2);
  assert.equal(detail.routing, null, 'no routing row for T-4');
  assert.deepEqual(detail.dependencies.map((d) => d.id), ['T-1']);
  assert.equal(detail.blockedBy.length, 1, 'T-1 is not DONE, so T-4 is still blocked by it');
  assert.equal(detail.latestEvent.action, 'verify');
  assert.equal(detail.canCompare, false);
  assert.equal(detail.attention.length, 4, 'failed task, failed gates, orphaned run and the lock pair');

  const t1 = buildTaskDetail(view, 'T-1');
  assert.equal(t1.activeRun.runId, 'R-1b');
  assert.equal(t1.canCompare, true, 'two runs are comparable');
  assert.equal(t1.routing.tier, 'standard');
  assert.equal(buildTaskDetail(view, 'NOPE'), null);
  assert.equal(buildTaskDetail(view, null), null);
});

test('reviewOptions picks the newest two runs, baseline A then candidate B', () => {
  const view = buildFlowView(payload());
  const options = reviewOptions(view, 'T-1');
  assert.equal(options.canCompare, true);
  assert.equal(options.a, 'R-1a');
  assert.equal(options.b, 'R-1b');
  assert.deepEqual(options.runs.map((r) => r.runId), ['R-1b', 'R-1a']);

  const single = reviewOptions(view, 'T-4');
  assert.equal(single.canCompare, false);
  assert.equal(single.a, '');
  assert.equal(single.b, 'R-4a', 'the only run is offered as B, never as a fabricated A');

  const none = reviewOptions(view, null);
  assert.deepEqual(none, { runs: [], a: '', b: '', canCompare: false });
});

test('summarizeNodes counts active, done and blocked states', () => {
  const view = buildFlowView(payload());
  const summary = summarizeNodes(view.nodes);
  assert.deepEqual(summary, {
    total: 5, active: 1, done: 1, blocked: 2, byState: { IN_PROGRESS: 1, READY: 1, DONE: 1, FAILED: 1, BLOCKED: 1 },
  });
  assert.equal(isActiveState('MERGING'), true);
  assert.equal(isBlockedState('ESCALATED'), true);
  assert.equal(isDoneState('ACCEPTED'), false);
  assert.ok(stateRank('DONE') < stateRank('FAILED'));
  assert.equal(stateRank('UNKNOWN'), 12);
});

test('formatting never fabricates a value', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(800), '800ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(90_000), '1.5m');
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(69_600), '69,600');
  assert.equal(formatCost(null), '—');
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(0.0012), '$0.0012');
  assert.equal(formatCost(0.013), '$0.0130');
  assert.equal(formatCost(0.1736), '$0.1736');
  assert.equal(formatCost(12.5), '$12.50');
  assert.equal(formatCost('nope'), '—');
  assert.equal(formatDelta(null), '—');
  assert.equal(formatDelta(0, 'ms'), '0');
  assert.equal(formatDelta(1200, 'ms'), '+1,200ms');
  assert.equal(formatDelta(-450, ' tok'), '−450 tok');
  assert.equal(formatDelta(1.5, 's'), '+1.5s');
  assert.equal(formatCostDelta(null), '—');
  assert.equal(formatCostDelta(0), '$0');
  assert.equal(formatCostDelta(0.0012), '+$0.0012');
  assert.equal(formatCostDelta(-0.0012), '−$0.0012');
  assert.equal(formatRelativeTime(null), '—');
  assert.equal(formatRelativeTime('not a date'), '—');
  assert.equal(formatRelativeTime('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:10Z')), 'just now');
  assert.equal(formatRelativeTime('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:02:00Z')), '2m ago');
  assert.equal(formatRelativeTime('2026-01-01T00:00:00Z', Date.parse('2026-01-01T02:00:00Z')), '2h ago');
  assert.equal(formatRelativeTime('2026-01-01T00:00:00Z', Date.parse('2026-01-03T00:00:00Z')), '2d ago');
  assert.equal(shortModel(null), null);
  assert.equal(shortModel('openai/gpt-4o'), 'gpt-4o');
});

test('formatCompactTokens keeps SVG labels short without inventing values', () => {
  assert.equal(formatCompactTokens(null), '—');
  assert.equal(formatCompactTokens(0), '0');
  assert.equal(formatCompactTokens(999), '999');
  assert.equal(formatCompactTokens(1500), '1.5k');
  assert.equal(formatCompactTokens(69_600), '69.6k');
  assert.equal(formatCompactTokens(100_000), '100k');
  assert.equal(formatCompactTokens(1_250_000), '1.3m');
});

test('buildFlowGraph lays parallel tasks side by side and routes edges downward', () => {
  const view = buildFlowView(payload());
  const graph = buildFlowGraph(view, { width: 360 });
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.rows.length, 3);
  assert.equal(graph.omitted, 0);
  const t1 = graph.nodes.find((n) => n.id === 'T-1');
  const t2 = graph.nodes.find((n) => n.id === 'T-2');
  const t3 = graph.nodes.find((n) => n.id === 'T-3');
  const t4 = graph.nodes.find((n) => n.id === 'T-4');
  assert.equal(t1.y, t3.y, 'same stage shares a row');
  assert.equal(t2.y, t4.y, 'parallel children share a row');
  assert.ok(t2.y > t1.y, 'later stages are below earlier stages');
  assert.ok(t1.live, 'an active task lights up');
  assert.ok(!t2.live, 'READY is not yet lit as running');
  assert.deepEqual(graph.rows[1].nodes, ['T-4', 'T-2'], 'blocked work sorts before ready work');
  assert.ok(t4.x < t2.x, 'the blocked task occupies the first lane');
  const edge = graph.edges.find((e) => e.key === 'T-1->T-2');
  assert.equal(edge.state, 'active');
  assert.ok(edge.packets >= 1, 'an active edge carries at least one packet');
  assert.match(edge.d, /^M /);
  const blocked = graph.edges.find((e) => e.key === 'T-2->T-5');
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.packets, 0);
  assert.ok(graph.height > 0 && graph.width >= 360);
});

test('buildFlowGraph is bounded and reports omitted nodes', () => {
  const view = buildFlowView(payload());
  const graph = buildFlowGraph(view, { width: 360, maxNodes: 3 });
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.omitted, 2);
  assert.ok(!graph.nodes.some((n) => n.id === 'T-5'), 'nodes beyond the cap are not drawn');
  assert.ok(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.from)
    && graph.nodes.some((n) => n.id === e.to)), 'no edge references a node that is not drawn');
});

test('a wide layer wraps into sub-rows instead of overflowing the sidebar', () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    id: `T-${index + 1}`, title: `task ${index + 1}`, state: 'READY', layer: 0, dependsOn: [],
  }));
  const view = buildFlowView(payload({ tasks, edges: [], runs: [] }));
  const graph = buildFlowGraph(view, { width: 360 });
  assert.equal(graph.rows[0].subrows, 3, 'seven nodes wrap into 3 + 3 + 1');
  assert.equal(new Set(graph.nodes.map((node) => node.y)).size, 3);
  assert.ok(graph.width <= 360, `wrapped map fits the sidebar (${graph.width}px)`);
  assert.ok(graph.height > 3 * 60, 'wrapping grows height instead of width');
});

test('edgeVisualState follows lifecycle, not raw edge presence', () => {
  const done = { state: 'DONE' };
  const active = { state: 'IN_PROGRESS' };
  const blocked = { state: 'BLOCKED' };
  const ready = { state: 'READY' };
  assert.equal(edgeVisualState(done, done), 'done');
  assert.equal(edgeVisualState(done, ready), 'ready');
  assert.equal(edgeVisualState(ready, active), 'active');
  assert.equal(edgeVisualState(done, blocked), 'blocked');
  assert.equal(edgeVisualState(ready, { state: 'BACKLOG' }), 'pending');
  assert.equal(edgeVisualState(done, done, { missing: true }), 'blocked');
});

test('buildTrace lights the upstream and downstream path of a task', () => {
  const view = buildFlowView(payload());
  const downstream = buildTrace(view, 'T-1');
  assert.equal(downstream.focus, 'T-1');
  assert.deepEqual([...downstream.nodes].sort(), ['T-1', 'T-2', 'T-4', 'T-5']);
  assert.ok(downstream.edges.has('T-1->T-2'));
  assert.ok(downstream.edges.has('T-1->T-4'));
  assert.ok(downstream.edges.has('T-2->T-5'));

  const upstream = buildTrace(view, 'T-5');
  assert.deepEqual([...upstream.nodes].sort(), ['T-1', 'T-2', 'T-5']);
  assert.ok(!upstream.nodes.has('T-4'), 'a sibling branch is not part of this task path');
  assert.equal(buildTrace(view, 'NOPE'), null);
  assert.equal(buildTrace(view, null), null);
});

test('summarizeParallel reports the effective cap without inventing one', () => {
  const view = buildFlowView(payload({
    totals: {
      tasks: 5, activeTasks: 1, maxParallelWorkers: 'auto',
      parallelism: { configured: 'auto', effective: 4, active: 1, saturated: false },
      spend: { costUsd: 0.1736, tokens: 69_600 },
    },
  }));
  const summary = summarizeParallel(view);
  assert.equal(summary.cap, 4);
  assert.equal(summary.configured, 'auto');
  assert.equal(summary.active, 1);
  assert.equal(summary.free, 3);
  assert.equal(summary.saturated, false);

  const saturated = summarizeParallel(buildFlowView(payload({
    totals: {
      tasks: 5, activeTasks: 1,
      parallelism: { configured: 1, effective: 1, active: 1, saturated: true },
      spend: {},
    },
  })));
  assert.equal(saturated.cap, 1);
  assert.equal(saturated.saturated, true);

  const oldHost = summarizeParallel(buildFlowView(payload({ totals: { tasks: 5, activeTasks: 0, spend: {} } })));
  assert.equal(oldHost.cap, null, 'an old host without parallelism yields no fabricated cap');
});

test('summarizeEfficiency derives token rates only from recorded run tokens', () => {
  const view = buildFlowView(payload());
  const efficiency = summarizeEfficiency(view);
  assert.equal(efficiency.tokens, 160, 'only runs with a recorded token total are summed');
  assert.equal(efficiency.tokensPerDoneTask, 160);
  assert.equal(efficiency.activeTokens, null, 'the active run has no tokens yet');

  const unknown = summarizeEfficiency(buildFlowView(payload({
    runs: [{ taskId: 'T-1', runId: 'R', status: 'running', finishedAt: null, tokensTotal: null }],
  })));
  assert.equal(unknown.tokens, null);
  assert.equal(unknown.tokensPerDoneTask, null);
});

test('SVG label helpers stay inside the node box', () => {
  assert.deepEqual(svgTitleLines('short title', 166), ['short title']);
  const lines = svgTitleLines('a much longer task title that needs wrapping onto two lines', 104);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length <= 14);
  assert.ok(lines[1].length <= 14);
  assert.equal(svgTruncate('abcdefghij', 5), 'abcd…');
  assert.equal(svgTruncate('abc', 5), 'abc');
});
