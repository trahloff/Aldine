import { useEffect, useRef, useState } from 'react';
import { Comment, type Person } from '../api';
import MentionTextarea, { MentionText, mentionsIn } from './MentionTextarea';
import { friendlyDate } from '../util/dates';
import LoadError from './LoadError';
import { COMMENT_MAX, LengthNote } from './CommentComposer';
import { reviewOrder } from '../util/reviewOrder';

interface Props {
  comments: Comment[];
  /** Whether `comments` is this branch's list: before it arrives, or when it
   *  failed, an empty list is not "no comments yet". */
  load?: 'loading' | 'ok' | 'error';
  onRetry?(): void;
  activeFile: string | null;
  onReveal(c: Comment): void;
  onResolve(c: Comment, resolved: boolean): void;
  onDelete(c: Comment): void;
  /** Settles once the reply is saved; on a rejection the box keeps the text. */
  onReply(c: Comment, body: string, mentions?: string[]): Promise<void>;
  onAccept(c: Comment): void;
  /** A read-only showcase: threads can be read, not answered, resolved or deleted. */
  readOnly?: boolean;
  /** What the empty list says while `readOnly`. */
  readOnlyNote?: string;
  /** Whether this person may delete the thread (the server's rule: their own, or any as an editing member). */
  canDelete?(c: Comment): boolean;
  /** Whether suggestions can be applied here: not by someone who can only view. */
  canAccept?: boolean;
  /** The document's files in reading order (root first): the threads follow it. */
  fileOrder?: string[];
  /** The thread to mark: the caret is in its text, or it was asked for. A new
   *  `n` scrolls it into view again. */
  active?: { id: string; n: number } | null;
  /** Who a thread can @mention or be assigned to; empty hides both (no accounts). */
  people?: Person[];
  /** The signed-in account, for "For me". */
  meId?: string;
  onAssign?(c: Comment, to: string | null): void;
}

/** Does this thread wait on `me`: assigned to them, or mentioning them? */
export const waitsOn = (c: Comment, me: string) =>
  c.assignee?.id === me || !!c.mentions?.includes(me) || c.replies.some((r) => r.mentions?.includes(me));

/** A reply to one thread: Enter or Reply sends it, Shift+Enter starts a new
 *  line. The text goes only once the server has it. */
function ReplyBox({ c, onReply, people }: { c: Comment; onReply(c: Comment, body: string, mentions?: string[]): Promise<void>; people: Person[] }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const body = text.trim();
  const ready = !busy && !!body && body.length <= COMMENT_MAX;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await onReply(c, body, mentionsIn(body, people));
      setText('');
    } catch { /* the caller said why; the text stays for another try */ } finally {
      setBusy(false);
    }
  };
  return (
    <div className="review__reply-box">
      <div className="review__reply-row">
        <MentionTextarea
          className="input review__reply-input"
          placeholder={people.length ? 'Reply… @ mentions' : 'Reply…'}
          aria-label={`Reply to ${c.author}`}
          rows={text.includes('\n') ? 3 : 1}
          value={text}
          people={people}
          data-testid={`reply-${c.id}`}
          onValue={setText}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }}
        />
        <button className="btn btn--small" disabled={!ready} onClick={() => void send()} data-testid={`reply-send-${c.id}`}>{busy ? 'Sending…' : 'Reply'}</button>
      </div>
      <LengthNote length={body.length} testId={`reply-count-${c.id}`} />
    </div>
  );
}

