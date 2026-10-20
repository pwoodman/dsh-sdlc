/**
 * packages/sdlc-client-ui/src/client/panels.jsx — the SDLC sidebar panels.
 *
 * Plain React (no DSH primitive imports — the bundle resolves `react` as an
 * external through the client loader). Every panel reads its store snapshot and
 * renders data, loading, or the honest `missing: reason` state; nothing is
 * fabricated.
 *
 * The UI is attention-first: Flow answers "is it working / what needs me",
 * Tasks answers "what is the state of every task", Review compares two runs,
 * and Settings is a secondary surface behind the gear. The old Status and
 * Board tabs were duplicates of data already in Flow and Tasks.
 */

import { useEffect, useRef, useState } from 'react';

import { CONFIG_FIELDS, CONFIG_GROUPS } from './config-fields.js';
import {
  buildFlowView, buildAttention, buildTaskDetail, reviewOptions,
  buildFlowGraph, buildTrace, summarizeParallel, summarizeEfficiency,
  edgeVisualState, svgTitleLines, svgTruncate, formatCompactTokens,
  formatDuration, formatTokens, formatCost, formatDelta, formatCostDelta, formatRelativeTime, shortModel,
  isActiveState, isBlockedState, isDoneState, stateRank, toneOfState,
} from './flow.js';

const INIT_COMMAND = 'sdlc init';
const INSTALL_COMMAND = 'npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install';

/** Replace `{name}` placeholders without a locale-service dependency. */
export function fill(template, values = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (
    values[key] == null ? match : String(values[key])
  ));
}

/** Human label for a task state; unknown states stay literal instead of blank. */
export function stateLabel(t, state) {
  if (!state) return t('state.UNKNOWN');
  const key = `state.${state}`;
  const label = t(key);
  return label === key ? state : label;
}

function projectStateLabel(t, state) {
  if (!state) return t('state.UNKNOWN');
  const key = `project.${state}`;
  const label = t(key);
  return label === key ? state : label;
}

function projectTone(state) {
  if (state === 'IMPLEMENTATION') return 'running';
  if (state === 'REVIEW') return 'verify';
  if (state === 'DONE') return 'good';
  if (state === 'BLOCKED' || state === 'FAILED') return 'bad';
  if (state === 'PAUSED') return 'warn';
  return 'idle';
}

function gateTone(result) {
  if (result === 'pass') return 'good';
  if (result === 'fail') return 'bad';
  if (result === 'skipped') return 'warn';
  return 'idle';
}

function runTone(status) {
  if (status === 'completed') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'cancelled') return 'idle';
  return 'running';
}

function deltaTone(value) {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) === 0) return 'idle';
  return Number(value) < 0 ? 'good' : 'bad';
}

async function copyText(text) {
  try {
    if (!navigator?.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ── shared primitives ──────────────────────────────────────────────────────

export function Missing({ reason }) {
  return <div role="alert" className="sdlc-missing">{reason}</div>;
}

function StateChip({ state, t }) {
  return <span className={`sdlc-chip sdlc-tone-${toneOfState(state)}`}>{stateLabel(t, state)}</span>;
}

function Fold({ title, count, open = false, children }) {
  return (
    <details className="sdlc-fold" open={open}>
      <summary>
        <span className="sdlc-fold-title">{title}</span>
        <span className="sdlc-count">{count}</span>
      </summary>
      <div className="sdlc-fold-body">{children}</div>
    </details>
  );
}

function CopyButton({ text, label, copiedLabel, className = 'sdlc-btn' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" className={className} onClick={copy}>
      {copied ? copiedLabel : label}
    </button>
  );
}

function EmptyState({ tone = 'idle', icon = '·', title, body, children }) {
  return (
    <div className={`sdlc-empty sdlc-tone-${tone}`}>
      <div className="sdlc-empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {children}
    </div>
  );
}

function PanelLoading({ label }) {
  return (
    <div className="sdlc-skeleton" aria-busy="true" aria-live="polite">
      <span className="sdlc-skeleton-line sdlc-w60" />
      <span className="sdlc-skeleton-line sdlc-w90" />
      <span className="sdlc-skeleton-line sdlc-w40" />
      <span className="sdlc-sr-only">{label}</span>
    </div>
  );
}

function RefreshButton({ onClick, t }) {
  return (
    <button
      type="button"
      className="sdlc-icon-btn"
      onClick={onClick}
      aria-label={t('action.refresh')}
      title={t('action.refresh')}
    >
      ↻
    </button>
  );
}

function SectionHead({ title, meta, children }) {
  return (
    <div className="sdlc-section-head">
      <h3>{title}</h3>
      {meta && <span className="sdlc-muted">{meta}</span>}
      {children}
    </div>
  );
}

// ── flow: header, attention, progress ──────────────────────────────────────

function ProjectHead({ view, snapshot, onReload, t }) {
  const project = view.project;
  const named = project.available !== false;
  const state = named ? project.state : null;
  const updated = view.generatedAt ? formatRelativeTime(view.generatedAt) : null;
  return (
    <header className="sdlc-flow-head">
      <div className="sdlc-head-copy">
        <div className="sdlc-overline">{t('flow.overline')}</div>
        <div className="sdlc-project-line">
          <span className="sdlc-project-name" title={named ? project.name : null}>
            {named ? project.name : t('flow.unavailable')}
          </span>
          {state && <span className={`sdlc-chip sdlc-tone-${projectTone(state)}`}>{projectStateLabel(t, state)}</span>}
          <span
            className={`sdlc-live ${snapshot.phase === 'stale' ? 'warn' : 'good'}`}
            title={snapshot.phase === 'stale' ? t('flow.stale') : t('flow.live')}
            aria-label={snapshot.phase === 'stale' ? t('flow.stale') : t('flow.live')}
          />
        </div>
        {updated && <div className="sdlc-head-meta">{fill(t('flow.updated'), { time: updated })}</div>}
      </div>
      <RefreshButton onClick={onReload} t={t} />
    </header>
  );
}

function attentionKindLabel(issue, t) {
  if (issue.kind === 'failedGates') return t('flow.attentionGatesLabel');
  if (issue.kind === 'escalation') return t('flow.attentionNeedsDecision');
  if (issue.kind === 'failedTask') return t('flow.attentionFailedTaskLabel');
  if (issue.kind === 'orphanedRuns') return t('flow.attentionOrphanedLabel');
  if (issue.kind === 'lockViolation') return t('flow.attentionLockLabel');
  return t('common.unknown');
}

function AttentionRow({ issue, view, t, onSelectTask }) {
  const taskId = issue.taskId;
  const task = taskId ? view.nodes.find((node) => node.id === taskId) : null;
  const select = () => onSelectTask(taskId);
  let detail = '';
  if (issue.kind === 'failedGates') detail = fill(t(issue.count === 1 ? 'flow.attentionGateOne' : 'flow.attentionGates'), { count: issue.count });
  if (issue.kind === 'escalation') detail = issue.question || t('flow.attentionNeedsDecision');
  if (issue.kind === 'failedTask') detail = t('flow.attentionTaskFailed');
  if (issue.kind === 'orphanedRuns') detail = fill(t(issue.count === 1 ? 'flow.attentionOrphanOne' : 'flow.attentionOrphaned'), { count: issue.count });
  if (issue.kind === 'lockViolation') detail = `${t('flow.attentionLock')}: ${issue.a} vs ${issue.b}`;
  const kindLabel = attentionKindLabel(issue, t);
  const copy = (
    <span className="sdlc-attention-copy">
      <span className="sdlc-attention-main">
        {taskId && <span className="sdlc-code">{taskId}</span>}
        {taskId && task && <span className="sdlc-attention-task" title={task.title}>{task.title}</span>}
        {!taskId && <span>{kindLabel}</span>}
      </span>
      <span className="sdlc-attention-detail" title={detail}>{detail}</span>
    </span>
  );
  if (!taskId) {
    return (
      <div className={`sdlc-attention-row sdlc-tone-${issue.tone}`}>
        <span className="sdlc-attention-dot" aria-hidden="true" />
        {copy}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`sdlc-attention-row sdlc-tone-${issue.tone}`}
      onClick={select}
      aria-label={`${kindLabel} — ${taskId}`}
    >
      <span className="sdlc-attention-dot" aria-hidden="true" />
      {copy}
      <span className="sdlc-attention-go" aria-hidden="true">›</span>
    </button>
  );
}

function AttentionCard({ view, attention, t, onSelectTask, onShowTasks }) {
  if (attention.length === 0) {
    return (
      <div className="sdlc-clear" role="status">
        <span className="sdlc-clear-icon" aria-hidden="true">✓</span>
        <span>
          <b>{t('flow.attentionClear')}</b>
          <span className="sdlc-clear-detail">{t('flow.attentionClearDetail')}</span>
        </span>
      </div>
    );
  }
  const visible = attention.slice(0, 3);
  const more = attention.length - visible.length;
  return (
    <section className="sdlc-attention" aria-label={t('flow.attentionTitle')}>
      <div className="sdlc-attention-head">
        <span className="sdlc-attention-title">
          <span className="sdlc-attention-count">{attention.length}</span>
          {t('flow.attentionTitle')}
        </span>
      </div>
      {visible.map((issue) => (
        <AttentionRow key={issue.id} issue={issue} view={view} t={t} onSelectTask={onSelectTask} />
      ))}
      {more > 0 && (
        <button type="button" className="sdlc-attention-more" onClick={onShowTasks}>
          {fill(t('flow.attentionMore'), { count: more })} ›
        </button>
      )}
    </section>
  );
}

function StateBar({ view }) {
  return (
    <div className="sdlc-statebar" aria-hidden="true">
      {view.stateSegments.map((segment) => (
        <span
          key={segment.state}
          className={`sdlc-statebar-seg sdlc-tone-${segment.tone}`}
          style={{ flexGrow: segment.count }}
          title={`${segment.state}: ${segment.count}`}
        />
      ))}
    </div>
  );
}

function ProgressCard({ view, t }) {
  const total = view.totals.tasks ?? view.nodes.length;
  const completion = total ? Math.round((view.done / total) * 100) : 0;
  const spend = view.totals.spend ?? {};
  const parallel = summarizeParallel(view);
  const efficiency = summarizeEfficiency(view);
  return (
    <section className="sdlc-progress-card" aria-label={t('flow.progress')}>
      <div className="sdlc-progress-top">
        <span className="sdlc-ring" style={{ '--sdlc-pct': `${completion * 3.6}deg` }}>
          <b>{completion}%</b>
        </span>
        <div className="sdlc-progress-copy">
          <div className="sdlc-progress-line">
            <strong>{view.done} {t('flow.of')} {total}</strong> {t('flow.done')}
          </div>
          <div className="sdlc-muted">
            {parallel.active} {t('flow.running')}
            {parallel.cap != null && ` · ${parallel.active}/${parallel.cap} ${t('flow.parallelSlots')}`}
            {` · ${spend.tokens == null ? '—' : formatTokens(spend.tokens)} ${t('flow.tokens')}`}
          </div>
        </div>
        <div className="sdlc-progress-spend">
          <b>{formatCost(spend.costUsd)}</b>
          <span>{t('flow.estSpend')}</span>
        </div>
      </div>
      <StateBar view={view} />
      <div className="sdlc-legend">
        {view.stateSegments.slice(0, 4).map((segment) => (
          <span key={segment.state}>
            <i className={`sdlc-tone-${segment.tone}`} />
            {stateLabel(t, segment.state)} <b>{segment.count}</b>
          </span>
        ))}
        {view.stateSegments.length > 4 && (
          <span className="sdlc-muted">+{view.stateSegments.length - 4}</span>
        )}
        {efficiency.tokensPerDoneTask != null && (
          <span className="sdlc-progress-rate" title={t('flow.tokensPerTaskHint')}>
            {formatTokens(efficiency.tokensPerDoneTask)} {t('flow.tokensPerTask')}
          </span>
        )}
      </div>
    </section>
  );
}

// ── flow: task detail ─────────────────────────────────────────────────────

// ── flow map: animated DAG ────────────────────────────────────────────────
//
// Deterministic SVG: the browser derives every node/edge from the flow
// snapshot, so the live picture costs zero model tokens. Edges stream while
// work moves; nodes glow while a worker runs; parallel branches are drawn as
// side-by-side lanes. Hover/selection traces the upstream + downstream path.

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const listener = (event) => setReduced(event.matches);
    if (typeof query.addEventListener === 'function') query.addEventListener('change', listener);
    return () => {
      if (typeof query.removeEventListener === 'function') query.removeEventListener('change', listener);
    };
  }, []);
  return reduced;
}

