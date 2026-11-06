import type { CSSProperties, KeyboardEvent, RefObject } from 'react';
import { IconChevronDown, IconChevronUp, IconX } from './Icons';

interface Props {
  query: string;
  onQuery(query: string): void;
  /** What the count says (pdfFind's findCount). */
  count: string;
  /** Whether there is a match to step to. */
  canStep: boolean;
  onStep(dir: 1 | -1): void;
  onClose(): void;
  inputRef: RefObject<HTMLInputElement | null>;
  barRef: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
}

/** Find in the PDF preview, over its top right corner. */
export default function PdfFindBar({ query, onQuery, count, canStep, onStep, onClose, inputRef, barRef, style }: Props) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault();
      onStep(e.shiftKey ? -1 : 1);
    }
  };
  return (
    <div ref={barRef} className="pdf-find" role="search" aria-label="Find in the PDF" style={style} onKeyDown={onKeyDown} data-testid="pdf-find">
      <input
        ref={inputRef}
        className="input pdf-find__input"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Find in the PDF"
        aria-label="Find in the PDF"
        spellCheck={false}
        autoComplete="off"
        data-testid="pdf-find-input"
      />
      <span className="pdf-find__count" aria-live="polite" data-testid="pdf-find-count">{count}</span>
      <button className="btn btn--ghost btn--small btn--icon" onClick={() => onStep(-1)} disabled={!canStep} title="Previous match (Shift+Enter)" aria-label="Previous match" data-testid="pdf-find-prev"><IconChevronUp /></button>
      <button className="btn btn--ghost btn--small btn--icon" onClick={() => onStep(1)} disabled={!canStep} title="Next match (Enter)" aria-label="Next match" data-testid="pdf-find-next"><IconChevronDown /></button>
      <button className="btn btn--ghost btn--small btn--icon" onClick={onClose} title="Close Find (Esc)" aria-label="Close Find" data-testid="pdf-find-close"><IconX /></button>
    </div>
  );
}
