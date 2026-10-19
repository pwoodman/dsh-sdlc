/**
 * packages/sdlc-client-ui/src/client/SdlcTab.jsx — the SDLC sidebar tab body.
 *
 * Panel switcher (Status | Board | Config | Review) over the four stores.
 * Uses `useSyncExternalStore` against the framework-free stores so the tab
 * works under any React 18 the host provides.
 *
 * NOTE (subset rule): prop callbacks are single expressions — the offline
 * JSX compiler supports balanced braces but not statement blocks or bare
 * arrow parameters inside `{…}` props. Multi-statement handlers live as
 * named functions above; panel switching loads lazily via the tab buttons'
 * onClick below (single-expression arrows are fine).
 */

import { useState, useSyncExternalStore, useEffect } from 'react';
import { StatusPanel, BoardPanel, ConfigPanel, ReviewPanel, FlowPanel } from './panels.jsx';

const PANELS = ['flow', 'status', 'board', 'config', 'review'];

/** Fallback for tests/stubs where the session seat is not wired. */
function noSessions(selector) {
  return selector({ byId: {} });
}

export function SdlcTab({ stores, t, sessionId, useSessions: useSessionsProp }) {
  const [panel, setPanel] = useState('flow');
  // A task card click opens Review with that task already in the picker.
  const [reviewTask, setReviewTask] = useState(null);
  // The host is not session-scoped; send the tab's workspace with every call so
  // the Desktop app reads the open workspace instead of its profile directory.
  const useSessions = useSessionsProp ?? noSessions;
  const cwd = useSessions((sessions) => sessions.byId?.[sessionId]?.cwd);
  const status = useSyncExternalStore(stores.status.subscribe, stores.status.getSnapshot);
  const board = useSyncExternalStore(stores.board.subscribe, stores.board.getSnapshot);
  const config = useSyncExternalStore(stores.config.subscribe, stores.config.getSnapshot);
  const review = useSyncExternalStore(stores.review.subscribe, stores.review.getSnapshot);
  const flow = useSyncExternalStore(stores.flow.subscribe, stores.flow.getSnapshot);

  useEffect(() => {
    // Every tab loads its own snapshot on first reveal. Status/board/config
    // used to stay in `loading` forever: only the flow panel had a loader, and
    // the Reload buttons sit behind the panels' loading branches.
    stores.loadPanel(panel, cwd);
    if (panel !== 'flow') return undefined;
    const timer = setInterval(() => { stores.loadFlow({ cwd }); }, 5000);
    return () => clearInterval(timer);
  }, [panel, stores, cwd]);

  const selectPanel = (p) => setPanel(p);
  const openTaskReview = (taskId) => {
    setReviewTask(taskId ?? null);
    setPanel('review');
  };
  const reloadStatus = () => stores.loadStatus(cwd);
  const reloadBoard = () => stores.loadBoard(cwd);
  const reloadConfig = () => stores.loadConfig(cwd);
  const saveConfig = (path, value) => stores.saveConfig(path, value, cwd);
  const loadCompare = (task, a, b) => stores.loadCompare(task, a, b, cwd);
  const loadFlow = () => stores.loadFlow({ cwd });

  return (
    <div className="sdlc-root">
      <div className="sdlc-tabs" role="tablist" aria-label="SDLC panels">
        {PANELS.map((p) => (
          <button
            key={p}
            role="tab"
            type="button"
            aria-selected={panel === p}
            onClick={() => selectPanel(p)}
          >
            {t(`panel.${p}`)}
          </button>
        ))}
      </div>
      {panel === 'flow' && <FlowPanel snapshot={flow} onReload={loadFlow} onSelectTask={openTaskReview} t={t} />}
      {panel === 'status' && <StatusPanel snapshot={status} onReload={reloadStatus} />}
      {panel === 'board' && (
        <BoardPanel
          snapshot={board}
          onReload={reloadBoard}
          onOpenTask={openTaskReview}
        />
      )}
      {panel === 'config' && (
        <ConfigPanel snapshot={config} onReload={reloadConfig} onSave={saveConfig} />
      )}
      {panel === 'review' && <ReviewPanel snapshot={review} onCompare={loadCompare} initialTask={reviewTask} />}
    </div>
  );
}

export function SdlcTitle({ t }) {
  return <span>{t('tab.label')}</span>;
}

export default { SdlcTab, SdlcTitle };
