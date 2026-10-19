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

export function SdlcTab({ stores, t }) {
  const [panel, setPanel] = useState('flow');
  const status = useSyncExternalStore(stores.status.subscribe, stores.status.getSnapshot);
  const board = useSyncExternalStore(stores.board.subscribe, stores.board.getSnapshot);
  const config = useSyncExternalStore(stores.config.subscribe, stores.config.getSnapshot);
  const review = useSyncExternalStore(stores.review.subscribe, stores.review.getSnapshot);
  const flow = useSyncExternalStore(stores.flow.subscribe, stores.flow.getSnapshot);

  useEffect(() => {
    if (panel !== 'flow') return undefined;
    stores.loadFlow();
    const timer = setInterval(() => { stores.loadFlow(); }, 5000);
    return () => clearInterval(timer);
  }, [panel, stores]);

  const selectPanel = (p) => setPanel(p);
  const openTaskReview = (taskId) => {
    void taskId;
    setPanel('review');
  };
  const reloadStatus = () => stores.loadStatus();
  const reloadBoard = () => stores.loadBoard();
  const reloadConfig = () => stores.loadConfig();
  const saveConfig = (path, value) => stores.saveConfig(path, value);
  const loadCompare = (task, a, b) => stores.loadCompare(task, a, b);
  const loadFlow = () => stores.loadFlow();

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
      {panel === 'review' && <ReviewPanel snapshot={review} onCompare={loadCompare} />}
    </div>
  );
}

export function SdlcTitle({ t }) {
  return <span>{t('tab.label')}</span>;
}

export default { SdlcTab, SdlcTitle };