/** Measure the map container so the SVG fits the sidebar instead of scrolling. */
function useElementWidth(fallback = 360) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect?.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function flowNodeFoot(node) {
  if (node.live && node.activeRun) {
    const tokens = node.activeRun.tokensTotal == null ? null : formatCompactTokens(node.activeRun.tokensTotal);
    return tokens
      ? `${formatDuration(node.activeRun.durationMs)} · ${tokens}`
      : formatDuration(node.activeRun.durationMs);
  }
  return node.role ?? '—';
}

function flowNodeBadge(node) {
  if (node.failingGates > 0) return `!${node.failingGates}`;
  if (node.runCount > 1) return `×${node.runCount}`;
  return null;
}

function FlowMapPacket({ edge, index }) {
  const duration = 1.8 + (edge.index % 3) * 0.35;
  const offset = (edge.index % 7) * 0.21 + index * 0.55;
  return (
    <circle className="sdlc-map-packet" r="2.4">
      <animateMotion
        dur={`${duration}s`}
        begin={`${offset.toFixed(2)}s`}
        repeatCount="indefinite"
        path={edge.d}
      />
    </circle>
  );
}

function FlowMapEdge({ edge, reducedMotion }) {
  const tone = edge.state === 'active' ? 'running'
    : edge.state === 'done' ? 'good'
      : edge.state === 'blocked' ? 'bad'
        : edge.state === 'ready' ? 'ready' : 'idle';
  return (
    <g className={`sdlc-map-edge sdlc-tone-${tone} is-${edge.state}${edge.dim ? ' is-dim' : ''}${edge.traced ? ' is-traced' : ''}`}>
      <path className="sdlc-map-edge-base" d={edge.d} />
      {edge.state !== 'pending' && <path className="sdlc-map-edge-lit" d={edge.d} />}
      {edge.state === 'active' && <path className="sdlc-map-edge-flow" d={edge.d} />}
      {!reducedMotion && edge.packets > 0 && (
        <g>
          {[...Array(edge.packets)].map((item, index) => (
            <FlowMapPacket key={index} edge={edge} index={index} />
          ))}
        </g>
      )}
    </g>
  );
}

function FlowMapNode({ node, t, selected, dimmed, onSelect, onHover, onLeave }) {
  const titleLines = svgTitleLines(node.title, node.w);
  const foot = svgTruncate(flowNodeFoot(node), Math.max(6, Math.floor((node.w - 18) / 5.6)));
  const badge = flowNodeBadge(node);
  const label = `${node.id} · ${node.title} · ${stateLabel(t, node.state)}`;
  const tooltip = node.waitingOn ? `${label} — ${node.waitingOn}` : label;
  const activate = () => onSelect(node.id);
  const enter = () => onHover(node.id);
  const onKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect(node.id);
  };
  const className = [
    'sdlc-map-node',
    `sdlc-tone-${toneOfState(node.state)}`,
    node.live ? 'is-live' : '',
    isDoneState(node.state) ? 'is-done' : '',
    isBlockedState(node.state) ? 'is-blocked' : '',
    selected ? 'is-selected' : '',
    dimmed ? 'is-dim' : '',
  ].filter(Boolean).join(' ');
  return (
    <g
      className={className}
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={tooltip}
      aria-expanded={selected}
      onClick={activate}
      onKeyDown={onKeyDown}
      onMouseEnter={enter}
      onMouseLeave={onLeave}
    >
      <title>{tooltip}</title>
      <rect className="sdlc-map-node-bg" width={node.w} height={node.h} rx="8" />
      {node.live && <rect className="sdlc-map-node-glow" width={node.w} height={node.h} rx="8" />}
      <rect className="sdlc-map-node-accent" width="3" height={node.h - 8} x="0" y="4" rx="1.5" />
      <text className="sdlc-map-node-id" x="10" y="14">{node.id}</text>
      {node.live && <circle className="sdlc-map-state-ring" cx={node.w - 11} cy="11" r="6" />}
      {isDoneState(node.state)
        ? <path className="sdlc-map-check" d={`M ${node.w - 17} 8 l 3 3 l 6 -6`} />
        : isBlockedState(node.state)
          ? <text className="sdlc-map-alert" x={node.w - 11} y="15" textAnchor="middle">!</text>
          : <circle className="sdlc-map-state-dot" cx={node.w - 11} cy="11" r="3.2" />}
      <text className="sdlc-map-node-title" x="10" y="31">{titleLines[0]}</text>
      {titleLines[1] && <text className="sdlc-map-node-title" x="10" y="43">{titleLines[1]}</text>}
      <text className="sdlc-map-node-foot" x="10" y="55">{foot}</text>
      {badge && <text className="sdlc-map-node-badge" x={node.w - 8} y="55" textAnchor="end">{badge}</text>}
    </g>
  );
}

