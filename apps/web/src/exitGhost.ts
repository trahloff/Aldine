import { useCallback, useRef } from 'react';

/** Longest exit in app.css (.is-leaving), plus a frame. */
const EXIT_MS = 180;

/**
 * Gives an element an exit animation without keeping it mounted: when React
 * removes it, a lifeless copy takes its place for the length of the exit.
 * Callers keep unmounting on close as they always did, and nothing waits for
 * the animation: the copy takes no input, is hidden from assistive tech and
 * carries no test ids or ids.
 *
 * Returns a ref callback; put it on the element that should leave.
 */
export function useExitGhost(): (el: HTMLElement | null) => void {
  const current = useRef<HTMLElement | null>(null);
  return useCallback((el: HTMLElement | null) => {
    const prev = current.current;
    current.current = el;
    if (el || !prev) return;
    // The ref is cleared while the element is still in the document, so its
    // box and scroll offsets can be read here. Whether it is really leaving
    // (and not a StrictMode re-attach) is known only after the commit.
    const box = prev.getBoundingClientRect();
    const fixed = getComputedStyle(prev).position === 'fixed';
    const all = [prev, ...Array.from(prev.querySelectorAll<HTMLElement>('*'))];
    const scrolled = all.map((n, i) => [i, n.scrollTop] as const).filter(([, top]) => top > 0);
    queueMicrotask(() => {
      if (prev.isConnected) return;
      const ghost = prev.cloneNode(true) as HTMLElement;
      const copies = [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>('*'))];
      for (const n of copies) {
        n.removeAttribute('data-testid');
        n.removeAttribute('id');
        n.removeAttribute('role');
      }
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      if (!fixed) {
        ghost.style.position = 'fixed';
        ghost.style.left = `${box.left}px`;
        ghost.style.top = `${box.top}px`;
        ghost.style.right = 'auto';
        ghost.style.bottom = 'auto';
        ghost.style.width = `${box.width}px`;
        ghost.style.margin = '0';
      }
      ghost.classList.add('is-leaving');
      document.body.appendChild(ghost);
      for (const [i, top] of scrolled) copies[i].scrollTop = top;
      setTimeout(() => ghost.remove(), EXIT_MS);
    });
  }, []);
}
