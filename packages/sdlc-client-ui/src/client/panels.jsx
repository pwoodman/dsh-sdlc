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
  if (snapshot.phase === 'loading') return <div aria-live="polite">Loading flow status…</div>;
  if (snapshot.phase === 'missing') return <Missing reason={snapshot.reason} />;
  const { tasks, spend, projects } = snapshot.data;
  if (tasks.total === 0) return <div>No project initialised — run `sdlc init` first.</div>;
  return (
    <section aria-label="SDLC status">
      <button type="button" onClick={onReload}>Reload</button>
      <p>{tasks.total} tasks · ${Number(spend.costUsd).toFixed(4)} (estimate) · {spend.tokens} tokens</p>
      <ul>
        {Object.entries(tasks.byState).sort().map(([state, n]) => (
          <li key={state}>{state}: {n}</li>
        ))}
      </ul>
      {projects.length > 0 && (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>{p.id} — {p.state}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function BoardPanel({ snapshot, onReload, onOpenTask }) {
  if (snapshot.phase === 'loading') return <div aria-live="polite">Loading task board…</div>;
  if (snapshot.phase === 'missing') return <Missing reason={snapshot.reason} />;
  if (!snapshot.data.columns.length) return <div>No tasks yet.</div>;
  return (
    <section aria-label="SDLC task board">
      <button type="button" onClick={onReload}>Reload</button>
      {snapshot.data.columns.map((col) => (
        <BoardColumn key={col.state} col={col} onOpenTask={onOpenTask} />
      ))}
    </section>
  );
}

function BoardColumn({ col, onOpenTask }) {
  return (
    <div>
      <h3>{col.state} ({col.tasks.length})</h3>
      <ul>
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
    <li>
      <button type="button" onClick={open}>{t.id}</button>
      {' '}{t.title ?? t.id} · {t.role ?? '—'} · {t.riskClass ?? '—'}
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
  if (snapshot.phase === 'loading') return <div aria-live="polite">Loading configuration…</div>;
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
    <section aria-label="SDLC configuration">
      <button type="button" onClick={onReload}>Reload</button>
      {!validation.ok && (
        <div role="alert">
          {validation.errors.length} error(s):
          <ul>{validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {snapshot.saveError && <div role="alert">Save failed: {snapshot.saveError}</div>}
      <ul>
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
  return (
    <li>
      <label>
        {field.label} <code>{field.path}</code>
        {field.kind === 'select' && (
          <select value={String(shown ?? '')} onChange={draftSelect}>
            {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        {field.kind === 'boolean' && (
          <input type="checkbox" checked={shown === true || shown === 'true'} onChange={draftCheck} />
        )}
        {field.kind !== 'select' && field.kind !== 'boolean' && (
          <input type={field.kind === 'number' ? 'number' : 'text'} value={shown ?? ''} onChange={draftText} />
        )}
      </label>
      {field.hint && <span> ({field.hint})</span>}
      <button type="button" onClick={saveField} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {error && <span role="alert"> Rejected: {error}</span>}
    </li>
  );
}

function fmtMs(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ReviewPanel({ snapshot, onCompare }) {
  const [task, setTask] = useState(snapshot.task ?? '');
  const [runA, setRunA] = useState(snapshot.a ?? '');
  const [runB, setRunB] = useState(snapshot.b ?? '');
  if (snapshot.phase === 'idle') {
    // fall through to the picker below
  } else if (snapshot.phase === 'loading') {
    return <div aria-live="polite">Loading comparison…</div>;
  } else if (snapshot.phase === 'missing') {
    return (
      <section aria-label="SDLC review">
        <Missing reason={snapshot.reason} />
        <Picker task={task} setTask={setTask} runA={runA} setRunA={setRunA} runB={runB} setRunB={setRunB} onCompare={onCompare} />
      </section>
    );
  } else if (snapshot.phase === 'ready') {
    const report = snapshot.data;
    return (
      <section aria-label="SDLC review">
        <Picker task={task || report.task.id} setTask={setTask} runA={runA} setRunA={setRunA} runB={runB} setRunB={setRunB} onCompare={onCompare} />
        <h3>{report.task.id} — {report.task.state}</h3>
        <table>
          <thead><tr><th>dimension</th><th>A</th><th>B</th><th>Δ (B−A)</th></tr></thead>
          <tbody>
            <tr><td>status</td><td>{report.runs.A.status}</td><td>{report.runs.B.status}</td><td>{'—'}</td></tr>
            <tr><td>wall-clock</td><td>{fmtMs(report.runs.A.durationMs)}</td><td>{fmtMs(report.runs.B.durationMs)}</td><td>{report.deltas ? `${report.deltas.durationMs.delta}ms` : '—'}</td></tr>
            <tr><td>tokens total</td><td>{report.runs.A.tokensTotal}</td><td>{report.runs.B.tokensTotal}</td><td>{report.deltas ? report.deltas.tokensTotal.delta : '—'}</td></tr>
            <tr><td>cost (est.)</td><td>${report.runs.A.costUsdEstimate}</td><td>${report.runs.B.costUsdEstimate}</td><td>{'—'}</td></tr>
          </tbody>
        </table>
        <h4>Gates</h4>
        <ul>
          {report.gatesCompared.map((g) => (
            <GateRow key={g.gate} g={g} />
          ))}
        </ul>
        <h4>Trace path</h4>
        <p>{report.traceSummary.states} ({report.traceSummary.steps} steps)</p>
        <ol>
          {report.tracePath.map((s, i) => (
            <TraceRow key={i} s={s} />
          ))}
        </ol>
      </section>
    );
  }
  return (
    <section aria-label="SDLC review">
      <p>Pick two runs of a task to compare.</p>
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
    <form onSubmit={submit}>
      <PickerTask task={task} setTask={setTask} />
      <PickerRun label="Run A" value={runA} setValue={setRunA} />
      <PickerRun label="Run B" value={runB} setValue={setRunB} />
      <button type="submit">Compare</button>
    </form>
  );
}

function PickerTask({ task, setTask }) {
  const change = (e) => setTask(e.target.value);
  return <label>Task <input value={task} onChange={change} placeholder="DEMO-…" /></label>;
}

function PickerRun({ label, value, setValue }) {
  const change = (e) => setValue(e.target.value);
  return <label>{label} <input value={value} onChange={change} placeholder="run id" /></label>;
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

export function FlowPanel({ snapshot, onReload, onSelectTask, t }) {
  if (snapshot.phase === 'loading') return <div aria-live="polite">{t('flow.loading')}</div>;
  if (snapshot.phase === 'missing') return <Missing reason={snapshot.reason} />;
  const view = buildFlowView(snapshot.data);
  const reload = () => onReload();
  return (
    <section aria-label="SDLC flow" className="sdlc-flow">
      <div className="sdlc-flow-head">
        <button type="button" onClick={reload}>{t('flow.reload')}</button>
        <span className="sdlc-muted">
          {view.totals.tasks ?? 0} {t('flow.tasks')} · {view.totals.activeTasks ?? 0} {t('flow.active')}
          {' · '}{formatCost(view.totals.spend ? view.totals.spend.costUsd : null)} {t('flow.estimated')}
          {' · '}{formatTokens(view.totals.spend ? view.totals.spend.tokens : null)} tokens
        </span>
      </div>
      {snapshot.phase === 'stale' && <div role="status" className="sdlc-warn">{t('flow.stale')}: {snapshot.reason}</div>}
      {view.tasksTruncated && <div role="status" className="sdlc-warn">{t('flow.truncated')}</div>}
      {view.project.available === false && <Missing reason={view.project.reason || 'no project'} />}
      {view.unavailable.map((item) => (
        <div role="status" className="sdlc-warn" key={item.section}>{item.section}: {item.reason}</div>
      ))}
      {view.nodes.length === 0 && <div>{t('flow.empty')}</div>}
      {view.nodes.length > 0 && <FlowDag view={view} onSelectTask={onSelectTask} t={t} />}
      <FlowSummary view={view} t={t} />
      <FlowRuns view={view} t={t} />
      <FlowRouting view={view} t={t} />
      <FlowGates view={view} t={t} />
      <FlowLocks view={view} t={t} />
      <FlowEscalations view={view} t={t} />
      <FlowEvents view={view} t={t} />
    </section>
  );
}

function FlowDag({ view, onSelectTask, t }) {
  const label = t('flow.dagLabel').replace('{tasks}', String(view.nodes.length)).replace('{edges}', String(view.edges.length));
  return (
    <div className="sdlc-dag" style={{ width: view.width, height: view.height }} role="img" aria-label={label}>
      <svg className="sdlc-dag-edges" width={view.width} height={view.height} aria-hidden="true">
        {view.edges.map((edge) => (
          <path key={edge.key} d={edge.d} className={edge.bad ? 'sdlc-edge bad' : 'sdlc-edge'} />
        ))}
      </svg>
      {view.nodes.map((node) => (
        <FlowNode key={node.id} node={node} x={node.x} y={node.y} onSelectTask={onSelectTask} />
      ))}
    </div>
  );
}

function FlowNode({ node, x, y, onSelectTask }) {
  const open = () => onSelectTask(node.id);
  const deps = node.dependsOn.length ? `← ${node.dependsOn.join(', ')}` : '';
  return (
    <button
      type="button"
      className={`sdlc-node sdlc-tone-${toneOf(node.state)}`}
      style={{ left: x, top: y }}
      onClick={open}
      title={node.title}
    >
      <span className="sdlc-node-id">{node.id}</span>
      <span className="sdlc-node-state">{node.state}</span>
      <span className="sdlc-node-meta">{node.role ?? '—'} · {node.riskClass ?? '—'}</span>
      <span className="sdlc-node-meta">{node.tier ?? '—'} · {shortModel(node.model)}</span>
      {deps && <span className="sdlc-node-deps">{deps}</span>}
    </button>
  );
}

function FlowSummary({ view, t }) {
  const gates = view.gateSummary;
  return (
    <div className="sdlc-chips" aria-label={t('flow.summary')}>
      <span className="sdlc-chip sdlc-tone-good">{t('flow.pass')} {gates.pass}</span>
      <span className="sdlc-chip sdlc-tone-bad">{t('flow.fail')} {gates.fail}</span>
      <span className="sdlc-chip sdlc-tone-warn">{t('flow.skipped')} {gates.skipped}</span>
      <span className="sdlc-chip sdlc-tone-idle">{t('flow.unknown')} {gates.unknown}</span>
      <span className="sdlc-chip sdlc-tone-merge">{t('flow.active')} {view.totals.activeTasks ?? 0}</span>
    </div>
  );
}

function FlowRuns({ view, t }) {
  if (view.runs.length === 0) return <div className="sdlc-muted">{t('flow.noRuns')}</div>;
  return (
    <section aria-label={t('flow.subagents')} className="sdlc-flow-section">
      <h3>{t('flow.subagents')}</h3>
      <ul className="sdlc-run-list">
        {view.runs.map((run) => <FlowRun key={run.runId} run={run} />)}
      </ul>
    </section>
  );
}

function FlowRun({ run }) {
  const live = run.durationSource === 'live' ? ' (live)' : '';
  return (
    <li className={`sdlc-run sdlc-tone-${run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'running'}`}>
      <span className="sdlc-run-role">{run.role ?? '—'}</span>
      <span className="sdlc-run-id">{run.taskId}/{run.runId}</span>
      <span>{run.status}</span>
      <span>{run.modelProvider ? `${run.modelProvider}/` : ''}{shortModel(run.modelId)}</span>
      <span>{formatTokens(run.tokensTotal)} tok</span>
      <span>{formatDuration(run.durationMs)}{live}</span>
      <span>{run.pid == null ? 'no pid' : `pid ${run.pid}`}</span>
      {run.orphaned && <span className="sdlc-bad">orphaned</span>}
    </li>
  );
}

function FlowRouting({ view, t }) {
  if (view.routing.length === 0) return null;
  return (
    <section aria-label={t('flow.routing')} className="sdlc-flow-section">
      <h3>{t('flow.routing')}</h3>
      <ul className="sdlc-routing-list">
        {view.routing.map((route) => (
          <li key={route.taskId} className="sdlc-route">
            <span className="sdlc-route-task">{route.taskId}</span>
            <span className={`sdlc-chip sdlc-tone-${route.available ? 'good' : 'warn'}`}>{route.tier ?? '—'}</span>
            <span className="sdlc-muted">rule {route.rule ?? '—'} · {route.source}{route.partial ? ' (partial)' : ''}</span>
            <span className="sdlc-muted">{route.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FlowGates({ view, t }) {
  if (view.gates.length === 0) return null;
  return (
    <section aria-label={t('flow.gates')} className="sdlc-flow-section">
      <h3>{t('flow.gates')}</h3>
      <ul className="sdlc-gate-list">
        {view.gates.map((gate) => (
          <li key={`${gate.taskId}/${gate.gate}`} className={`sdlc-chip sdlc-tone-${gate.result === 'pass' ? 'good' : gate.result === 'fail' ? 'bad' : gate.result === 'skipped' ? 'warn' : 'idle'}`}>
            {gate.taskId} · {gate.gate} · {gate.status}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FlowLocks({ view, t }) {
  const violations = view.locks.violations ?? [];
  return (
    <section aria-label={t('flow.locks')} className="sdlc-flow-section">
      <h3>{t('flow.locks')}</h3>
      {view.locks.resources.length === 0 && <div className="sdlc-muted">{t('flow.noResources')}</div>}
      <ul className="sdlc-lock-list">
        {view.locks.resources.map((lock) => (
          <li key={lock.resource} className={`sdlc-chip sdlc-tone-${lock.status === 'held' ? 'running' : 'bad'}`}>
            {lock.resource}: {lock.holders.join(', ')} ({lock.status})
          </li>
        ))}
      </ul>
      {violations.map((v, index) => (
        <div key={index} role="alert" className="sdlc-bad">{v.kind}: {v.a} ↔ {v.b}</div>
      ))}
    </section>
  );
}

function FlowEscalations({ view, t }) {
  if (view.escalations.length === 0) return null;
  return (
    <section aria-label={t('flow.escalations')} className="sdlc-flow-section">
      <h3>{t('flow.escalations')}</h3>
      <ul className="sdlc-escalation-list">
        {view.escalations.map((item) => (
          <li key={item.id} className="sdlc-escalation">
            <span className={`sdlc-chip sdlc-tone-${item.resolution ? 'good' : 'warn'}`}>{item.level ?? '—'}</span>
            <span>{item.taskId ?? '—'}</span>
            <span>{item.question ?? '—'}</span>
            <span className="sdlc-muted">{item.source}{item.resolution ? ` · ${item.resolution}` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FlowEvents({ view, t }) {
  if (view.events.length === 0) return null;
  return (
    <section aria-label={t('flow.events')} className="sdlc-flow-section">
      <h3>{t('flow.events')}</h3>
      <ol className="sdlc-event-list">
        {view.events.slice(-30).map((event) => (
          <li key={event.id}>
            <span className="sdlc-muted">{event.ts ?? ''}</span>
            {' '}<strong>{event.actor ?? '—'}</strong> {event.action ?? ''}
            {event.taskId ? ` · ${event.taskId}` : ''}
            {event.result && event.result !== 'ok' ? ` · ${event.result}` : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}
