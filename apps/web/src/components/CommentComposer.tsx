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

  const submit = () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    onSubmit(body.trim(), suggesting && suggestion ? suggestion : undefined);
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
            placeholder="Suggested replacement for the selected text"
            value={suggestion}
            data-testid="comment-suggestion"
            onChange={(e) => setSuggestion(e.target.value)}
          />
        ) : (
          <button className="btn btn--ghost btn--small composer__suggest" onClick={() => setSuggesting(true)} data-testid="comment-suggest-toggle">
            + Suggest a replacement
          </button>
        )}

        <div className="modal__row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={submit} disabled={!body.trim() || busy} data-testid="comment-submit">
            {busy ? '…' : 'Comment'} <span className="composer__hint">{isMac ? '⌘⏎' : 'Ctrl+Enter'}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
