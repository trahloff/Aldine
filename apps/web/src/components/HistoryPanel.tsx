import { useEffect, useState } from 'react';
import { api, LogEntry, localUser } from '../api';
import { useToast } from './Toast';
import { friendlyDate } from '../util/dates';
import DiffView from './DiffView';

/** `version` bumps whenever the branch changed elsewhere (the files signal,
 *  a revert, an agent session ending); `live` polls while an agent is present,
 *  because its commits land on the autosave debounce, after the signal.
 *  `manual`: the project commits by hand, so the panel lists what is waiting
 *  and the commit asks for a message. */
export default function HistoryPanel({ projectId, branch, version = 0, live = false, manual = false }: { projectId: string; branch: string; version?: number; live?: boolean; manual?: boolean }) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<string[] | null>(null);
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

  const loadPending = () => {
    if (!manual) { setPending(null); return; }
    api.changes(projectId, branch).then((r) => setPending(r.paths)).catch(() => setPending(null));
  };
  const load = () => { api.log(projectId, branch).then(setLog).catch(() => setLog([])); loadPending(); };
  useEffect(() => { load(); }, [projectId, branch, version, manual]);
  // Typing changes the working tree without any signal reaching this panel.
  useEffect(() => {
    if (!manual) return;
    const t = setInterval(loadPending, 4000);
    return () => clearInterval(t);
  }, [manual, projectId, branch]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [live, projectId, branch]);

  const commit = async () => {
    if (manual && !msg.trim()) { toast('Write a commit message first', 'info'); return; }
    const message = msg.trim() || 'Checkpoint';
    try {
      const res = await api.commit(projectId, branch, message, localUser().name);
      const noun = manual ? 'commit' : 'checkpoint';
      toast(res.committed ? `Saved ${noun}` : `No changes since the last ${noun}`, res.committed ? 'ok' : 'info');
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
          placeholder={manual ? 'Commit message' : 'Checkpoint message'}
          value={msg}
          data-testid="commit-message"
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        <button className="btn btn--small" onClick={commit} data-testid="commit-button" style={{ height: 28 }}>{manual ? 'Commit' : 'Save'}</button>
      </div>
      {manual && pending && (
        <div className="history__pending" data-testid="uncommitted-changes" title={pending.join('\n')}>
          {pending.length === 0 ? 'No uncommitted changes' : `${pending.length} ${pending.length === 1 ? 'file' : 'files'} not committed yet: ${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', …' : ''}`}
        </div>
      )}
      {log.map((c) => (
        <button key={c.hash} className={`history__item${c.author === 'Claude' ? ' history__item--agent' : ''}`} title={`${c.message}\n${c.hash.slice(0, 10)} — click to see changes`} data-testid={`commit-${c.hash.slice(0, 7)}`} onClick={() => openDiff(c)}>
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
