import { useCallback, useSyncExternalStore } from 'react';

function media(query: string): MediaQueryList | null {
  try { return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null; } catch { return null; }
}

/** Whether a media query matches, live. False where there is no window to ask. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const m = media(query);
    m?.addEventListener('change', cb);
    return () => m?.removeEventListener('change', cb);
  }, [query]);
  return useSyncExternalStore(subscribe, () => media(query)?.matches ?? false, () => false);
}

export function prefersReducedMotion(): boolean {
  return media('(prefers-reduced-motion: reduce)')?.matches ?? false;
}
