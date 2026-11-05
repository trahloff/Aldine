import { useState } from 'react';
import Modal from './Modal';
import { isMac } from '../platform';

/** Inline composer for a new review comment (replaces the old window.prompt flow). */
export default function CommentComposer({ quote, onSubmit, onClose }: {
  quote: string;
  onSubmit(body: string, suggestion?: string): void;
  onClose(): void;
}) {
  const [body, setBody] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [busy, setBusy] = useState(false);

  // The box starts from the selected text; left as it is, nothing is
  // suggested, and emptied it suggests deleting the selection.
  const suggested = suggesting && suggestion !== quote ? suggestion : undefined;
  const ready = !busy && (!!body.trim() || suggested !== undefined);
  const submit = () => {
    if (!ready) return;
    setBusy(true);
    onSubmit(body.trim(), suggested);
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

        {suggesting ? (
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
        ) : (
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
