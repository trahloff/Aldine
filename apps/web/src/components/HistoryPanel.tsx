import { useEffect, useMemo, useRef, useState } from 'react';
import { api, LogEntry, localUser } from '../api';
import { useToast } from './Toast';
import { useDialogs } from './Dialogs';
import { clockTime, dateTime, sameDay } from '../util/dates';
import { filesSummary, historyRows, type CommitView, type HistoryRow } from '../util/history';
import { askWaitingCommit } from '../util/waitingCommit';
import DiffView from './DiffView';
import Modal from './Modal';
import LoadError from './LoadError';
import { IconBookmark, IconChevronRight } from './Icons';

/** Entries per "Show older". */
const PAGE = 50;
/** A reload keeps what is on screen, up to this many entries. */
const RELOAD_MAX = 200;
/** The repository's own committer name: an autosave has no person behind it. */
const NO_PERSON = 'Aldine';
import { agentName } from '../util/agentReview';

/** The commit's author as History names it: an agent commit says for whom. */
const authorLabel = (c: LogEntry) => (c.author === 'Claude' ? agentName([c.onBehalfOf]) : c.author);

/** `version` bumps whenever the branch changed elsewhere (the files signal,
 *  a revert, an agent session ending); `live` polls while an agent is present,
 *  because its commits land on the autosave debounce, after the signal.
 *  `manual`: the project commits by hand, so the panel lists what is waiting
 *  and the commit asks for a message. `readOnly`: a showcase, whose history
 *  can be read but takes no commit.
 *  `focusRequest`: bumped by the parent to put the cursor in the message
 *  field; `onFocusHandled` resets it, so the same request never focuses twice.
 *  `hidden`: on another sidebar tab, the panel stays mounted but neither
 *  loads nor polls until it is shown again.
 *  `onReverted`: an undo changed the files, the way typing would. */
