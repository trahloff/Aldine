import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { parsePageInput, type PdfPagesStore } from '../util/pdfPages';

/**
 * "3 / 12" in the preview's header: the page on screen and the page count.
 * A click turns the number into a field; Enter goes to the page typed,
 * Escape (or leaving the field) keeps the view where it is. The typeset PDF
 * and a PDF file's preview can be on screen together: each names its own
 * test ids (`${testId}-nav`, `-indicator`, `-input`).
 */
export default function PdfPageNav({ store, onGo, testId = 'pdf-page' }: { store: PdfPagesStore; onGo(page: number): void; testId?: string }) {
  const pages = useSyncExternalStore(store.subscribe, store.get);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape hand focus back to the number; a click elsewhere keeps it there.
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) { refocus.current = false; buttonRef.current?.focus(); }
  }, [editing]);
  // A typeset can replace the PDF mid-edit; with no PDF left there is nothing to go to.
  useEffect(() => { if (!pages) setEditing(false); }, [pages]);

  if (!pages) return null;
  const { current, total } = pages;

  const close = (go: boolean) => {
    if (go) {
      const page = parsePageInput(draft, total);
      if (page != null) onGo(page);
    }
    refocus.current = true;
    setEditing(false);
  };

  // The number and the field share one width, so opening the field moves nothing beside it.
  const digits = { '--page-digits': String(total).length } as CSSProperties;

  return (
    <div className="pdf-pages" style={digits} data-testid={`${testId}-nav`}>
      {editing ? (
        <span className="pdf-pages__label pdf-pages__label--editing">
          <input
            className="pdf-pages__num pdf-pages__input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="go"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); close(true); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
            }}
            onBlur={() => setEditing(false)}
            aria-label={`Go to page, 1 to ${total}`}
            data-testid={`${testId}-input`}
          />
          <span aria-hidden="true"> / {total}</span>
        </span>
      ) : (
        <button
          ref={buttonRef}
          className="pdf-pages__label"
          onClick={() => { setDraft(String(current)); setEditing(true); }}
          title="Go to a page"
          aria-label={`Page ${current} of ${total}. Go to a page`}
          data-testid={`${testId}-indicator`}
        >
          <span className="pdf-pages__num">{current}</span> / {total}
        </button>
      )}
    </div>
  );
}
