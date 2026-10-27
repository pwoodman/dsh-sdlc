/**
 * packages/sdlc-client-ui/src/client/SdlcTab.jsx — the SDLC sidebar tab body.
 *
 * Four primary surfaces plus settings:
 *   Now     — the one thing worth doing, with the button that does it
 *   Flow    — attention, progress, stages, task detail and evidence
 *   Tasks   — searchable task list grouped by lifecycle state
 *   Review  — compare two runs of one task
 *   Settings (gear) — validated .sdlc/config.yml editor
 *
 * Status and Board were removed: Flow already carries the project/total/spend
 * header and Tasks is the board with filters. One flow snapshot now feeds Flow
 * and Tasks, so there is one poll and one source of truth.
 *
 * NOTE (subset rule): prop callbacks are single expressions — the offline JSX
 * compiler supports balanced braces but not statement blocks or bare arrow
 * parameters inside `{…}` props. Multi-statement handlers live as named
 * functions above.
 */

import { useState, useSyncExternalStore, useEffect } from 'react';
import { NowPanel, FlowPanel, TasksPanel, ReviewPanel, SettingsPanel } from './panels.jsx';
import { buildFlowView, buildAttention } from './flow.js';

const PANELS = ['now', 'flow', 'tasks', 'review'];
const TABS = ['now', 'flow', 'tasks', 'review', 'settings'];
// Poll faster while workers run, slower when the graph is quiet. Combined with
// the event cursor in the store this keeps the live feel without paying for a
// full event page on every tick.
const POLL_ACTIVE_MS = 2500;
const POLL_IDLE_MS = 8000;

/** True while at least one task or worker run is in flight. */
function hasLiveWork(snapshot) {
  const data = snapshot?.data;
  if (!data) return false;
  if (Number(data.totals?.activeTasks ?? 0) > 0) return true;
  return Array.isArray(data.runs) && data.runs.some((run) => (
    run.finishedAt == null && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled'
  ));
}

/** Fallback for tests/stubs where the session seat is not wired. */
function noSessions(selector) {
  return selector({ byId: {} });
}