function ParallelMeter({ parallel, t }) {
  const cap = parallel.cap;
  const slots = cap == null ? 0 : Math.min(cap, 12);
  return (
    <div
      className={`sdlc-parallel${parallel.active > 0 ? ' is-live' : ''}${parallel.saturated ? ' is-saturated' : ''}`}
      role="status"
      aria-label={t('flow.parallelLabel')}
    >
      <span className="sdlc-parallel-label">
        <span className="sdlc-parallel-dot" aria-hidden="true" />
        <b>{parallel.active}</b> {parallel.active === 1 ? t('flow.parallelWorker') : t('flow.parallelWorkers')}
      </span>
      {slots > 0 && (
        <span className="sdlc-parallel-pips" aria-hidden="true">
          {[...Array(slots)].map((item, index) => (
            <i key={index} className={index < parallel.active ? 'is-on' : ''} />
          ))}
        </span>
      )}
      {cap != null && <span className="sdlc-parallel-cap">{fill(t('flow.parallelCap'), { cap })}</span>}
      {parallel.saturated && <span className="sdlc-chip sdlc-tone-warn">{t('flow.parallelSaturated')}</span>}
    </div>
  );
}

function FlowMapLegend({ t }) {
  return (
    <div className="sdlc-map-legend">
      <span><i className="sdlc-tone-running" />{t('flow.legendActive')}</span>
      <span><i className="sdlc-tone-good" />{t('flow.legendDone')}</span>
      <span><i className="sdlc-tone-bad" />{t('flow.legendBlocked')}</span>
      <span><i className="sdlc-tone-idle" />{t('flow.legendPending')}</span>
    </div>
  );
}

function FlowMap({ view, t, selectedTask, onSelectTask }) {
  const reducedMotion = usePrefersReducedMotion();
  const [mapRef, mapWidth] = useElementWidth();
  const [hovered, setHovered] = useState(null);
  const focus = hovered ?? selectedTask ?? null;
  const trace = buildTrace(view, focus);
  const maxPerRow = mapWidth >= 560 ? 4 : mapWidth >= 340 ? 3 : 2;
  const graph = buildFlowGraph(view, { width: Math.max(240, mapWidth), maxPerRow });
  const parallel = summarizeParallel(view);
  const select = (taskId) => onSelectTask(selectedTask === taskId ? null : taskId);
  const hover = (taskId) => setHovered(taskId);
  const clearHover = () => setHovered(null);
  const nodeDimmed = (id) => Boolean(trace) && !trace.nodes.has(id);
  const edgeDimmed = (key) => Boolean(trace) && !trace.edges.has(key);
  return (
    <section className="sdlc-map-panel" aria-label={t('flow.mapLabel')}>
      <div className="sdlc-map-head">
        <span className="sdlc-overline">{t('flow.map')}</span>
        <span className="sdlc-muted">
          {fill(t('flow.mapNodes'), { count: graph.nodes.length })}
          {graph.omitted > 0 ? ` · ${fill(t('flow.mapOmitted'), { count: graph.omitted })}` : ''}
        </span>
      </div>
      <ParallelMeter parallel={parallel} t={t} />
      <div className="sdlc-map-scroll" ref={mapRef} onMouseLeave={clearHover}>
        <svg
          className="sdlc-map"
          width={graph.width}
          height={graph.height}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          role="group"
          aria-label={t('flow.mapLabel')}
        >
          <g className="sdlc-map-edges">
            {graph.edges.map((edge) => (
              <FlowMapEdge
                key={edge.key}
                edge={{
                  ...edge,
                  dim: edgeDimmed(edge.key),
                  traced: Boolean(trace) && trace.edges.has(edge.key),
                }}
                reducedMotion={reducedMotion}
              />
            ))}
          </g>
          <g className="sdlc-map-rows">
            {graph.rows.map((row) => (
              <g key={row.index} className={`sdlc-map-row${row.parallel ? ' is-parallel' : ''}`}>
                <text className="sdlc-map-stage-label" x={row.x} y={row.labelY}>
                  {t('flow.stage')} {String(row.index + 1).padStart(2, '0')}
                </text>
                {row.parallel && (
                  <text className="sdlc-map-stage-parallel" x={row.x + row.width} y={row.labelY} textAnchor="end">
                    {`${row.nodes.length} ${t('flow.parallelShort')}`}
                  </text>
                )}
              </g>
            ))}
          </g>
          <g className="sdlc-map-nodes">
            {graph.nodes.map((node) => (
              <FlowMapNode
                key={node.id}
                node={node}
                t={t}
                selected={selectedTask === node.id}
                dimmed={nodeDimmed(node.id)}
                onSelect={select}
                onHover={hover}
                onLeave={clearHover}
              />
            ))}
          </g>
        </svg>
      </div>
      <div className="sdlc-map-foot">
        <FlowMapLegend t={t} />
        {trace
          ? <span className="sdlc-map-trace">{fill(t('flow.mapTrace'), { task: trace.focus })}</span>
          : <span className="sdlc-map-trace sdlc-muted">{t('flow.mapHint')}</span>}
      </div>
      {graph.omitted > 0 && (
        <div className="sdlc-muted">{fill(t('flow.mapTruncated'), { count: graph.omitted })}</div>
      )}
    </section>
  );
}

