import { useEffect, useRef, useState } from 'react';
import { Comment } from '../api';
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
  onReply(c: Comment, body: string): Promise<void>;
  onAccept(c: Comment): void;
  /** A read-only showcase: threads can be read, not answered, resolved or deleted. */
  readOnly?: boolean;
  /** Whether this person may delete the thread (the server's rule: their own, or any as an editing member). */
  canDelete?(c: Comment): boolean;
  /** Whether suggestions can be applied here: not by someone who can only view. */
  canAccept?: boolean;
  /** The document's files in reading order (root first): the threads follow it. */
  fileOrder?: string[];
  /** The thread to mark: the caret is in its text, or it was asked for. A new
   *  `n` scrolls it into view again. */
  active?: { id: string; n: number } | null;
}

/** A reply to one thread: Enter or Reply sends it, Shift+Enter starts a new
 *  line. The text goes only once the server has it. */
function ReplyBox({ c, onReply }: { c: Comment; onReply(c: Comment, body: string): Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const body = text.trim();
  const ready = !busy && !!body && body.length <= COMMENT_MAX;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await onReply(c, body);
      setText('');
    } catch { /* the caller said why; the text stays for another try */ } finally {
      setBusy(false);
    }
  };
  return (
    <div className="review__reply-box">
      <div className="review__reply-row">
        <textarea
          className="input review__reply-input"
          placeholder="Reply…"
          aria-label={`Reply to ${c.author}`}
          rows={text.includes('\n') ? 3 : 1}
          value={text}
          data-testid={`reply-${c.id}`}
          onChange={(e) => setText(e.target.value)}
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

export default function ReviewPanel({ comments, load = 'ok', onRetry, activeFile, onReveal, onResolve, onDelete, onReply, onAccept, readOnly = false, canDelete = () => true, canAccept = !readOnly, fileOrder = [], active = null }: Props) {
  const ordered = reviewOrder(comments, fileOrder);
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
      <div className="review__body">{c.body}</div>
      {c.suggestion !== undefined && (
        <div className="review__suggestion">
          <div className="review__sugg-label">Suggested change</div>
          <pre className="review__sugg-text">{c.suggestion || '(delete)'}</pre>
          {!c.resolved && !readOnly && canAccept && <button className="btn btn--small btn--primary" data-testid={`accept-${c.id}`} onClick={() => onAccept(c)}>Accept</button>}
        </div>
      )}
      <div className="review__meta">{c.author} · {friendlyDate(c.createdAt)}</div>
      {c.replies.map((r, i) => (
        <div key={i} className="review__reply">
          <span className="review__reply-author">{r.author}</span> {r.body}
        </div>
      ))}
      {!readOnly && !c.resolved && <ReplyBox c={c} onReply={onReply} />}
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
      {load === 'error' && <LoadError text="Couldn’t load the review comments." onRetry={() => onRetry?.()} testId="review-error" />}
      {load === 'loading' && comments.length === 0 && <p style={{ color: 'var(--text-2)', padding: 8, fontSize: 'var(--text-s)' }} data-testid="review-loading">Loading the comments…</p>}
      {load === 'ok' && comments.length === 0 && (
        <p style={{ color: 'var(--text-2)', padding: 8, fontSize: 'var(--text-s)' }} data-testid="review-empty">
          {readOnly
            ? 'Comments are off on this read-only showcase.'
            : <>Select text in the editor and click <strong>Comment</strong> to start a review thread.</>}
        </p>
      )}
      {open.map(card)}
      {resolved.length > 0 && <div className="review__divider">Resolved ({resolved.length})</div>}
      {resolved.map(card)}
    </div>
  );
}
