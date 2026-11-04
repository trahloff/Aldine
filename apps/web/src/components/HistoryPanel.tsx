import { useEffect, useRef, useState } from 'react';
import { api, LogEntry, localUser } from '../api';
import { useToast } from './Toast';
import { friendlyDate } from '../util/dates';
import DiffView from './DiffView';
import Modal from './Modal';
import LoadError from './LoadError';

/** `version` bumps whenever the branch changed elsewhere (the files signal,
 *  a revert, an agent session ending); `live` polls while an agent is present,
 *  because its commits land on the autosave debounce, after the signal.
 *  `manual`: the project commits by hand, so the panel lists what is waiting
 *  and the commit asks for a message. `readOnly`: a showcase, whose history
 *  can be read but takes no commit.
 *  `focusRequest`: bumped by the parent to put the cursor in the message
 *  field; `onFocusHandled` resets it, so the same request never focuses twice.
 *  `hidden`: on another sidebar tab, the panel stays mounted but neither
 *  loads nor polls until it is shown again. */
export default function HistoryPanel({ projectId, branch, version = 0, live = false, manual = false, focusRequest = 0, onFocusHandled, readOnly = false, hidden = false }: { projectId: string; branch: string; version?: number; live?: boolean; manual?: boolean; focusRequest?: number; onFocusHandled?: () => void; readOnly?: boolean; hidden?: boolean }) {
  /** null until this branch's log has arrived. */
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<string[] | null>(null);
  const [msg, setMsg] = useState('');
  const [diff, setDiff] = useState<{ entry: LogEntry; patch: string } | null>(null);
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  /** Only the newest request may set the log: a poll can answer after a reload. */
  const seq = useRef(0);

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
  const load = () => {
    const n = ++seq.current;
    api.log(projectId, branch).then(
      (l) => { if (n === seq.current) { setLog(l); setFailed(false); } },
      () => { if (n === seq.current) setFailed(true); },
    );
    loadPending();
  };
  useEffect(() => { setLog(null); setFailed(false); }, [projectId, branch]);
  useEffect(() => { if (!hidden) load(); }, [projectId, branch, version, manual, hidden]);
  useEffect(() => {
    if (!focusRequest || hidden) return;
    inputRef.current?.focus();
    onFocusHandled?.();
  }, [focusRequest, hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  // Typing changes the working tree without any signal reaching this panel.
  useEffect(() => {
    if (!manual || hidden) return;
    const t = setInterval(loadPending, 4000);
    return () => clearInterval(t);
  }, [manual, projectId, branch, hidden]);
  useEffect(() => {
    if (!live || hidden) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [live, projectId, branch, hidden]);

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
      {!readOnly && <div style={{ display: 'flex', gap: 6, padding: '2px 0 8px' }}>
        <input
          ref={inputRef}
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={manual ? 'Commit message' : 'Checkpoint message'}
          value={msg}
          data-testid="commit-message"
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit(); }}
        />
        <button className="btn btn--small" onClick={commit} data-testid="commit-button" style={{ height: 28 }}>{manual ? 'Commit' : 'Save'}</button>
      </div>}
      {manual && pending && !readOnly && (
        <div className="history__pending" data-testid="uncommitted-changes" title={pending.join('\n')}>
          {pending.length === 0 ? 'No uncommitted changes' : `${pending.length} ${pending.length === 1 ? 'file' : 'files'} not committed yet: ${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', …' : ''}`}
        </div>
      )}
      {failed && <LoadError text="Couldn’t load the history." onRetry={load} testId="history-error" />}
      {log === null && !failed && <p style={{ color: 'var(--text-2)', padding: 8 }} data-testid="history-loading">Loading the history…</p>}
      {log?.map((c) => (
        <button key={c.hash} className={`history__item${c.author === 'Claude' ? ' history__item--agent' : ''}`} title={`${c.message}\n${c.hash.slice(0, 10)} — click to see changes`} data-testid={`commit-${c.hash.slice(0, 7)}`} onClick={() => openDiff(c)}>
          <div className="history__msg">{c.message}</div>
          <div className="history__meta">
            {c.author === 'Claude' && <span className="dot dot--agent" aria-hidden="true" data-testid="agent-commit-dot" />}
            {c.author} · {friendlyDate(c.date)}
          </div>
        </button>
      ))}
      {log?.length === 0 && !failed && <p style={{ color: 'var(--text-2)', padding: 8 }}>No history yet on this branch.</p>}

      {diff && (
        <Modal onClose={() => setDiff(null)} label={`Changes in “${diff.entry.message}”`} wide testId="diff-dialog">
          <h2 style={{ marginBottom: 2 }}>{diff.entry.message}</h2>
          <p className="modal__sub">{diff.entry.author} · {friendlyDate(diff.entry.date)} · {diff.entry.hash.slice(0, 10)}</p>
          <DiffView patch={diff.patch} />
          <div className="modal__row"><button className="btn" onClick={() => setDiff(null)} data-testid="diff-close">Close</button></div>
        </Modal>
      )}
    </div>
  );
}
