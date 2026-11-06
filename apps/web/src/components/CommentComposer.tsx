import { useState } from 'react';
import Modal from './Modal';
import { isMac } from '../platform';

/** Characters the server keeps in a comment, a reply or a suggestion. */
export const COMMENT_MAX = 20000;

/** Past nine tenths of the limit: the count, and over it, why posting waits. */
export function LengthNote({ length, testId }: { length: number; testId: string }) {
  if (length <= COMMENT_MAX * 0.9) return null;
  const over = length > COMMENT_MAX;
  return (
    <p className={`composer__count${over ? ' composer__count--over' : ''}`} data-testid={testId} role={over ? 'alert' : undefined}>
      {length.toLocaleString('en-US')} of {COMMENT_MAX.toLocaleString('en-US')} characters{over ? ': shorten it to post it' : ''}
    </p>
  );
}

/** Inline composer for a new review comment (replaces the old window.prompt flow).
 *  `onSubmit` settles once the comment is saved; when it rejects, the
 *  composer stays open with the text, for another try. */
export default function CommentComposer({ quote, onSubmit, onClose }: {
  quote: string;
  onSubmit(body: string, suggestion?: string): Promise<void>;
  onClose(): void;
}) {
  const [body, setBody] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [busy, setBusy] = useState(false);

  // The box starts from the selected text; left as it is, nothing is
  // suggested, and emptied it suggests deleting the selection.
  const suggested = suggesting && suggestion !== quote ? suggestion : undefined;
  const tooLong = body.trim().length > COMMENT_MAX || (suggested?.length ?? 0) > COMMENT_MAX;
  const ready = !busy && !tooLong && (!!body.trim() || suggested !== undefined);
  const submit = () => {
    if (!ready) return;
    setBusy(true);
    onSubmit(body.trim(), suggested).catch(() => setBusy(false));
  };

  return (
    <Modal onClose={onClose} label="Add a comment" width={500} testId="comment-composer">
      <div>
        <h2 style={{ marginBottom: 8 }}>Add a comment</h2>
        <blockquote className="composer__quote" title={quote}>{quote}</blockquote>
        <textarea
          className="input composer__body"
          placeholder="Your comment…"
          value={body}
          data-testid="comment-body"
          autoFocus
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
        />
        <LengthNote length={body.trim().length} testId="comment-count" />

        {suggesting ? (<>
          <textarea
            className="input composer__body"
            placeholder="Leave empty to suggest deleting the selected text"
            aria-label="Suggested replacement for the selected text"
            value={suggestion}
            data-testid="comment-suggestion"
            autoFocus
            onChange={(e) => setSuggestion(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
          />
          <LengthNote length={suggestion.length} testId="comment-suggestion-count" />
        </>) : (
          <button className="btn btn--ghost btn--small composer__suggest" onClick={() => { setSuggestion(quote); setSuggesting(true); }} data-testid="comment-suggest-toggle">
            + Suggest a replacement
          </button>
        )}

        <div className="modal__row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={submit} disabled={!ready} data-testid="comment-submit">
            {busy ? '…' : suggested === '' ? 'Suggest deleting' : 'Comment'} <span className="composer__hint">{isMac ? '⌘⏎' : 'Ctrl+Enter'}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
