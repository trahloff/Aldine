import { useCallback, useEffect, useRef, useState } from 'react';

/** Open state for a panel hanging from a button: a press outside `ref` or
 *  Escape closes it. It is a disclosure, not an ARIA menu (it holds fields
 *  and switches). Put `trigger` on the button: focus inside the panel goes
 *  back to it on close instead of dropping to the page with the row it was on. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const isOpen = useRef(open);
  isOpen.current = open;
  const close = useCallback(() => {
    if (isOpen.current && ref.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key); };
  }, [open, close]);
  return { open, setOpen, close, ref, trigger };
}