function scrollTaskDetailIntoView() {
  if (typeof document === 'undefined') return;
  const node = document.getElementById('sdlc-task-detail');
  if (node && typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

export function SdlcTab({ stores, t, sessionId, useSessions: useSessionsProp }) {
  const [panel, setPanel] = useState('now');
  const [selectedTask, setSelectedTask] = useState(null);
  // A "Compare runs" click opens Review with that task already selected.
  const [reviewTask, setReviewTask] = useState(null);
  // The host is not session-scoped; send the tab's workspace with every call so
  // the Desktop app reads the open workspace instead of its profile directory.
  const useSessions = useSessionsProp ?? noSessions;
  const cwd = useSessions((sessions) => sessions.byId?.[sessionId]?.cwd);
  const flow = useSyncExternalStore(stores.flow.subscribe, stores.flow.getSnapshot);
  const config = useSyncExternalStore(stores.config.subscribe, stores.config.getSnapshot);
  const review = useSyncExternalStore(stores.review.subscribe, stores.review.getSnapshot);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(tick, POLL_IDLE_MS);
        return;
      }
      if (!inFlight) {
        inFlight = true;
        try {
          await stores.loadFlow({ cwd });
        } finally {
          inFlight = false;
        }
      }
      if (cancelled) return;
      timer = setTimeout(tick, hasLiveWork(stores.flow.getSnapshot()) ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [stores, cwd]);

  useEffect(() => {
    if (panel !== 'settings') return;
    if (stores.config.getSnapshot().phase === 'loading') stores.loadConfig(cwd);
  }, [panel, stores, cwd]);

  useEffect(() => {
    if (!selectedTask) return undefined;
    const timer = setTimeout(scrollTaskDetailIntoView, 40);
    return () => clearTimeout(timer);
  }, [selectedTask, panel]);

  const view = flow.data ? buildFlowView(flow.data) : null;
  const attentionCount = view ? buildAttention(view).length : 0;
  const taskCount = view ? view.nodes.length : 0;

  const selectPanel = (next) => setPanel(next);
  const showTasks = () => setPanel('tasks');
  const showFlow = () => setPanel('flow');
  // The Now card's deep links (review a change, open a live run) select the
  // task and jump to the Flow panel where the evidence lives.
  const selectTaskFromNow = (taskId) => {
    setSelectedTask(taskId ?? null);
    setPanel('flow');
    requestAnimationFrame(scrollTaskDetailIntoView);
  };
  const openReview = (taskId) => {
    setReviewTask(taskId ?? null);
    setPanel('review');
  };
  const loadFlow = () => stores.loadFlow({ cwd });
  const startRun = (goal) => stores.startRun(goal, cwd);
  const loadConfig = () => stores.loadConfig(cwd);
  const saveConfig = (path, value) => stores.saveConfig(path, value, cwd);
  const adoptHostModel = () => stores.adoptHostModel(cwd);
  const loadCompare = (task, a, b) => stores.loadCompare(task, a, b, cwd);
  const runAction = (body) => stores.runAction(body, cwd);
  const toggleTask = (taskId) => setSelectedTask((current) => (
    current === taskId ? null : taskId
  ));

  const onTabKeyDown = (event) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const from = TABS.indexOf(panel);
    let next = from;
    if (event.key === 'ArrowRight') next = (from + 1) % TABS.length;
    if (event.key === 'ArrowLeft') next = (from - 1 + TABS.length) % TABS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = TABS.length - 1;
    setPanel(TABS[next]);
    const focusTarget = document.getElementById(`sdlc-tab-${TABS[next]}`);
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
  };

  return (
    <div className="sdlc-root">
      <div className="sdlc-tabs" role="tablist" aria-label={t('panel.tabsLabel')} onKeyDown={onTabKeyDown}>
        {PANELS.map((item) => (
          <button
            key={item}
            id={`sdlc-tab-${item}`}
            role="tab"
            type="button"
            className="sdlc-tab"
            aria-selected={panel === item}
            aria-controls={panel === item ? `sdlc-panel-${item}` : undefined}
            tabIndex={panel === item ? 0 : -1}
            onClick={() => selectPanel(item)}
          >
            <span>{t(`panel.${item}`)}</span>
            {item === 'flow' && attentionCount > 0 && (
              <span className="sdlc-tab-badge sdlc-tab-badge-bad">{attentionCount}</span>
            )}
            {item === 'tasks' && taskCount > 0 && (
              <span className="sdlc-tab-badge">{taskCount}</span>
            )}
          </button>
        ))}
        <button
          id="sdlc-tab-settings"
          role="tab"
          type="button"
          className="sdlc-tab sdlc-tab-icon"
          aria-selected={panel === 'settings'}
          aria-controls={panel === 'settings' ? 'sdlc-panel-settings' : undefined}
          aria-label={t('panel.settingsLabel')}
          title={t('panel.settings')}
          tabIndex={panel === 'settings' ? 0 : -1}
          onClick={() => selectPanel('settings')}
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </div>
      <div
        className="sdlc-panel-body"
        role="tabpanel"
        id={`sdlc-panel-${panel}`}
        aria-labelledby={`sdlc-tab-${panel}`}
      >
        {panel === 'now' && (
          <NowPanel
            snapshot={flow}
            t={t}
            cwd={cwd}
            onReload={loadFlow}
            onStart={startRun}
            onAction={runAction}
            onShowFlow={showFlow}
            onSelectTask={selectTaskFromNow}
          />
        )}
        {panel === 'flow' && (
          <FlowPanel
            snapshot={flow}
            t={t}
            cwd={cwd}
            selectedTask={selectedTask}
            onSelectTask={toggleTask}
            onOpenReview={openReview}
            onReload={loadFlow}
            onShowTasks={showTasks}
            onStart={startRun}
          />
        )}
        {panel === 'tasks' && (
          <TasksPanel
            snapshot={flow}
            t={t}
            cwd={cwd}
            selectedTask={selectedTask}
            onSelectTask={toggleTask}
            onOpenReview={openReview}
            onReload={loadFlow}
          />
        )}
        {panel === 'review' && (
          <ReviewPanel
            snapshot={review}
            flowSnapshot={flow}
            t={t}
            cwd={cwd}
            initialTask={reviewTask}
            onCompare={loadCompare}
            onRetryFlow={loadFlow}
          />
        )}
        {panel === 'settings' && (
          <SettingsPanel
            snapshot={config}
            t={t}
            cwd={cwd}
            onReload={loadConfig}
            onSave={saveConfig}
            onAdoptHostModel={adoptHostModel}
          />
        )}
      </div>
    </div>
  );
}

export function SdlcTitle({ t }) {
  return <span>{t('tab.label')}</span>;
}

export default { SdlcTab, SdlcTitle };
