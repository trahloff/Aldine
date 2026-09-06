import { useEffect, useRef, ReactNode } from 'react';

interface Props {
  onClose: () => void;
  children: ReactNode;
  label: string;
  wide?: boolean;
  /** Panel width in px (padding included) — overrides the 440px default. */
  width?: number;
  testId?: string;
}

/**
 * Accessible modal dialog: role/aria-modal for screen readers, focus moved in
 * on open and restored on close, focus trapped within, Escape and
 * backdrop-click to dismiss.
 */
/** Open dialogs, innermost last: only the top one answers Escape and Tab,
 *  so a confirmation opened from inside a dialog does not close both. */
const openStack: symbol[] = [];

export default function Modal({ onClose, children, label, wide, width, testId }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const self = useRef(Symbol('modal'));
  const returnFocus = useRef<HTMLElement | null>(null);
  // Callers pass an inline arrow, so onClose has a new identity on every parent
  // render. Read it through a ref and mount the effect ONCE: keyed on onClose it
  // would re-run whenever the parent re-renders (a compile tick, a presence
  // update) and yank focus back to the first control mid-typing.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const id = self.current;
    openStack.push(id);
    returnFocus.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // focus the first focusable control, else the panel itself
    const focusables = () => Array.from(
      panel?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [],
    );
    (focusables()[0] ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== id) return;
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      const at = openStack.indexOf(id);
      if (at >= 0) openStack.splice(at, 1);
      document.removeEventListener('keydown', onKey, true);
      returnFocus.current?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className={`modal${wide ? ' modal--wide' : ''}`}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
}
