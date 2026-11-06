import { useEffect, useState } from 'react';
import { syncLabel, type SyncState } from '../editor/syncStatus';

/** A file loads in a few milliseconds: "Connecting…" only for one that takes
 *  longer, or every file opened would flash it. */
const CONNECTING_SHOWN_AFTER_MS = 400;

/** Whether the open file's edits are on the server: quiet while they are,
 *  plain about it when the connection is gone. A read-only showcase has no
 *  edits to report on, only whether it has loaded. */
export default function SyncStatus({ state, readOnly }: { state: SyncState; readOnly?: boolean }) {
  const { phase, text, title } = syncLabel(state);
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    if (phase !== 'connecting') return;
    const t = setTimeout(() => setSlowLoad(true), CONNECTING_SHOWN_AFTER_MS);
    return () => { clearTimeout(t); setSlowLoad(false); };
  }, [phase]);
  if (phase === 'connecting' && !slowLoad) return null;
  if (readOnly && (phase === 'saved' || phase === 'saving')) return null;
  return (
    <span
      className={`sync-status sync-status--${phase}`}
      role="status"
      title={title}
      data-testid="sync-status"
      data-state={phase}
      data-unsynced={state.unsynced ? 'true' : 'false'}
    >
      {phase === 'offline' && <span className="dot dot--warn" aria-hidden="true" />}
      {text}
    </span>
  );
}