function Fact({ label, children }) {  return (
    <div className="sdlc-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function RunRow({ run, t }) {
  return (
    <li className={`sdlc-run sdlc-tone-${runTone(run.status)}`}>
      <span className="sdlc-run-top">
        <span className="sdlc-run-attempt">
          {run.attempt == null ? t('common.run') : fill(t('flow.detailAttempt'), { n: run.attempt + 1 })}
        </span>
        <span className={`sdlc-chip sdlc-tone-${runTone(run.status)}`}>{run.status}</span>
        {run.durationSource === 'live' && <span className="sdlc-live-dot" aria-hidden="true" />}
        {run.orphaned && <span className="sdlc-chip sdlc-tone-bad">{t('flow.workerOrphaned')}</span>}
      </span>
      <span className="sdlc-run-meta">
        {formatDuration(run.durationMs)}
        {run.durationSource === 'live' ? ` ${t('flow.detailLive')}` : ''}
        {' · '}{formatTokens(run.tokensTotal)} {t('flow.tokens')}
        {' · '}{formatCost(run.costUsdEstimate)}
      </span>
      <span className="sdlc-run-meta">
        {run.modelProvider ? `${run.modelProvider}/` : ''}{shortModel(run.modelId) ?? '—'}
        {run.startedAt ? ` · ${formatRelativeTime(run.startedAt)}` : ''}
        {run.pid != null ? ` · ${fill(t('flow.detailPid'), { pid: run.pid })}` : ''}
      </span>
    </li>
  );
}

function TaskDetail({ detail, t, onClose, onSelectTask, onOpenReview }) {
  const close = () => onClose();
  const compare = () => onOpenReview(detail.id);
  const gates = detail.gates;
  return (
    <article className="sdlc-detail" id="sdlc-task-detail" aria-label={t('flow.detailTitle')}>
      <header className="sdlc-detail-head">
        <span className="sdlc-detail-id">
          <span className="sdlc-node-id">{detail.id}</span>
          <StateChip state={detail.state} t={t} />
        </span>
        <button type="button" className="sdlc-icon-btn" onClick={close} aria-label={t('action.close')} title={t('action.close')}>
          ×
        </button>
      </header>
      <h4 className="sdlc-detail-title">{detail.title}</h4>
      {detail.attention.length > 0 && (
        <div className="sdlc-detail-attention" role="status">
          {detail.attention.map((issue) => (
            <span key={issue.id} className={`sdlc-chip sdlc-tone-${issue.tone}`}>
              {attentionKindLabel(issue, t)}
            </span>
          ))}
        </div>
      )}
      <dl className="sdlc-facts">
        <Fact label={t('flow.detailRole')}>{detail.role ?? '—'}</Fact>
        <Fact label={t('flow.detailRisk')}>{detail.riskClass ?? '—'}</Fact>
        <Fact label={t('flow.detailTier')}>{detail.tier ?? '—'}</Fact>
        <Fact label={t('flow.detailModel')}>{shortModel(detail.model) ?? '—'}</Fact>
        <Fact label={t('flow.detailAttempts')}>{(detail.attempt ?? 0) + 1}</Fact>
        <Fact label={t('flow.detailBranch')}>
          <span className="sdlc-code sdlc-ellipsis" title={detail.branch ?? null}>{detail.branch ?? '—'}</span>
        </Fact>
        {detail.resources.length > 0 && (
          <Fact label={t('flow.detailResources')}>{detail.resources.join(', ')}</Fact>
        )}
        {detail.waitingOn && <Fact label={t('flow.detailWaitingOn')}>{detail.waitingOn}</Fact>}
      </dl>
      {detail.dependencies.length > 0 && (
        <div className="sdlc-detail-block">
          <div className="sdlc-detail-label">{t('flow.detailDependencies')}</div>
          <div className="sdlc-chips">
            {detail.dependencies.map((dep) => (
              <button
                key={dep.id}
                type="button"
                className={`sdlc-chip sdlc-chip-button sdlc-tone-${toneOfState(dep.state)}`}
                onClick={() => onSelectTask(dep.id)}
              >
                {dep.id}
              </button>
            ))}
          </div>
          {detail.blockedBy.length > 0 && (
            <div className="sdlc-muted">
              {fill(t('flow.nodeBlockedBy'), { deps: detail.blockedBy.map((dep) => dep.id).join(', ') })}
            </div>
          )}
        </div>
      )}
      <div className="sdlc-detail-block">
        <div className="sdlc-detail-label">{t('flow.detailRuns')}</div>
        {detail.runs.length === 0
          ? <div className="sdlc-muted">{t('flow.detailNoRuns')}</div>
          : <ul className="sdlc-run-list">{detail.runs.map((run) => <RunRow key={run.runId} run={run} t={t} />)}</ul>}
      </div>
      <div className="sdlc-detail-block">
        <div className="sdlc-detail-label">{t('flow.detailGates')}</div>
        {gates.length === 0
          ? <div className="sdlc-muted">{t('flow.detailNoGates')}</div>
          : (
            <div className="sdlc-chips">
              {gates.map((gate) => (
                <span
                  key={gate.gate}
                  className={`sdlc-chip sdlc-tone-${gateTone(gate.result)}`}
                  title={gate.status}
                >
                  {gate.gate}
                </span>
              ))}
            </div>
          )}
      </div>
      {detail.latestEvent && (
        <div className="sdlc-detail-block">
          <div className="sdlc-detail-label">{t('flow.detailLatest')}</div>
          <div className="sdlc-event-line">
            <span className="sdlc-muted">{detail.latestEvent.ts ? detail.latestEvent.ts.slice(11, 19) : ''}</span>
            {' '}<b>{detail.latestEvent.actor ?? '—'}</b> {detail.latestEvent.action ?? ''}
            {detail.latestEvent.result && detail.latestEvent.result !== 'ok' ? ` · ${detail.latestEvent.result}` : ''}
          </div>
        </div>
      )}
      <div className="sdlc-detail-actions">
        <button type="button" className="sdlc-btn sdlc-btn-primary" onClick={compare} disabled={!detail.canCompare}>
          {t('flow.detailCompare')}
        </button>
        {!detail.canCompare && <span className="sdlc-muted">{t('flow.detailCompareHint')}</span>}
      </div>
    </article>
  );
}

// ── flow: live workers and evidence folds ──────────────────────────────────

/** Worker line facts: omit unknown model/tokens instead of trailing "—". */
function workerMeta(run, t) {
  const parts = [fill(t('flow.workerElapsed'), { time: formatDuration(run.durationMs) })];
  const model = shortModel(run.modelId);
  if (model) parts.push(model);
  if (run.tokensTotal != null) parts.push(`${formatTokens(run.tokensTotal)} ${t('flow.tokens')}`);
  return parts.join(' · ');
}

function Workers({ view, t }) {
  if (view.activeRuns.length === 0) return null;
  const parallel = summarizeParallel(view);
  return (
    <section className="sdlc-workers" aria-label={t('flow.workers')}>
      <SectionHead
        title={t('flow.workers')}
        meta={parallel.cap == null
          ? `${view.activeRuns.length} ${t('flow.running')}`
          : `${parallel.active}/${parallel.cap} ${t('flow.parallelSlots')}`}
      />
      <ul className="sdlc-worker-list">
        {view.activeRuns.map((run) => (
          <li key={`${run.taskId}/${run.runId}`} className="sdlc-worker">
            <span className="sdlc-worker-pulse" aria-hidden="true" />
            <span className="sdlc-worker-body">
              <span className="sdlc-worker-line">
                <b>{run.role ?? '—'}</b>
                <span className="sdlc-code">{run.taskId}</span>
                {run.orphaned && <span className="sdlc-chip sdlc-tone-bad">{t('flow.workerOrphaned')}</span>}
              </span>
              <span className="sdlc-worker-meta">{workerMeta(run, t)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GatesFold({ view, t, onSelectTask }) {
  const failures = view.gates.filter((gate) => gate.result !== 'pass');
  return (
    <Fold title={t('flow.gates')} count={view.gates.length} open={view.gateSummary.fail > 0}>
      <div className="sdlc-chips">
        <span className="sdlc-chip sdlc-tone-good">{t('flow.pass')} {view.gateSummary.pass}</span>
        <span className="sdlc-chip sdlc-tone-bad">{t('flow.fail')} {view.gateSummary.fail}</span>
        <span className="sdlc-chip sdlc-tone-warn">{t('flow.skipped')} {view.gateSummary.skipped}</span>
        <span className="sdlc-chip sdlc-tone-idle">{t('flow.unknown')} {view.gateSummary.unknown}</span>
      </div>
      {view.gates.length === 0 && <div className="sdlc-muted sdlc-fold-empty">{t('flow.noGates')}</div>}
      {failures.length > 0 && (
        <ul className="sdlc-gate-list">
          {failures.map((gate) => (
            <li key={`${gate.taskId}/${gate.gate}`}>
              <button
                type="button"
                className={`sdlc-gate-row sdlc-tone-${gateTone(gate.result)}`}
                onClick={() => onSelectTask(gate.taskId)}
              >
                <span className="sdlc-code">{gate.taskId}</span>
                <span className="sdlc-gate-name">{gate.gate}</span>
                <span className="sdlc-gate-status" title={gate.status}>{gate.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Fold>
  );
}

function RoutingFold({ view, t }) {
  const noTiers = view.unavailable.some((item) => item.section === 'routing');
  if (view.routing.length === 0 && !noTiers) return null;
  return (
    <Fold title={t('flow.routing')} count={view.routing.length} open={false}>
      {noTiers && <div className="sdlc-muted sdlc-fold-empty">{t('flow.routingNoTiers')}</div>}
      {view.routing.length === 0
        ? <div className="sdlc-muted sdlc-fold-empty">{t('flow.noRouting')}</div>
        : (
          <ul className="sdlc-routing-list">
            {view.routing.map((route) => (
              <li key={route.taskId} className="sdlc-route">
                <span className="sdlc-route-top">
                  <span className="sdlc-code">{route.taskId}</span>
                  <span className={`sdlc-chip sdlc-tone-${route.available ? 'good' : 'warn'}`}>{route.tier ?? '—'}</span>
                  <span className="sdlc-muted">{route.source}</span>
                </span>
                <span className="sdlc-route-reason">{route.reason}</span>
              </li>
            ))}
          </ul>
        )}
    </Fold>
  );
}

function ActivityFold({ view, t }) {
  if (view.events.length === 0) return null;
  const events = view.events.slice(-8).reverse();
  return (
    <Fold title={t('flow.activity')} count={view.events.length} open={false}>
      <ol className="sdlc-event-list">
        {events.map((event) => (
          <li key={event.id}>
            <span className="sdlc-muted">{event.ts ? event.ts.slice(11, 19) : ''}</span>
            <span className="sdlc-event-actor">{event.actor ?? '—'}</span>
            <span className="sdlc-event-action">{event.action ?? ''}</span>
            {event.taskId && <span className="sdlc-code">{event.taskId}</span>}
            {event.result && event.result !== 'ok' && <span className="sdlc-bad-text">{event.result}</span>}
          </li>
        ))}
      </ol>
    </Fold>
  );
}

function LocksFold({ view, t }) {
  const resources = view.locks.resources ?? [];
  const violations = view.locks.violations ?? [];
  if (resources.length === 0 && violations.length === 0) return null;
  return (
    <Fold title={t('flow.locks')} count={resources.length + violations.length} open={violations.length > 0}>
      {resources.map((lock) => (
        <div
          key={lock.resource}
          className={`sdlc-lock sdlc-tone-${lock.status === 'held' ? 'running' : 'bad'}`}
        >
          <span className="sdlc-code">{lock.resource}</span>
          <span>{fill(lock.status === 'held' ? t('flow.lockHeld') : t('flow.lockOverCap'), { holders: lock.holders.join(', ') })}</span>
        </div>
      ))}
      {violations.map((violation, index) => (
        <div key={`${violation.kind}-${index}`} role="alert" className="sdlc-lock sdlc-tone-bad">
          <span className="sdlc-bad-text">{violation.kind}</span>
          <span>{violation.a} ↔ {violation.b}</span>
        </div>
      ))}
    </Fold>
  );
}

function EscalationsFold({ view, t }) {
  if (view.escalations.length === 0) return null;
  return (
    <Fold title={t('flow.escalations')} count={view.escalations.length} open={false}>
      <ul className="sdlc-escalation-list">
        {view.escalations.map((item) => (
          <li key={item.id} className="sdlc-escalation">
            <span className="sdlc-escalation-top">
              {item.taskId && <span className="sdlc-code">{item.taskId}</span>}
              <span className={`sdlc-chip sdlc-tone-${item.resolution ? 'good' : 'warn'}`}>
                {item.resolution ? t('flow.escalationResolved') : (item.level ?? t('flow.attentionNeedsDecision'))}
              </span>
            </span>
            <span className="sdlc-escalation-question">{item.question ?? t('common.none')}</span>
          </li>
        ))}
      </ul>
    </Fold>
  );
}

// ── flow: unavailable states ───────────────────────────────────────────────

function Diagnostics({ snapshot, t }) {
  const [copied, setCopied] = useState(false);
  const probe = snapshot.probe ?? null;
  const panelVersion = snapshot.panelVersion ?? null;
  const hostVersion = probe && typeof probe.pluginVersion === 'string' ? probe.pluginVersion : null;
  const diagnostics = [
    'SDLC panel diagnostics',
    `code: ${snapshot.code ?? 'UNKNOWN'}`,
    `reason: ${snapshot.reason ?? ''}`,
    `panel: ${panelVersion ?? 'unknown'}`,
    `host: ${hostVersion ?? 'unknown'}`,
    `status probe: ${JSON.stringify(probe)}`,
    `url: ${typeof location !== 'undefined' ? location.href : ''}`,
  ].join('\n');
  const copy = async () => {
    if (!(await copyText(diagnostics))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="sdlc-diagnostics">
      <div className="sdlc-diagnostic-versions">
        <span>{t('flow.panelVersion')} <b>{panelVersion ?? '—'}</b></span>
        <span>{t('flow.hostVersion')} <b>{hostVersion ?? t('flow.unknown')}</b></span>
      </div>
      <button type="button" className="sdlc-btn" onClick={copy}>
        {copied ? t('action.diagnosticsCopied') : t('action.copyDiagnostics')}
      </button>
    </div>
  );
}

function NoProjectState({ t, cwd, onRetry }) {
  return (
    <div className="sdlc-flow sdlc-flow-unavailable">
      <EmptyState
        tone="ready"
        icon="▸"
        title={t('flow.noProjectTitle')}
        body={t('flow.noProjectBody')}
      >
        <div className="sdlc-empty-command">
          <div className="sdlc-empty-label">{t('flow.noProjectHint')}</div>
          <code>{INIT_COMMAND}</code>
        </div>
        {cwd && (
          <div className="sdlc-empty-workspace">
            {t('flow.workspace')} <code title={cwd}>{cwd}</code>
          </div>
        )}
        <div className="sdlc-empty-actions">
          <CopyButton text={INIT_COMMAND} label={t('action.copyCommand')} copiedLabel={t('action.copied')} />
          <button type="button" className="sdlc-btn sdlc-btn-primary" onClick={onRetry}>{t('action.retry')}</button>
        </div>
      </EmptyState>
    </div>
  );
}

function FlowUnavailable({ snapshot, t, cwd, onRetry }) {
  const code = snapshot.code;
  if (code === 'NO_PROJECT' || /no SDLC project/i.test(snapshot.reason ?? '')) {
    return <NoProjectState t={t} cwd={cwd} onRetry={onRetry} />;
  }
  const hostOutdated = code === 'HOST_OUTDATED';
  const hostMissing = code === 'HOST_MISSING';
  const unreachable = code === 'HOST_UNREACHABLE';
  const message = hostOutdated
    ? t('flow.hostOutdated')
    : hostMissing
      ? t('flow.hostMissing')
      : unreachable
        ? t('flow.hostUnreachable')
        : (snapshot.reason ?? t('flow.unavailable'));
  const hint = hostOutdated
    ? `${t('flow.hostOutdatedHint')} ${t('flow.hostOutdatedDesktop')}`
    : hostMissing
      ? t('flow.hostMissingHint')
      : null;
  return (
    <div className="sdlc-flow sdlc-flow-unavailable">
      <EmptyState tone="warn" icon="!" title={t('flow.unavailable')} body={message}>
        {hint && <div className="sdlc-empty-hint"><p>{hint}</p></div>}
        {hostOutdated && (
          <div className="sdlc-empty-command">
            <div className="sdlc-empty-label">{t('flow.hostOutdatedCli')}</div>
            <code>{INSTALL_COMMAND}</code>
            <CopyButton text={INSTALL_COMMAND} label={t('action.copyCommand')} copiedLabel={t('action.copied')} />
          </div>
        )}
        {(hostOutdated || hostMissing) && <Diagnostics snapshot={snapshot} t={t} />}
        <div className="sdlc-empty-actions">
          <button type="button" className="sdlc-btn sdlc-btn-primary" onClick={onRetry}>{t('action.retry')}</button>
        </div>
      </EmptyState>
    </div>
  );
}

// ── flow panel ─────────────────────────────────────────────────────────────

export function FlowPanel({ snapshot, t, cwd, selectedTask, onSelectTask, onOpenReview, onReload, onShowTasks }) {
  if (snapshot.phase === 'loading') return <PanelLoading label={t('flow.loading')} />;
  if (snapshot.phase === 'missing') {
    return <FlowUnavailable snapshot={snapshot} t={t} cwd={cwd} onRetry={onReload} />;
  }
  const view = buildFlowView(snapshot.data);
  const attention = buildAttention(view);
  const detail = buildTaskDetail(view, selectedTask);
  return (
    <section className="sdlc-flow" aria-label={t('flow.overline')}>
      <ProjectHead view={view} snapshot={snapshot} onReload={onReload} t={t} />
      {snapshot.phase === 'stale' && (
        <div role="status" className="sdlc-notice">
          <b>{t('flow.stale')}</b> {fill(t('flow.staleDetail'), { reason: snapshot.reason ?? '' })}
        </div>
      )}
      {view.tasksTruncated && <div role="status" className="sdlc-notice">{t('flow.truncated')}</div>}
      {view.nodes.length === 0
        ? (
          <EmptyState
            tone="idle"
            icon="◇"
            title={t('flow.empty')}
            body={t('flow.emptyBody')}
          />
        )
        : (
          <div className="sdlc-flow-body">
            <AttentionCard view={view} attention={attention} t={t} onSelectTask={onSelectTask} onShowTasks={onShowTasks} />
            <ProgressCard view={view} t={t} />
            <FlowMap view={view} t={t} selectedTask={selectedTask} onSelectTask={onSelectTask} />
            {detail && (
              <TaskDetail
                detail={detail}
                t={t}
                onClose={() => onSelectTask(null)}
                onSelectTask={onSelectTask}
                onOpenReview={onOpenReview}
              />
            )}
            <Workers view={view} t={t} />
            <GatesFold view={view} t={t} onSelectTask={onSelectTask} />
            <RoutingFold view={view} t={t} />
            <ActivityFold view={view} t={t} />
            <LocksFold view={view} t={t} />
            <EscalationsFold view={view} t={t} />
          </div>
        )}
    </section>
  );
}

// ── tasks panel ────────────────────────────────────────────────────────────

const TASK_FILTERS = [
  { id: 'all', labelKey: 'tasks.filterAll' },
  { id: 'active', labelKey: 'tasks.filterActive' },
  { id: 'blocked', labelKey: 'tasks.filterBlocked' },
  { id: 'done', labelKey: 'tasks.filterDone' },
];

function matchesFilter(node, filter, attention) {
  if (filter === 'active') return isActiveState(node.state);
  if (filter === 'blocked') return isBlockedState(node.state) || attention > 0;
  if (filter === 'done') return isDoneState(node.state);
  return true;
}

function TaskListRow({ node, t, selected, attentionCount, onToggle }) {
  return (
    <button
      type="button"
      className={`sdlc-task-row${selected ? ' sdlc-task-row-selected' : ''}`}
      aria-expanded={selected}
      aria-controls="sdlc-task-detail"
      onClick={onToggle}
      aria-label={fill(t('tasks.open'), { id: node.id })}
    >
      <span className="sdlc-task-row-top">
        {attentionCount > 0 && <span className="sdlc-attention-dot" aria-hidden="true" />}
        <span className="sdlc-code">{node.id}</span>
        <StateChip state={node.state} t={t} />
        {node.failingGates > 0 && (
          <span className="sdlc-chip sdlc-tone-bad">{fill(t(node.failingGates === 1 ? 'flow.nodeFailedGateOne' : 'flow.nodeFailedGates'), { count: node.failingGates })}</span>
        )}
      </span>
      <span className="sdlc-task-row-title">{node.title}</span>
      <span className="sdlc-task-row-meta">
        {node.role ?? '—'} · {node.riskClass ?? '—'}
        {node.runCount > 0 ? ` · ${fill(t(node.runCount === 1 ? 'tasks.runsOne' : 'tasks.runs'), { count: node.runCount })}` : ''}
      </span>
    </button>
  );
}

export function TasksPanel({ snapshot, t, cwd, selectedTask, onSelectTask, onOpenReview, onReload }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  if (snapshot.phase === 'loading') return <PanelLoading label={t('tasks.loading')} />;
  if (snapshot.phase === 'missing') {
    return <FlowUnavailable snapshot={snapshot} t={t} cwd={cwd} onRetry={onReload} />;
  }
  const view = buildFlowView(snapshot.data);
  const attention = buildAttention(view);
  const attentionByTask = new Map();
  for (const issue of attention) {
    for (const id of [issue.taskId, issue.otherTaskId]) {
      if (!id) continue;
      attentionByTask.set(id, (attentionByTask.get(id) ?? 0) + 1);
    }
  }
  const needle = query.trim().toLowerCase();
  const filtered = view.nodes.filter((node) => {
    if (!matchesFilter(node, filter, attentionByTask.get(node.id) ?? 0)) return false;
    if (!needle) return true;
    return [node.id, node.title, node.role].filter(Boolean).join(' ').toLowerCase().includes(needle);
  }).sort((a, b) => stateRank(a.state) - stateRank(b.state) || String(a.id).localeCompare(String(b.id)));

  const groups = [];
  for (const node of filtered) {
    if (groups.length === 0 || groups.at(-1).state !== node.state) {
      groups.push({ state: node.state, nodes: [] });
    }
    groups.at(-1).nodes.push(node);
  }

  const counts = {
    all: view.nodes.length,
    active: view.nodes.filter((node) => isActiveState(node.state)).length,
    blocked: view.nodes.filter((node) => isBlockedState(node.state) || attentionByTask.has(node.id)).length,
    done: view.nodes.filter((node) => isDoneState(node.state)).length,
  };
  const changeQuery = (event) => setQuery(event.target.value);
  const chooseFilter = (id) => setFilter(id);
  const toggleTask = (taskId) => onSelectTask(selectedTask === taskId ? null : taskId);
  const detail = buildTaskDetail(view, selectedTask);

  return (
    <section className="sdlc-panel sdlc-tasks" aria-label={t('tasks.title')}>
      <header className="sdlc-panel-head">
        <span className="sdlc-overline">{t('tasks.title')}</span>
        <span className="sdlc-panel-count">{fill(t(view.nodes.length === 1 ? 'tasks.countOne' : 'tasks.count'), { count: view.nodes.length })}</span>
        <RefreshButton onClick={onReload} t={t} />
      </header>
      <label className="sdlc-search">
        <span className="sdlc-sr-only">{t('tasks.search')}</span>
        <input
          type="search"
          value={query}
          onChange={changeQuery}
          placeholder={t('tasks.search')}
          autoComplete="off"
        />
      </label>
      <div className="sdlc-filters" role="group" aria-label={t('tasks.filtersLabel')}>
        {TASK_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="sdlc-filter"
            aria-pressed={filter === item.id}
            onClick={() => chooseFilter(item.id)}
          >
            {t(item.labelKey)}
            {counts[item.id] > 0 && <span className="sdlc-filter-count">{counts[item.id]}</span>}
          </button>
        ))}
      </div>
      {view.nodes.length === 0 && (
        <EmptyState tone="idle" icon="◇" title={t('tasks.empty')} body={t('tasks.emptyBody')} />
      )}
      {view.nodes.length > 0 && filtered.length === 0 && (
        <div className="sdlc-muted sdlc-no-match">{t('tasks.noMatch')}</div>
      )}
      {groups.map((group) => (
        <section className="sdlc-task-group" key={group.state}>
          <h3 className="sdlc-task-group-head">
            <span className={`sdlc-dot sdlc-tone-${toneOfState(group.state)}`} aria-hidden="true" />
            {stateLabel(t, group.state)}
            <span className="sdlc-count">{group.nodes.length}</span>
          </h3>
          <ul className="sdlc-task-group-list">
            {group.nodes.map((node) => (
              <li key={node.id}>
                <TaskListRow
                  node={node}
                  t={t}
                  selected={selectedTask === node.id}
                  attentionCount={attentionByTask.get(node.id) ?? 0}
                  onToggle={() => toggleTask(node.id)}
                />
                {detail && detail.id === node.id && (
                  <TaskDetail
                    detail={detail}
                    t={t}
                    onClose={() => onSelectTask(null)}
                    onSelectTask={onSelectTask}
                    onOpenReview={onOpenReview}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

// ── review panel ───────────────────────────────────────────────────────────

function runOptionLabel(run, t) {
  const attempt = run.attempt == null ? t('common.run') : fill(t('common.attemptN'), { n: run.attempt + 1 });
  return fill(t('review.runOption'), { attempt, status: run.status, duration: formatDuration(run.durationMs) });
}

function ReviewResult({ report, t }) {
  if (!report?.runs?.A?.available || !report?.runs?.B?.available) {
    const missing = !report?.runs?.A?.available ? report?.runs?.A?.reason : report?.runs?.B?.reason;
    return <Missing reason={missing ?? t('review.noRunData')} />;
  }
  const a = report.runs.A;
  const b = report.runs.B;
  const deltas = report.deltas;
  const durationDelta = deltas?.durationMs?.delta ?? null;
  const tokensDelta = deltas?.tokensTotal?.delta ?? null;
  const costDelta = deltas?.costUsdEstimate?.delta ?? null;
  const changedGates = report.gatesCompared.filter((gate) => gate.changed);
  const unchangedGates = report.gatesCompared.filter((gate) => !gate.changed);
  const statusDelta = a.status === b.status ? t('review.unchanged') : t('review.changed');
  return (
    <article className="sdlc-review-result" aria-label={t('review.resultTitle')}>
      <header className="sdlc-review-head">
        <h3>{report.task.title ?? report.task.id}</h3>
        <div className="sdlc-review-sub">
          <span className="sdlc-code">{report.task.id}</span>
          {report.task.state && <StateChip state={report.task.state} t={t} />}
          <span className="sdlc-muted">
            {report.columns?.A?.runId?.slice(-8) ?? 'A'} → {report.columns?.B?.runId?.slice(-8) ?? 'B'}
          </span>
        </div>
      </header>
      <table className="sdlc-review-table" aria-label={t('review.resultTitle')}>
        <thead>
          <tr>
            <th>{t('review.dimension')}</th>
            <th>{t('review.baseline')}</th>
            <th>{t('review.candidate')}</th>
            <th>{t('review.delta')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{t('review.status')}</td>
            <td>{a.status ?? '—'}</td>
            <td>{b.status ?? '—'}</td>
            <td className="sdlc-muted">{statusDelta}</td>
          </tr>
          <tr>
            <td>{t('review.wallClock')}</td>
            <td>{formatDuration(a.durationMs)}</td>
            <td>{formatDuration(b.durationMs)}</td>
            <td className={`sdlc-tone-text-${deltaTone(durationDelta)}`}>{formatDelta(durationDelta, 'ms')}</td>
          </tr>
          <tr>
            <td>{t('review.tokens')}</td>
            <td>{formatTokens(a.tokensTotal)}</td>
            <td>{formatTokens(b.tokensTotal)}</td>
            <td className={`sdlc-tone-text-${deltaTone(tokensDelta)}`}>{formatDelta(tokensDelta)}</td>
          </tr>
          <tr>
            <td>{t('review.cost')}</td>
            <td>{formatCost(a.costUsdEstimate)}</td>
            <td>{formatCost(b.costUsdEstimate)}</td>
            <td className={`sdlc-tone-text-${deltaTone(costDelta)}`}>{formatCostDelta(costDelta)}</td>
          </tr>
        </tbody>
      </table>
      <div className="sdlc-detail-block">
        <div className="sdlc-detail-label">{t('review.gates')}</div>
        {report.gatesCompared.length === 0 && <div className="sdlc-muted">{t('review.noGates')}</div>}
        {changedGates.length > 0 && (
          <ul className="sdlc-gate-review">
            {changedGates.map((gate) => (
              <li key={gate.gate} className="sdlc-gate-review-row">
                <span className="sdlc-gate-name">{gate.gate}</span>
                <span className={`sdlc-chip sdlc-tone-${gateTone(gateStatus(gate.A))}`}>{gate.A}</span>
                <span className="sdlc-muted">→</span>
                <span className={`sdlc-chip sdlc-tone-${gateTone(gateStatus(gate.B))}`}>{gate.B}</span>
                <span className="sdlc-chip sdlc-tone-warn">{t('review.changed')}</span>
              </li>
            ))}
          </ul>
        )}
        {unchangedGates.length > 0 && (
          <Fold title={t('review.unchanged')} count={unchangedGates.length} open={false}>
            <ul className="sdlc-gate-review">
              {unchangedGates.map((gate) => (
                <li key={gate.gate} className="sdlc-gate-review-row">
                  <span className="sdlc-gate-name">{gate.gate}</span>
                  <span className={`sdlc-chip sdlc-tone-${gateTone(gateStatus(gate.A))}`}>{gate.A}</span>
                </li>
              ))}
            </ul>
          </Fold>
        )}
      </div>
      <Fold title={t('review.traceTitle')} count={report.traceSummary?.steps ?? 0} open={false}>
        <div className="sdlc-muted">
          {report.traceSummary?.states ?? '—'}
          {' · '}{fill(t((report.traceSummary?.steps ?? 0) === 1 ? 'review.traceStepsOne' : 'review.traceSteps'), { steps: report.traceSummary?.steps ?? 0 })}
        </div>
        {report.traceSummary?.revisited?.length > 0 && (
          <div className="sdlc-muted">
            {fill(t('review.traceRevisited'), { states: report.traceSummary.revisited.join(', ') })}
          </div>
        )}
        {report.tracePath.length > 0 && (
          <ol className="sdlc-trace">
            {report.tracePath.map((step, index) => (
              <li key={`${step.ts ?? 'step'}-${index}`}>
                <span className="sdlc-muted">{step.ts ? step.ts.slice(11, 19) : '—'}</span>
                <span className="sdlc-trace-actor">{step.actor ?? '—'}</span>
                <span>{step.action ?? ''}</span>
                {step.to && <span className="sdlc-trace-to">→ {stateLabel(t, step.to)}</span>}
              </li>
            ))}
          </ol>
        )}
        {report.tracePath.length === 0 && <div className="sdlc-muted">{t('review.noTrace')}</div>}
      </Fold>
    </article>
  );
}

function gateStatus(value) {
  if (value === 'pass') return 'pass';
  if (String(value).startsWith('fail')) return 'fail';
  if (String(value).startsWith('skipped')) return 'skipped';
  return 'unknown';
}

function ReviewPicker({ view, t, task, runA, runB, onTask, onRunA, onRunB, onCompare }) {
  const options = reviewOptions(view, task);
  const disabled = !task || !runA || !runB || runA === runB;
  const submit = (event) => {
    event.preventDefault();
    if (!disabled) onCompare(task, runA, runB);
  };
  const taskChange = (event) => onTask(event.target.value);
  const aChange = (event) => onRunA(event.target.value);
  const bChange = (event) => onRunB(event.target.value);
  return (
    <form className="sdlc-picker" onSubmit={submit}>
      <label className="sdlc-field sdlc-field-wide">
        <span>{t('review.pickTask')}</span>
        <select value={task} onChange={taskChange}>
          <option value="">{t('review.pickTaskFirst')}</option>
          {view.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {fill(t('review.taskOption'), { id: node.id, state: stateLabel(t, node.state) })}
            </option>
          ))}
        </select>
      </label>
      <label className="sdlc-field">
        <span>{t('review.pickRunA')}</span>
        <select value={runA} onChange={aChange} disabled={!task}>
          <option value="">—</option>
          {options.runs.map((run) => <option key={run.runId} value={run.runId}>{runOptionLabel(run, t)}</option>)}
        </select>
      </label>
      <label className="sdlc-field">
        <span>{t('review.pickRunB')}</span>
        <select value={runB} onChange={bChange} disabled={!task}>
          <option value="">—</option>
          {options.runs.map((run) => <option key={run.runId} value={run.runId}>{runOptionLabel(run, t)}</option>)}
        </select>
      </label>
      {task && !options.canCompare && (
        <div className="sdlc-picker-hint" role="status">
          {fill(t(options.runs.length === 1 ? 'review.insufficientOne' : 'review.insufficient'), { count: options.runs.length })}
        </div>
      )}
      {task && options.canCompare && runA && runA === runB && (
        <div className="sdlc-picker-hint" role="status">{t('review.sameRun')}</div>
      )}
      <button type="submit" className="sdlc-btn sdlc-btn-primary sdlc-picker-submit" disabled={disabled}>
        {t('review.compare')}
      </button>
    </form>
  );
}

export function ReviewPanel({ snapshot, flowSnapshot, t, cwd, initialTask, onCompare, onRetryFlow }) {
  const initialView = flowSnapshot.data ? buildFlowView(flowSnapshot.data) : null;
  const targetTask = initialTask ?? snapshot.task ?? '';
  const seeded = initialTask && initialView ? reviewOptions(initialView, initialTask) : null;
  const [task, setTask] = useState(targetTask);
  const [runA, setRunA] = useState(seeded ? seeded.a : (snapshot.a ?? ''));
  const [runB, setRunB] = useState(seeded ? seeded.b : (snapshot.b ?? ''));
  if (flowSnapshot.phase === 'loading') return <PanelLoading label={t('common.loading')} />;
  if (flowSnapshot.phase === 'missing') {
    return <FlowUnavailable snapshot={flowSnapshot} t={t} cwd={cwd} onRetry={onRetryFlow} />;
  }
  const view = initialView ?? buildFlowView(flowSnapshot.data);
  if (view.nodes.length === 0) {
    return (
      <section className="sdlc-panel">
        <header className="sdlc-panel-head"><span className="sdlc-overline">{t('review.title')}</span></header>
        <EmptyState tone="idle" icon="◇" title={t('review.noTasks')} body={t('tasks.emptyBody')} />
      </section>
    );
  }
  const options = reviewOptions(view, task);
  const resultMatches = snapshot.task === task && snapshot.a === runA && snapshot.b === runB;
  const chooseTask = (nextTask) => {
    setTask(nextTask);
    const next = reviewOptions(view, nextTask);
    setRunA(next.a);
    setRunB(next.b);
  };
  return (
    <section className="sdlc-panel sdlc-review" aria-label={t('review.title')}>
      <header className="sdlc-panel-head">
        <span className="sdlc-overline">{t('review.title')}</span>
        <span className="sdlc-panel-count">{t('review.pickPrompt')}</span>
      </header>
      <ReviewPicker
        view={view}
        t={t}
        task={task}
        runA={runA}
        runB={runB}
        onTask={chooseTask}
        onRunA={setRunA}
        onRunB={setRunB}
        onCompare={onCompare}
      />
      {snapshot.phase === 'loading' && resultMatches && <PanelLoading label={t('review.loading')} />}
      {snapshot.phase === 'missing' && resultMatches && <Missing reason={snapshot.reason} />}
      {snapshot.phase === 'ready' && resultMatches && <ReviewResult report={snapshot.data} t={t} />}
      {snapshot.phase !== 'idle' && !resultMatches && (
        <div className="sdlc-muted sdlc-review-hint">{t('review.pickPrompt')}</div>
      )}
    </section>
  );
}

// ── settings panel ─────────────────────────────────────────────────────────


function getPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function coerceField(field, raw) {
  if (field.kind === 'number') return Number(raw);
  if (field.kind === 'boolean') return raw === true || raw === 'true';
  return raw;
}

function ConfigRow({ field, config, draft, saving, saved, error, onDraft, onSave, t }) {
  const controlId = `sdlc-config-${field.path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const draftSelect = (event) => onDraft(field.path, event.target.value);
  const draftCheck = (event) => onDraft(field.path, event.target.checked);
  const draftText = (event) => onDraft(field.path, event.target.value);
  const saveField = () => onSave(field);
  const current = getPath(config, field.path);
  const shown = draft === undefined ? current : draft;
  const dirty = draft !== undefined;
  return (
    <li className={`sdlc-config-row${dirty ? ' sdlc-config-dirty' : ''}`}>
      <div className="sdlc-config-head">
        <label className="sdlc-config-name" htmlFor={controlId}>{t(field.labelKey)}</label>
        {dirty && <span className="sdlc-config-dirty-dot" title={t('config.modified')} aria-label={t('config.modified')} />}
      </div>
      <div className="sdlc-config-control">
        {field.kind === 'select' && (
          <select id={controlId} value={String(shown ?? '')} onChange={draftSelect}>
            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        )}
        {field.kind === 'boolean' && (
          <input id={controlId} type="checkbox" checked={shown === true || shown === 'true'} onChange={draftCheck} />
        )}
        {field.kind !== 'select' && field.kind !== 'boolean' && (
          <input id={controlId} type={field.kind === 'number' ? 'number' : 'text'} value={shown ?? ''} onChange={draftText} />
        )}
        {field.hintKey && <span className="sdlc-config-hint">{t(field.hintKey)}</span>}
        {dirty && (
          <button type="button" className="sdlc-btn sdlc-btn-primary" onClick={saveField} disabled={saving}>
            {saving ? t('action.saving') : t('action.save')}
          </button>
        )}
        {saved && !dirty && <span className="sdlc-config-saved" role="status">{t('action.saved')}</span>}
      </div>
      {error && <span role="alert" className="sdlc-config-error">{fill(t('config.rejected'), { reason: error })}</span>}
    </li>
  );
}

function ConfigGroup({ group, config, drafts, errors, saving, savedPath, onDraft, onSave, t }) {
  const fields = CONFIG_FIELDS.filter((field) => field.group === group);
  if (fields.length === 0) return null;
  return (
    <section className="sdlc-config-group">
      <h3 className="sdlc-config-group-title">{t(`config.group.${group}`)}</h3>
      <ul className="sdlc-config-list">
        {fields.map((field) => (
          <ConfigRow
            key={field.path}
            field={field}
            config={config}
            draft={drafts[field.path]}
            saving={saving === field.path}
            saved={savedPath === field.path}
            error={errors[field.path]}
            onDraft={onDraft}
            onSave={onSave}
            t={t}
          />
        ))}
      </ul>
    </section>
  );
}

export function SettingsPanel({ snapshot, t, cwd, onReload, onSave }) {
  const [drafts, setDrafts] = useState({});
  const [errors, setErrors] = useState({});
  const [savedPath, setSavedPath] = useState(null);
  if (snapshot.phase === 'loading') return <PanelLoading label={t('config.loading')} />;
  if (snapshot.phase === 'missing') {
    if (snapshot.code === 'NO_PROJECT') return <NoProjectState t={t} cwd={cwd} onRetry={onReload} />;
    return (
      <section className="sdlc-panel">
        <header className="sdlc-panel-head">
          <span className="sdlc-overline">{t('config.title')}</span>
          <RefreshButton onClick={onReload} t={t} />
        </header>
        <Missing reason={snapshot.reason} />
      </section>
    );
  }
  const { config, validation } = snapshot.data;
  const setDraft = (path, value) => {
    setDrafts((current) => ({ ...current, [path]: value }));
    setErrors((current) => ({ ...current, [path]: null }));
    setSavedPath(null);
  };
  const save = async (field) => {
    const raw = drafts[field.path] ?? getPath(config, field.path);
    const value = coerceField(field, raw);
    const res = await onSave(field.path, value);
    if (res?.available === false) {
      setErrors((current) => ({ ...current, [field.path]: res.reason }));
      return;
    }
    setDrafts((current) => ({ ...current, [field.path]: undefined }));
    setSavedPath(field.path);
    setTimeout(() => setSavedPath((current) => (current === field.path ? null : current)), 1600);
  };
  return (
    <section className="sdlc-panel sdlc-settings" aria-label={t('config.title')}>
      <header className="sdlc-panel-head">
        <span className="sdlc-overline">{t('config.title')}</span>
        <RefreshButton onClick={onReload} t={t} />
      </header>
      <p className="sdlc-settings-intro">{t('config.intro')}</p>
      {!validation.ok && (
        <div role="alert" className="sdlc-warn">
          <b>{fill(t(validation.errors.length === 1 ? 'config.invalidOne' : 'config.invalid'), { count: validation.errors.length })}</b>
          <ul>{validation.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
        </div>
      )}
      {snapshot.saveError && (
        <div role="alert" className="sdlc-warn">{fill(t('config.saveFailed'), { reason: snapshot.saveError })}</div>
      )}
      {CONFIG_GROUPS.map((group) => (
        <ConfigGroup
          key={group}
          group={group}
          config={config}
          drafts={drafts}
          errors={errors}
          saving={snapshot.saving}
          savedPath={savedPath}
          onDraft={setDraft}
          onSave={save}
          t={t}
        />
      ))}
    </section>
  );
}

export { CONFIG_FIELDS };

export default {
  FlowPanel, TasksPanel, ReviewPanel, SettingsPanel, Missing, fill, stateLabel,
};
