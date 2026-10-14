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
