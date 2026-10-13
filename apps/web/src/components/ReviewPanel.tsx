import { Comment } from '../api';
import { friendlyDate } from '../util/dates';

interface Props {
  comments: Comment[];
  activeFile: string | null;
  onReveal(c: Comment): void;
  onResolve(c: Comment, resolved: boolean): void;
  onDelete(c: Comment): void;
  onReply(c: Comment, body: string): void;
  onAccept(c: Comment): void;
}

export default function ReviewPanel({ comments, activeFile, onReveal, onResolve, onDelete, onReply, onAccept }: Props) {
  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  const card = (c: Comment) => (
    <div key={c.id} className={`review__item ${c.resolved ? 'review__item--resolved' : ''}`} data-testid={`comment-${c.id}`}>
      <button className="review__anchor" onClick={() => onReveal(c)} title="Jump to the commented text">
        <span className="review__file">{c.file !== activeFile ? c.file + ' · ' : ''}</span>
        <span className="review__quote">“{c.anchor.quote.slice(0, 60)}{c.anchor.quote.length > 60 ? '…' : ''}”</span>
      </button>
      <div className="review__body">{c.body}</div>
      {c.suggestion !== undefined && (
        <div className="review__suggestion">
          <div className="review__sugg-label">Suggested change</div>
          <pre className="review__sugg-text">{c.suggestion || '(delete)'}</pre>
          {!c.resolved && <button className="btn btn--small btn--primary" data-testid={`accept-${c.id}`} onClick={() => onAccept(c)}>Accept</button>}
        </div>
      )}
      <div className="review__meta">{c.author} · {friendlyDate(c.createdAt)}</div>
      {c.replies.map((r, i) => (
        <div key={i} className="review__reply">
          <span className="review__reply-author">{r.author}</span> {r.body}
        </div>
      ))}
      <div className="review__actions">
        {!c.resolved && (
          <input
            className="input review__reply-input"
            placeholder="Reply…"
            data-testid={`reply-${c.id}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                onReply(c, e.currentTarget.value.trim());
                e.currentTarget.value = '';
              }
            }}
          />
        )}
        <button className="btn btn--ghost btn--small" data-testid={`resolve-${c.id}`} onClick={() => onResolve(c, !c.resolved)}>
          {c.resolved ? 'Reopen' : 'Resolve'}
        </button>
        <button className="btn btn--ghost btn--small" title="Delete comment" onClick={() => onDelete(c)}>✕</button>
      </div>
    </div>
  );

  return (
    <div className="panel-list" data-testid="review-panel">
      {comments.length === 0 && (
        <p style={{ color: 'var(--text-2)', padding: 8, fontSize: 'var(--text-s)' }}>
          Select text in the editor and click <strong>Comment</strong> to start a review thread.
        </p>
      )}
      {open.map(card)}
      {resolved.length > 0 && <div className="review__divider">Resolved ({resolved.length})</div>}
      {resolved.map(card)}
    </div>
  );
}