export default function ReviewPanel({ comments, load = 'ok', onRetry, activeFile, onReveal, onResolve, onDelete, onReply, onAccept, readOnly = false, readOnlyNote = 'Comments are off on this read-only showcase.', canDelete = () => true, canAccept = !readOnly, fileOrder = [], active = null, people = [], meId, onAssign }: Props) {
  const [mine, setMine] = useState(false);
  const forMe = meId ? comments.filter((c) => !c.resolved && waitsOn(c, meId)).length : 0;
  const ordered = reviewOrder(mine && meId ? comments.filter((c) => waitsOn(c, meId)) : comments, fileOrder);
  const open = ordered.filter((c) => !c.resolved);
  const resolved = ordered.filter((c) => c.resolved);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    listRef.current?.querySelector(`[data-comment-card="${CSS.escape(active.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active?.id, active?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const card = (c: Comment) => (
    <div key={c.id} className={`review__item${c.resolved ? ' review__item--resolved' : ''}${active?.id === c.id ? ' review__item--active' : ''}`}
      data-testid={`comment-${c.id}`} data-comment-card={c.id} aria-current={active?.id === c.id || undefined}>
      <button className="review__anchor" onClick={() => onReveal(c)} title="Jump to the commented text">
        <span className="review__file">{c.file !== activeFile ? c.file + ' · ' : ''}</span>
        <span className="review__quote">“{c.anchor.quote.slice(0, 60)}{c.anchor.quote.length > 60 ? '…' : ''}”</span>
      </button>
      <div className="review__body"><MentionText text={c.body} mentions={c.mentions} people={people} /></div>
      {c.suggestion !== undefined && (
        <div className="review__suggestion">
          <div className="review__sugg-label">Suggested change</div>
          <pre className="review__sugg-text">{c.suggestion || '(delete)'}</pre>
          {!c.resolved && !readOnly && canAccept && <button className="btn btn--small btn--primary" data-testid={`accept-${c.id}`} onClick={() => onAccept(c)}>Accept</button>}
        </div>
      )}
      <div className="review__meta">{c.author} · {friendlyDate(c.createdAt)}</div>
      {(c.assignee || (people.length > 0 && !readOnly && !c.resolved && onAssign)) && (
        <div className="review__assign">
          {people.length > 0 && !readOnly && !c.resolved && onAssign ? (
            <label className="review__assign-label">
              <span>Assigned to</span>
              <select className="input review__assign-select" value={c.assignee?.id ?? ''} data-testid={`assign-${c.id}`}
                onChange={(e) => onAssign(c, e.target.value || null)}>
                <option value="">Nobody</option>
                {c.assignee && !people.some((p) => p.id === c.assignee!.id) && <option value={c.assignee.id}>{c.assignee.name}</option>}
                {people.map((p) => <option key={p.id} value={p.id}>{p.id === meId ? `${p.name} (you)` : p.name}</option>)}
              </select>
            </label>
          ) : c.assignee && <span className="review__assignee" data-testid={`assignee-${c.id}`}>Assigned to {c.assignee.id === meId ? 'you' : c.assignee.name}</span>}
        </div>
      )}
      {c.replies.map((r, i) => (
        <div key={i} className="review__reply">
          <span className="review__reply-author">{r.author}</span> <MentionText text={r.body} mentions={r.mentions} people={people} />
        </div>
      ))}
      {!readOnly && !c.resolved && <ReplyBox c={c} onReply={onReply} people={people} />}
      {!readOnly && <div className="review__actions">
        <button className="btn btn--ghost btn--small" data-testid={`resolve-${c.id}`} onClick={() => onResolve(c, !c.resolved)}>
          {c.resolved ? 'Reopen' : 'Resolve'}
        </button>
        {canDelete(c) && <button className="btn btn--ghost btn--small" title="Delete comment" aria-label="Delete comment" data-testid={`delete-${c.id}`} onClick={() => onDelete(c)}>✕</button>}
      </div>}
    </div>
  );

  return (
    <div className="panel-list" data-testid="review-panel" ref={listRef}>
      {meId && people.length > 0 && comments.length > 0 && (
        <div className="seg review__filter" role="group" aria-label="Which threads">
          <button className={`seg__btn${!mine ? ' seg__btn--active' : ''}`} aria-pressed={!mine} onClick={() => setMine(false)} data-testid="review-filter-all">All</button>
          <button className={`seg__btn${mine ? ' seg__btn--active' : ''}`} aria-pressed={mine} onClick={() => setMine(true)} data-testid="review-filter-mine">For me{forMe ? ` (${forMe})` : ''}</button>
        </div>
      )}
      {mine && ordered.length === 0 && comments.length > 0 && (
        <p style={{ color: 'var(--text-2)', padding: 8, fontSize: 'var(--text-s)' }} data-testid="review-mine-empty">No thread is assigned to you or mentions you.</p>
      )}
      {load === 'error' && <LoadError text="Couldn’t load the review comments." onRetry={() => onRetry?.()} testId="review-error" />}
      {load === 'loading' && comments.length === 0 && <p style={{ color: 'var(--text-2)', padding: 8, fontSize: 'var(--text-s)' }} data-testid="review-loading">Loading the comments…</p>}
      {load === 'ok' && comments.length === 0 && (
        <p style={{ color: 'var(--text-2)', padding: 8, fontSize: 'var(--text-s)' }} data-testid="review-empty">
          {readOnly
            ? readOnlyNote
            : <>Select text in the editor and click <strong>Comment</strong> to start a review thread.</>}
        </p>
      )}
      {open.map(card)}
      {resolved.length > 0 && <div className="review__divider">Resolved ({resolved.length})</div>}
      {resolved.map(card)}
    </div>
  );
}