export default function HistoryPanel({ projectId, branch, version = 0, live = false, manual = false, focusRequest = 0, onFocusHandled, readOnly = false, hidden = false, onReverted }: { projectId: string; branch: string; version?: number; live?: boolean; manual?: boolean; focusRequest?: number; onFocusHandled?: () => void; readOnly?: boolean; hidden?: boolean; onReverted?: () => void }) {
  /** null until this branch's log has arrived. */
  const [log, setLog] = useState<LogEntry[] | null>(null);
  /** An entry past the last one shown came back: there are older ones. */
  const [more, setMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<string[] | null>(null);
  const [msg, setMsg] = useState('');
  const [diff, setDiff] = useState<{ view: CommitView; patch: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  /** Folded autosave rows the person opened, by their oldest commit. */
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const toast = useToast();
  const dialogs = useDialogs();
  const inputRef = useRef<HTMLInputElement>(null);
  /** Only the newest request may set the log: a poll can answer after a reload. */
  const seq = useRef(0);
  /** Entries on screen: a reload asks for as many, so "Show older" survives it. */
  const shown = useRef(0);
  const rows = useMemo<HistoryRow[]>(() => historyRows(log ?? []), [log]);

  const openDiff = async (view: CommitView) => {
    try {
      const d = await api.commitDiff(projectId, view.entry.hash);
      setDiff({ view, patch: d.patch });
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
    const limit = Math.min(RELOAD_MAX, Math.max(PAGE, shown.current));
    // one more than shown: whether it came tells if there are older ones
    api.log(projectId, branch, { limit: limit + 1 }).then(
      (l) => { if (n === seq.current) { setLog(l.slice(0, limit)); shown.current = Math.min(l.length, limit); setMore(l.length > limit); setFailed(false); } },
      () => { if (n === seq.current) setFailed(true); },
    );
    loadPending();
  };
  const showOlder = async () => {
    if (!log || loadingOlder) return;
    const n = seq.current;
    setLoadingOlder(true);
    try {
      const got = await api.log(projectId, branch, { skip: log.length, limit: PAGE + 1 });
      const page = got.slice(0, PAGE);
      // a reload since then answers for the whole list
      if (n !== seq.current) return;
      setLog((cur) => {
        const have = new Set((cur ?? []).map((c) => c.hash));
        // commits that landed on top since shift the page: drop what is already listed
        const next = [...(cur ?? []), ...page.filter((c) => !have.has(c.hash))];
        shown.current = next.length;
        return next;
      });
      setMore(got.length > PAGE);
    } catch (err: any) {
      toast(`Could not load older changes: ${err.message}`, 'error');
    } finally {
      setLoadingOlder(false);
    }
  };
  useEffect(() => { setLog(null); setFailed(false); setMore(false); setUnfolded(new Set()); shown.current = 0; }, [projectId, branch]);
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

  /** Reverts `hash` as a new commit; with manual commits the edits waiting go first, under a message the person gives. */
  const revert = async (hash: string, message: string, before: string): Promise<{ ok: boolean; hash?: string } | null> => {
    let checkpoint: string | undefined;
    if (manual) {
      const m = await askWaitingCommit(dialogs, projectId, [branch], { before, confirmLabel: 'Commit and undo' });
      if (m === null) return null;
      checkpoint = m;
    }
    try {
      const res = await api.revertCommits(projectId, branch, [hash], message, localUser().name, checkpoint);
      load();
      if (res.ok) onReverted?.();
      return res;
    } catch (err: any) {
      // The server's conflict message already opens with "Could not revert".
      toast(/^Could not revert/.test(err.message) ? err.message : `Could not undo: ${err.message}`, 'error');
      return null;
    }
  };
  const undo = async (view: CommitView) => {
    if (undoing) return;
    setUndoing(true);
    try {
      const res = await revert(view.entry.hash, `Undo “${view.title}”`, 'undoing this change');
      if (!res) return;
      setDiff(null);
      if (!res.ok) { toast('Nothing to undo — this change is already undone', 'info'); return; }
      const undoHash = res.hash;
      toast(`Undid “${view.title}”`, 'ok', undoHash ? {
        label: 'Redo',
        testId: 'history-redo',
        onClick: () => {
          void revert(undoHash, `Redo “${view.title}”`, 'redoing this change').then((r) => {
            if (r) toast(r.ok ? `Redid “${view.title}”` : 'Nothing to redo — the change is already back', r.ok ? 'ok' : 'info');
          });
        },
      } : undefined);
    } finally {
      setUndoing(false);
    }
  };

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

  const person = (c: LogEntry) => (c.author && c.author !== NO_PERSON ? authorLabel(c) : '');
  const span = (from: string, to: string) => {
    if (!sameDay(from, to)) return `${dateTime(from)} – ${dateTime(to)}`;
    return clockTime(from) === clockTime(to) ? dateTime(from) : `${dateTime(from)} – ${clockTime(to)}`;
  };
  const commitRow = (v: CommitView) => {
    const c = v.entry;
    return (
      <button
        key={c.hash}
        className={`history__item history__item--${v.kind}`}
        title={`${c.message}\n${c.hash.slice(0, 10)} — click to see changes`}
        data-testid={`commit-${c.hash.slice(0, 7)}`}
        data-kind={v.kind}
        onClick={() => void openDiff(v)}
      >
        <div className="history__msg">
          {v.kind === 'checkpoint' && <span className="history__mark" title="A checkpoint someone named" data-testid="checkpoint-mark"><IconBookmark /><span className="visually-hidden">Checkpoint: </span></span>}
          {v.title}
        </div>
        <div className="history__meta">
          {v.kind === 'agent' && <span className="dot dot--agent" aria-hidden="true" data-testid="agent-commit-dot" />}
          {[person(c), dateTime(c.date)].filter(Boolean).join(' · ')}
        </div>
        {!!c.files?.length && <div className="history__files" data-testid="history-files">{filesSummary(c.files, c.fileCount)}</div>}
      </button>
    );
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
      {rows.map((r) => (r.kind === 'commit' ? commitRow(r.view) : (
        <div key={`autosaves:${r.key}`} className="history__group" data-testid="history-autosaves">
          <button
            className="history__item history__item--group"
            aria-expanded={unfolded.has(r.key)}
            title="Show each autosave"
            data-testid="history-autosaves-toggle"
            onClick={() => setUnfolded((u) => { const next = new Set(u); if (!next.delete(r.key)) next.add(r.key); return next; })}
          >
            <div className="history__msg">
              <span className={`history__chev${unfolded.has(r.key) ? ' history__chev--open' : ''}`} aria-hidden="true"><IconChevronRight /></span>
              {r.views.length} autosaves
            </div>
            <div className="history__meta">{span(r.views[r.views.length - 1].entry.date, r.views[0].entry.date)}</div>
            {r.files.length > 0 && <div className="history__files" data-testid="history-files">{filesSummary(r.files, r.fileCount)}</div>}
          </button>
          {unfolded.has(r.key) && <div className="history__sub">{r.views.map((v) => commitRow(v))}</div>}
        </div>
      )))}
      {log && more && !failed && (
        <button className="btn btn--small history__older" onClick={() => void showOlder()} aria-disabled={loadingOlder} data-testid="history-older">
          {loadingOlder ? 'Loading older changes…' : 'Show older'}
        </button>
      )}
      {log?.length === 0 && !failed && <p style={{ color: 'var(--text-2)', padding: 8 }}>No history yet on this branch.</p>}

      {diff && (
        <Modal onClose={() => setDiff(null)} label={`Changes in “${diff.view.title}”`} wide testId="diff-dialog">
          <h2 style={{ marginBottom: 2 }}>{diff.view.title}</h2>
          <p className="modal__sub">{[person(diff.view.entry), dateTime(diff.view.entry.date), diff.view.entry.hash.slice(0, 10)].filter(Boolean).join(' · ')}</p>
          <DiffView patch={diff.patch} />
          <div className="modal__row">
            <button className="btn" onClick={() => setDiff(null)} data-testid="diff-close">Close</button>
            {!readOnly && diff.view.entry.parents !== 0 && !!diff.patch.trim() && (
              <button className="btn" onClick={() => void undo(diff.view)} aria-disabled={undoing} data-testid="diff-undo" title="Makes a new commit that takes this change back out; History keeps both">
                Undo this change
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
