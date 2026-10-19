/**
 * packages/sdlc-client-ui/src/client/panels.jsx — the four SDLC panels.
 *
 * Plain React (no DSH primitive imports — the bundle resolves `react` as an
 * external through the client loader, the deliverables-plugin pattern). Each
 * panel reads its store snapshot and renders data, loading, or the honest
 * `missing: reason` state. Nothing is fabricated: unavailable values render
 * as "—" with the reason beside them.
 */

import { useState } from 'react';

export function Missing({ reason }) {
  return <div role="alert">Unavailable: {reason}</div>;
}

export function StatusPanel({ snapshot, onReload }) {
  if (snapshot.phase === 'loading') return <div className="sdlc-loading" aria-live="polite">Loading flow status…</div>;
  if (snapshot.phase === 'missing') return <Missing reason={snapshot.reason} />;
  const { tasks, spend, projects } = snapshot.data;
  if (tasks.total === 0) return <div>No project initialised — run `sdlc init` first.</div>;
  return (
    <section aria-label="SDLC status" className="sdlc-panel">
      <div className="sdlc-panel-head">
        <span className="sdlc-overline">Status</span>
        <button type="button" className="sdlc-btn" onClick={onReload}>Reload</button>
      </div>
      <div className="sdlc-summary">
        <div><strong>{tasks.total}</strong><span>tasks</span></div>
        <div><strong>{formatCost(spend.costUsd)}</strong><span>est. spend</span></div>
        <div><strong>{formatTokens(spend.tokens)}</strong><span>tokens</span></div>
      </div>
      <ul className="sdlc-state-list">
        {Object.entries(tasks.byState).sort().map(([state, n]) => (
          <li key={state} className={`sdlc-state-pill sdlc-tone-${toneOf(state)}`}>
            <span>{state}</span><b>{n}</b>
          </li>
        ))}
      </ul>
      {projects.length > 0 && (
        <ul className="sdlc-project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <span className="sdlc-project-id">{p.id}</span>
              <span className={`sdlc-chip sdlc-tone-${toneOf(p.state)}`}>{p.state}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function BoardPanel({ snapshot, onReload, onOpenTask }) {
  if (snapshot.phase === 'loading') return <div className="sdlc-loading" aria-live="polite">Loading task board…</div>;
  if (snapshot.phase === 'missing') return <Missing reason={snapshot.reason} />;
  if (!snapshot.data.columns.length) return <div>No tasks yet.</div>;
  return (
    <section aria-label="SDLC task board" className="sdlc-panel">
      <div className="sdlc-panel-head">
        <span className="sdlc-overline">Board</span>
        <button type="button" className="sdlc-btn" onClick={onReload}>Reload</button>
      </div>
      {snapshot.data.columns.map((col) => (
        <BoardColumn key={col.state} col={col} onOpenTask={onOpenTask} />
      ))}
    </section>
  );
}

function BoardColumn({ col, onOpenTask }) {
  return (
    <div className="sdlc-board-col">
      <h3>
        <span className={`sdlc-dot sdlc-tone-${toneOf(col.state)}`} aria-hidden="true" />
        {col.state}
        <span className="sdlc-count">{col.tasks.length}</span>
      </h3>
      <ul className="sdlc-board-list">
        {col.tasks.map((t) => (
          <BoardRow key={t.id} t={t} onOpenTask={onOpenTask} />
        ))}
      </ul>
    </div>
  );
}

function BoardRow({ t, onOpenTask }) {
  const open = () => onOpenTask?.(t.id);
  return (
    <li className="sdlc-board-row">
      <button type="button" className="sdlc-task-link" onClick={open}>{t.id}</button>
      <span className="sdlc-board-title">{t.title ?? t.id}</span>
      <span className="sdlc-board-meta">{t.role ?? '—'} · {t.riskClass ?? '—'}</span>
    </li>
  );
}

/** Editable config sections: dotted path, label, kind. */
export const CONFIG_FIELDS = [
  { path: 'observability.logLevel', label: 'Log level', kind: 'select', options: ['debug', 'info', 'warn', 'error'] },
  { path: 'observability.metricsExport', label: 'Export Prometheus metrics', kind: 'boolean' },
  { path: 'execution.maxParallelWorkers', label: 'Max parallel workers', kind: 'string', hint: 'number or "auto"' },
  { path: 'execution.basePort', label: 'Base port', kind: 'number' },
  { path: 'execution.worktreeRetentionDays', label: 'Worktree retention (days)', kind: 'number' },
  { path: 'budgets.perProject.maxCostUsd', label: 'Project cost ceiling (USD)', kind: 'number' },
  { path: 'verification.gateTimeoutMs', label: 'Gate timeout (ms)', kind: 'number' },
  { path: 'escalation.loopThreshold', label: 'Loop threshold', kind: 'number' },
];

function getPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

export function ConfigPanel({ snapshot, onReload, onSave }) {
  const [drafts, setDrafts] = useState({});
  const [errors, setErrors] = useState({});
  if (snapshot.phase === 'loading') return <div className="sdlc-loading" aria-live="polite">Loading configuration…</div>;
  if (snapshot.phase === 'missing') return <Missing reason={snapshot.reason} />;
  const { config, validation } = snapshot.data;
  const setDraft = (path, value) => {
    setDrafts((d) => ({ ...d, [path]: value }));
    setErrors((e) => ({ ...e, [path]: null }));
  };
  const save = async (field) => {
    const raw = drafts[field.path] ?? getPath(config, field.path);
    const value = field.kind === 'number' ? Number(raw)
      : field.kind === 'boolean' ? (raw === true || raw === 'true')
      : raw;
    const res = await onSave(field.path, value);
    if (res?.available === false) setErrors((e) => ({ ...e, [field.path]: res.reason }));
    else setDrafts((d) => ({ ...d, [field.path]: undefined }));
  };
  return (
    <section aria-label="SDLC configuration" className="sdlc-panel">
      <div className="sdlc-panel-head">
        <span className="sdlc-overline">Config</span>
        <button type="button" className="sdlc-btn" onClick={onReload}>Reload</button>
      </div>
      {!validation.ok && (
        <div role="alert" className="sdlc-warn">
          {validation.errors.length} error(s):
          <ul>{validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {snapshot.saveError && <div role="alert" className="sdlc-warn">Save failed: {snapshot.saveError}</div>}
      <ul className="sdlc-config-list">
        {CONFIG_FIELDS.map((field) => (
          <ConfigRow
            key={field.path}
            field={field}
            shown={drafts[field.path] ?? getPath(config, field.path)}
            saving={snapshot.saving === field.path}
            error={errors[field.path]}
            onDraft={setDraft}
            onSave={save}
          />
        ))}
      </ul>
    </section>
  );
}

function ConfigRow({ field, shown, saving, error, onDraft, onSave }) {
  const draftSelect = (e) => onDraft(field.path, e.target.value);
  const draftCheck = (e) => onDraft(field.path, e.target.checked);
  const draftText = (e) => onDraft(field.path, e.target.value);
  const saveField = () => onSave(field);
  const controlId = `sdlc-config-${field.path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <li className="sdlc-config-row">
      <div className="sdlc-config-head">
        <label className="sdlc-config-name" htmlFor={controlId}>{field.label}</label>
        <code>{field.path}</code>
      </div>
      <div className="sdlc-config-control">
        {field.kind === 'select' && (
          <select id={controlId} value={String(shown ?? '')} onChange={draftSelect}>
            {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        {field.kind === 'boolean' && (
          <input id={controlId} type="checkbox" checked={shown === true || shown === 'true'} onChange={draftCheck} />
        )}
        {field.kind !== 'select' && field.kind !== 'boolean' && (
          <input id={controlId} type={field.kind === 'number' ? 'number' : 'text'} value={shown ?? ''} onChange={draftText} />
        )}
        {field.hint && <span className="sdlc-config-hint">{field.hint}</span>}
        <button type="button" className="sdlc-btn" onClick={saveField} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && <span role="alert" className="sdlc-config-error">Rejected: {error}</span>}
    </li>
  );
}

function fmtMs(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ReviewPanel({ snapshot, onCompare, initialTask = null }) {
  const [task, setTask] = useState(snapshot.task ?? initialTask ?? '');
  const [runA, setRunA] = useState(snapshot.a ?? '');
  const [runB, setRunB] = useState(snapshot.b ?? '');
  if (snapshot.phase === 'idle') {
    // fall through to the picker below
  } else if (snapshot.phase === 'loading') {
    return <div className="sdlc-loading" aria-live="polite">Loading comparison…</div>;
  } else if (snapshot.phase === 'missing') {
    return (
      <section aria-label="SDLC review" className="sdlc-panel">
        <div className="sdlc-panel-head"><span className="sdlc-overline">Review</span></div>
        <Missing reason={snapshot.reason} />
        <Picker task={task} setTask={setTask} runA={runA} setRunA={setRunA} runB={runB} setRunB={setRunB} onCompare={onCompare} />
      </section>
    );
  } else if (snapshot.phase === 'ready') {
    const report = snapshot.data;
    return (
      <section aria-label="SDLC review" className="sdlc-panel">
        <div className="sdlc-panel-head"><span className="sdlc-overline">Review</span></div>
        <Picker task={task || report.task.id} setTask={setTask} runA={runA} setRunA={setRunA} runB={runB} setRunB={setRunB} onCompare={onCompare} />
        <h3 className="sdlc-review-title">{report.task.id} — {report.task.state}</h3>
        <table className="sdlc-review-table">
          <thead><tr><th>dimension</th><th>A</th><th>B</th><th>Δ (B−A)</th></tr></thead>
          <tbody>
            <tr><td>status</td><td>{report.runs.A.status}</td><td>{report.runs.B.status}</td><td>{'—'}</td></tr>
            <tr><td>wall-clock</td><td>{fmtMs(report.runs.A.durationMs)}</td><td>{fmtMs(report.runs.B.durationMs)}</td><td>{report.deltas ? `${report.deltas.durationMs.delta}ms` : '—'}</td></tr>
            <tr><td>tokens total</td><td>{report.runs.A.tokensTotal}</td><td>{report.runs.B.tokensTotal}</td><td>{report.deltas ? report.deltas.tokensTotal.delta : '—'}</td></tr>
            <tr><td>cost (est.)</td><td>${report.runs.A.costUsdEstimate}</td><td>${report.runs.B.costUsdEstimate}</td><td>{'—'}</td></tr>
          </tbody>
        </table>
        <h4>Gates</h4>
        <ul className="sdlc-gate-review">
          {report.gatesCompared.map((g) => (
            <GateRow key={g.gate} g={g} />
          ))}
        </ul>
        <h4>Trace path</h4>
        <p>{report.traceSummary.states} ({report.traceSummary.steps} steps)</p>
        <ol className="sdlc-trace">
          {report.tracePath.map((s, i) => (
            <TraceRow key={i} s={s} />
          ))}
        </ol>
      </section>
    );
  }
  return (
    <section aria-label="SDLC review" className="sdlc-panel">
      <div className="sdlc-panel-head"><span className="sdlc-overline">Review</span></div>
      <p className="sdlc-review-hint">Pick two runs of a task to compare.</p>
      <Picker task={task} setTask={setTask} runA={runA} setRunA={setRunA} runB={runB} setRunB={setRunB} onCompare={onCompare} />
    </section>
  );
}

function GateRow({ g }) {
  return <li>{g.gate}: A={g.A} B={g.B}{g.changed ? ' ← changed' : ''}</li>;
}

function TraceRow({ s }) {
  return <li>{s.actor} {s.action}{s.to ? ` → ${s.to}` : ''}</li>;
}

function Picker({ task, setTask, runA, setRunA, runB, setRunB, onCompare }) {
  const submit = (e) => {
    e.preventDefault();
    if (task && runA && runB) onCompare(task, runA, runB);
  };
  return (
    <form className="sdlc-picker" onSubmit={submit}>
      <PickerTask task={task} setTask={setTask} />
      <PickerRun label="Run A" value={runA} setValue={setRunA} />
      <PickerRun label="Run B" value={runB} setValue={setRunB} />
      <button type="submit" className="sdlc-btn sdlc-btn-primary sdlc-picker-submit">Compare</button>
    </form>
  );
}

function PickerTask({ task, setTask }) {
  const change = (e) => setTask(e.target.value);
  return <label className="sdlc-field sdlc-field-wide">Task <input value={task} onChange={change} placeholder="DEMO-…" /></label>;
}

function PickerRun({ label, value, setValue }) {
  const change = (e) => setValue(e.target.value);
  return <label className="sdlc-field">{label} <input value={value} onChange={change} placeholder="run id" /></label>;
}

export default { StatusPanel, BoardPanel, ConfigPanel, ReviewPanel, CONFIG_FIELDS };

// ── flow visualizer ────────────────────────────────────────────────────────

import { buildFlowView, STATE_TONE, formatDuration, formatTokens, formatCost } from './flow.js';

function toneOf(state) {
  return STATE_TONE[state] ?? 'idle';
}

function shortModel(model) {
  if (!model) return '—';
  return String(model).split('/').at(-1);
}

function Kpi({ label, value, tone }) {
  return (
    <div className={`sdlc-kpi ${tone ? `sdlc-tone-${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Fold({ title, count, open, children }) {
  return (
    <details className="sdlc-fold" open={open}>
      <summary>
        <span>{title}</span>
        <span className="sdlc-count">{count}</span>
      </summary>
      <div className="sdlc-fold-body">{children}</div>
    </details>
  );
}

function FlowUnavailable({ snapshot, onRetry, t }) {
  const [copied, setCopied] = useState(false);
  const hostOutdated = snapshot.code === 'HOST_OUTDATED';
  const hostMissing = snapshot.code === 'HOST_MISSING';
  const unreachable = snapshot.code === 'HOST_UNREACHABLE';
  const probe = snapshot.probe ?? null;
  const panelVersion = snapshot.panelVersion ?? null;
  const hostVersion = probe && typeof probe.pluginVersion === 'string' ? probe.pluginVersion : null;
  const command = 'npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install';
  const diagnostics = [
    'SDLC panel diagnostics',
    `code: ${snapshot.code ?? 'UNKNOWN'}`,
    `reason: ${snapshot.reason ?? ''}`,
    `panel: ${panelVersion ?? 'unknown'}`,
    `host: ${hostVersion ?? 'unknown'}`,
    `status probe: ${JSON.stringify(probe)}`,
    `url: ${typeof location !== 'undefined' ? location.href : ''}`,
  ].join('\n');
  const copy = (text) => {
    try {
      void navigator.clipboard?.writeText(text);
      setCopied(true);
    } catch { /* clipboard unavailable */ }
  };
  const message = hostOutdated
    ? t('flow.hostOutdated')
    : hostMissing
      ? t('flow.hostMissing')
      : unreachable
        ? t('flow.hostUnreachable')
        : snapshot.reason;
  return (
    <div className="sdlc-empty" role="alert">
      <div className="sdlc-empty-icon" aria-hidden="true">!</div>
      <h3>{t('flow.unavailable')}</h3>
      <p>{message}</p>
      {(hostOutdated || hostMissing) && (
        <div className="sdlc-empty-hint">
          <p>{hostOutdated ? t('flow.hostOutdatedHint') : t('flow.hostMissingHint')}</p>
          {hostOutdated && <p>{t('flow.hostOutdatedDesktop')}</p>}
          {hostOutdated && (
            <div className="sdlc-empty-command">
              <p className="sdlc-empty-label">{t('flow.hostOutdatedCli')}</p>
              <code>{command}</code>
              <button type="button" className="sdlc-btn sdlc-empty-copy" onClick={() => copy(command)}>{t('flow.copy')}</button>
            </div>
          )}
          <div className="sdlc-empty-versions">
            <span>{t('flow.panelVersion')} <b>{panelVersion ?? '—'}</b></span>
            <span>{t('flow.hostVersion')} <b>{hostVersion ?? t('flow.unknown')}</b></span>
          </div>
          <button type="button" className="sdlc-btn sdlc-empty-copy" onClick={() => copy(diagnostics)}>
            {copied ? t('flow.diagnosticsCopied') : t('flow.copyDiagnostics')}
          </button>
        </div>
      )}
      <button type="button" className="sdlc-btn" onClick={onRetry}>{t('flow.retry')}</button>
    </div>
  );
}

export function FlowPanel({ snapshot, onReload, onSelectTask, t }) {
  if (snapshot.phase === 'loading') return <div className="sdlc-loading" aria-live="polite">{t('flow.loading')}</div>;
  if (snapshot.phase === 'missing') return <FlowUnavailable snapshot={snapshot} onRetry={onReload} t={t} />;
  const view = buildFlowView(snapshot.data);
  const reload = () => onReload();
  const failing = view.gateSummary.fail + view.gateSummary.unknown;
  const projectLabel = view.project.available === false
    ? t('flow.noProject')
    : view.project.name;
  const projectState = view.project.available === false ? null : view.project.state;
  const completion = view.totals.tasks ? Math.round((view.done / view.totals.tasks) * 100) : 0;
  return (
    <section aria-label="SDLC flow" className="sdlc-flow">
      <div className="sdlc-flow-head">
        <div className="sdlc-head-copy">
          <div className="sdlc-overline">SDLC FLOW</div>
          <div className="sdlc-project-line">
            <span className="sdlc-project-name">{projectLabel}</span>
            {projectState && <span className={`sdlc-chip sdlc-tone-${projectState === 'IMPLEMENTATION' ? 'running' : 'idle'}`}>{projectState}</span>}
            <span className={`sdlc-live ${snapshot.phase === 'stale' ? 'warn' : 'good'}`} title={snapshot.phase === 'stale' ? t('flow.stale') : t('flow.live')} />
          </div>
        </div>
        <button type="button" className="sdlc-icon-btn" onClick={reload} aria-label={t('flow.reload')} title={t('flow.reload')}>↻</button>
      </div>

      {snapshot.phase === 'stale' && <div role="status" className="sdlc-warn">{t('flow.stale')}: {snapshot.reason}</div>}
      {view.tasksTruncated && <div role="status" className="sdlc-warn">{t('flow.truncated')}</div>}
      {view.unavailable.map((item) => (
        <div role="status" className="sdlc-warn" key={item.section}>{item.section}: {item.reason}</div>
      ))}

      <div className="sdlc-kpis">
        <Kpi value={view.totals.tasks ?? 0} label={t('flow.tasks')} />
        <Kpi value={view.totals.activeTasks ?? 0} label={t('flow.running')} tone="running" />
        <Kpi value={view.gateSummary.pass} label={t('flow.passing')} tone="good" />
        <Kpi value={failing} label={t('flow.failing')} tone={failing ? 'bad' : 'idle'} />
      </div>

      <div className="sdlc-meter" aria-label={t('flow.summary')}>
        <div className="sdlc-meter-head">
          <span><strong>{completion}%</strong>{' '}{t('flow.done')}</span>
          <span className="sdlc-muted">{formatCost(view.totals.spend ? view.totals.spend.costUsd : null)} · {formatTokens(view.totals.spend ? view.totals.spend.tokens : null)} tok</span>
        </div>
        <div className="sdlc-progress"><i style={{ width: `${completion}%` }} /></div>
        <div className="sdlc-statebar">
          {view.stateSegments.map((segment) => (
            <span
              key={segment.state}
              className={`sdlc-statebar-seg sdlc-tone-${segment.tone}`}
              style={{ flexGrow: segment.count }}
              title={`${segment.state}: ${segment.count}`}
            />
          ))}
        </div>
        <div className="sdlc-legend">
          {view.stateSegments.slice(0, 4).map((segment) => (
            <span key={segment.state}><i className={`sdlc-tone-${segment.tone}`} />{segment.state} <b>{segment.count}</b></span>
          ))}
        </div>
      </div>

      {view.nodes.length === 0 && <div className="sdlc-empty">{t('flow.empty')}</div>}
      {view.nodes.length > 0 && <FlowDag view={view} onSelectTask={onSelectTask} t={t} />}

      <Fold title={t('flow.subagents')} count={view.runs.length} open={view.runs.length <= 4}>
        <FlowRuns view={view} t={t} />
      </Fold>
      <Fold title={t('flow.routing')} count={view.routing.length} open={false}>
        <FlowRouting view={view} t={t} />
      </Fold>
      <Fold title={t('flow.gates')} count={view.gates.length} open={false}>
        <FlowGates view={view} t={t} />
      </Fold>
      <Fold title={t('flow.locks')} count={view.locks.resources.length} open={false}>
        <FlowLocks view={view} t={t} />
      </Fold>
      <Fold title={t('flow.escalations')} count={view.escalations.length} open={false}>
        <FlowEscalations view={view} t={t} />
      </Fold>
      <Fold title={t('flow.events')} count={view.events.length} open={false}>
        <FlowEvents view={view} t={t} />
      </Fold>
    </section>
  );
}

function FlowDag({ view, onSelectTask, t }) {
  const label = t('flow.dagLabel').replace('{tasks}', String(view.nodes.length)).replace('{edges}', String(view.edges.length));
  return (
    <div className="sdlc-dag" role="img" aria-label={label}>
      {view.layers.map((layer) => (
        <section className="sdlc-layer" key={layer.index}>
          <div className="sdlc-layer-head">
            <span>{`${t('flow.stage')} ${layer.index + 1}`}</span>
            <span className="sdlc-muted">{layer.nodes.length} {t('flow.tasks')}</span>
          </div>
          <div className="sdlc-layer-nodes">
            {layer.nodes.map((node) => (
              <FlowNode key={node.id} node={node} onSelectTask={onSelectTask} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FlowNode({ node, onSelectTask }) {
  const open = () => onSelectTask(node.id);
  const deps = node.dependsOn.length ? node.dependsOn.join(', ') : null;
  return (
    <button
      type="button"
      className={`sdlc-node sdlc-tone-${toneOf(node.state)}`}
      onClick={open}
      title={node.title}
    >
      <span className="sdlc-node-head">
        <span className="sdlc-node-id">{node.id}</span>
        <span className="sdlc-state">{node.state}</span>
      </span>
      <span className="sdlc-node-title">{node.title}</span>
      <span className="sdlc-node-meta">{node.role ?? '—'} · {node.riskClass ?? '—'}</span>
      <span className="sdlc-node-meta">{node.tier ?? '—'} · {shortModel(node.model)}</span>
      {deps && <span className="sdlc-node-deps">after {deps}</span>}
    </button>
  );
}

function FlowRuns({ view, t }) {
  if (view.runs.length === 0) return <div className="sdlc-muted">{t('flow.noRuns')}</div>;
  return (
    <ul className="sdlc-run-list">
      {view.runs.map((run) => <FlowRun key={run.runId} run={run} />)}
    </ul>
  );
}

function FlowRun({ run }) {
  const tone = run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'running';
  return (
    <li className={`sdlc-run sdlc-tone-${tone}`}>
      <span className="sdlc-run-role">{run.role ?? '—'}</span>
      <span className="sdlc-run-status">{run.status}</span>
      <span className="sdlc-run-meta">{run.modelProvider ? `${run.modelProvider}/` : ''}{shortModel(run.modelId)}</span>
      <span className="sdlc-run-meta">{formatTokens(run.tokensTotal)} tok · {formatDuration(run.durationMs)}{run.durationSource === 'live' ? ' live' : ''}</span>
      <span className="sdlc-run-meta">{run.pid == null ? 'no pid' : `pid ${run.pid}`}</span>
      <span className="sdlc-run-id">{run.taskId}/{run.runId}</span>
      {run.orphaned && <span className="sdlc-bad">orphaned</span>}
    </li>
  );
}

function FlowRouting({ view, t }) {
  if (view.routing.length === 0) return <div className="sdlc-muted">{t('flow.noRouting')}</div>;
  return (
    <ul className="sdlc-routing-list">
      {view.routing.map((route) => (
        <li key={route.taskId} className="sdlc-route">
          <span className="sdlc-route-task">{route.taskId}</span>
          <span className={`sdlc-chip sdlc-tone-${route.available ? 'good' : 'warn'}`}>{route.tier ?? '—'}</span>
          <span className="sdlc-muted">rule {route.rule ?? '—'} · {route.source}{route.partial ? ' · partial' : ''}</span>
          <span className="sdlc-route-reason">{route.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function FlowGates({ view, t }) {
  if (view.gates.length === 0) return <div className="sdlc-muted">{t('flow.noGates')}</div>;
  const failures = view.gates.filter((g) => g.result !== 'pass');
  return (
    <div>
      <div className="sdlc-chips">
        <span className="sdlc-chip sdlc-tone-good">{t('flow.pass')} {view.gateSummary.pass}</span>
        <span className="sdlc-chip sdlc-tone-bad">{t('flow.fail')} {view.gateSummary.fail}</span>
        <span className="sdlc-chip sdlc-tone-warn">{t('flow.skipped')} {view.gateSummary.skipped}</span>
        <span className="sdlc-chip sdlc-tone-idle">{t('flow.unknown')} {view.gateSummary.unknown}</span>
      </div>
      {failures.length > 0 && (
        <ul className="sdlc-gate-list">
          {failures.map((gate) => (
            <li key={`${gate.taskId}/${gate.gate}`} className={`sdlc-chip sdlc-tone-${gate.result === 'pass' ? 'good' : gate.result === 'fail' ? 'bad' : 'warn'}`}>
              {gate.taskId} · {gate.gate} · {gate.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FlowLocks({ view, t }) {
  const violations = view.locks.violations ?? [];
  return (
    <div>
      {view.locks.resources.length === 0 && <div className="sdlc-muted">{t('flow.noResources')}</div>}
      <ul className="sdlc-lock-list">
        {view.locks.resources.map((lock) => (
          <li key={lock.resource} className={`sdlc-chip sdlc-tone-${lock.status === 'held' ? 'running' : 'bad'}`}>
            {lock.resource}: {lock.holders.join(', ')}
          </li>
        ))}
      </ul>
      {violations.map((v, index) => (
        <div key={index} role="alert" className="sdlc-bad">{v.kind}: {v.a} ↔ {v.b}</div>
      ))}
    </div>
  );
}

function FlowEscalations({ view, t }) {
  if (view.escalations.length === 0) return <div className="sdlc-muted">{t('flow.noEscalations')}</div>;
  return (
    <ul className="sdlc-escalation-list">
      {view.escalations.map((item) => (
        <li key={item.id} className="sdlc-escalation">
          <span className={`sdlc-chip sdlc-tone-${item.resolution ? 'good' : 'warn'}`}>{item.level ?? '—'}</span>
          <span className="sdlc-escalation-task">{item.taskId ?? '—'}</span>
          <span className="sdlc-escalation-question">{item.question ?? '—'}</span>
          <span className="sdlc-muted">{item.source}{item.resolution ? ` · ${item.resolution}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

function FlowEvents({ view, t }) {
  if (view.events.length === 0) return <div className="sdlc-muted">{t('flow.noEvents')}</div>;
  return (
    <ol className="sdlc-event-list">
      {view.events.slice(-8).map((event) => (
        <li key={event.id}>
          <span className="sdlc-muted">{event.ts ? event.ts.slice(11, 19) : ''}</span>
          {' '}<strong>{event.actor ?? '—'}</strong> {event.action ?? ''}
          {event.taskId ? ` · ${event.taskId}` : ''}
          {event.result && event.result !== 'ok' ? ` · ${event.result}` : ''}
        </li>
      ))}
    </ol>
  );
}
