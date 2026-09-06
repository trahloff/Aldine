import { useEffect, useState } from 'react';
import { api, LogEntry, localUser } from '../api';
import { useToast } from './Toast';
import { friendlyDate } from '../util/dates';
import DiffView from './DiffView';

/** `version` bumps whenever the branch changed elsewhere (the files signal,
 *  a revert, an agent session ending); `live` polls while an agent is present,
 *  because its commits land on the autosave debounce, after the signal. */
export default function HistoryPanel({ projectId, branch, version = 0, live = false }: { projectId: string; branch: string; version?: number; live?: boolean }) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [msg, setMsg] = useState('');
  const [diff, setDiff] = useState<{ entry: LogEntry; patch: string } | null>(null);
  const toast = useToast();

  const openDiff = async (c: LogEntry) => {
    try {
      const d = await api.commitDiff(projectId, c.hash);
      setDiff({ entry: c, patch: d.patch });
    } catch (err: any) {
      toast(`Could not load diff: ${err.message}`, 'error');
    }
  };

  const load = () => api.log(projectId, branch).then(setLog).catch(() => setLog([]));
  useEffect(() => { load(); }, [projectId, branch, version]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [live, projectId, branch]);

  const commit = async () => {
    const message = msg.trim() || 'Checkpoint';
    try {
      const res = await api.commit(projectId, branch, message, localUser().name);
      toast(res.committed ? 'Saved checkpoint' : 'No changes since last checkpoint', res.committed ? 'ok' : 'info');
      setMsg('');
      load();
    } catch (err: any) {
      toast(`Checkpoint failed: ${err.message}`, 'error');
    }
  };

  return (
    <div className="panel-list" data-testid="history-panel">
      <div style={{ display: 'flex', gap: 6, padding: '2px 0 8px' }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="Checkpoint message"
          value={msg}
          data-testid="commit-message"
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        <button className="btn btn--small" onClick={commit} data-testid="commit-button" style={{ height: 28 }}>Save</button>
      </div>
      {log.map((c) => (
        <button key={c.hash} className={`history__item${c.author === 'Claude' ? ' history__item--agent' : ''}`} title={`${c.hash} — click to see changes`} data-testid={`commit-${c.hash.slice(0, 7)}`} onClick={() => openDiff(c)}>
          <div className="history__msg">{c.message}</div>
          <div className="history__meta">
            {c.author === 'Claude' && <span className="dot dot--agent" aria-hidden="true" data-testid="agent-commit-dot" />}
            {c.author} · {friendlyDate(c.date)}
          </div>
        </button>
      ))}
      {log.length === 0 && <p style={{ color: 'var(--text-2)', padding: 8 }}>No history yet on this branch.</p>}

      {diff && (
        <div className="modal-backdrop" onClick={() => setDiff(null)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 2 }}>{diff.entry.message}</h2>
            <p className="modal__sub">{diff.entry.author} · {friendlyDate(diff.entry.date)} · {diff.entry.hash.slice(0, 10)}</p>
            <DiffView patch={diff.patch} />
            <div className="modal__row"><button className="btn" onClick={() => setDiff(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
