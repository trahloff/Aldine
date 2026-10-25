import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from './useMediaQuery';

/** How long the items around an added or removed one take to close or open the gap. */
const MOVE_MS = 200;
const ENTER_MS = 150;
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * FLIP for a list whose items carry `data-id`: call `capture()` just before
 * the change that adds, removes or reorders items, and on the next render
 * each item that moved glides from where it was, and the ids passed as
 * `entering` fade and grow in. Under reduced motion nothing travels; an
 * entering item still fades.
 */
export function useFlip(container: RefObject<HTMLElement | null>) {
  const before = useRef<Map<string, DOMRect> | null>(null);
  const entering = useRef<Set<string>>(new Set());

  const capture = useCallback((enter: string[] = []) => {
    const el = container.current;
    if (!el) return;
    const map = new Map<string, DOMRect>();
    el.querySelectorAll<HTMLElement>('[data-id]').forEach((n) => map.set(n.dataset.id!, n.getBoundingClientRect()));
    before.current = map;
    enter.forEach((id) => entering.current.add(id));
  }, [container]);

  useLayoutEffect(() => {
    const prev = before.current;
    const el = container.current;
    if (!prev || !el) return;
    before.current = null;
    const reduce = prefersReducedMotion();
    el.querySelectorAll<HTMLElement>('[data-id]').forEach((n) => {
      const id = n.dataset.id!;
      const was = prev.get(id);
      if (entering.current.has(id)) {
        entering.current.delete(id);
        n.animate(
          reduce ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }],
          { duration: ENTER_MS, easing: EASE_OUT },
        );
        return;
      }
      if (!was || reduce) return;
      const now = n.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: MOVE_MS, easing: EASE_OUT });
    });
  });

  return capture;
}
