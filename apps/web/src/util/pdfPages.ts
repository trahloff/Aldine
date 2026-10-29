/** Where the PDF preview is: the page on screen and how many there are. */
export interface PdfPages { current: number; total: number }

export interface Box { top: number; height: number }

/**
 * The 1-based page that covers most of the viewport [viewTop, viewTop +
 * viewHeight], pages stacked top to bottom in order. `box` is read lazily so
 * a scroll frame touches only the pages near the viewport, not all of them.
 * Ties go to the earlier page, except at the end of the scroll range (`atEnd`):
 * the last pages can never scroll to the top there, so without it a viewport
 * tall enough for two whole pages would never name the last one.
 */
export function pageInView(count: number, box: (i: number) => Box, viewTop: number, viewHeight: number, atEnd = false): number {
  if (count <= 0) return 0;
  const viewBottom = viewTop + viewHeight;
  // first page whose bottom edge is below the viewport's top edge
  let lo = 0, hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const b = box(mid);
    if (b.top + b.height <= viewTop) lo = mid + 1;
    else hi = mid;
  }
  let best = lo, bestOverlap = -1;
  for (let i = lo; i < count; i++) {
    const b = box(i);
    if (b.top >= viewBottom) break;
    const overlap = Math.min(b.top + b.height, viewBottom) - Math.max(b.top, viewTop);
    if (overlap > bestOverlap || (atEnd && overlap === bestOverlap)) { best = i; bestOverlap = overlap; }
  }
  return best + 1;
}

/** What the page field holds as a page to go to, clamped to the document;
 *  null when it holds no number at all. */
export function parsePageInput(text: string, total: number): number | null {
  const m = /^\s*(\d+)\s*$/.exec(text);
  if (!m || total < 1) return null;
  return Math.min(Math.max(1, Number(m[1])), total);
}

/** A tiny external store: the preview writes it per scroll frame, and only
 *  the page field reads it, so scrolling never re-renders the editor page. */
export function createPdfPagesStore() {
  let state: PdfPages | null = null;
  const listeners = new Set<() => void>();
  return {
    get: (): PdfPages | null => state,
    set(next: PdfPages | null) {
      if (state === next || (state && next && state.current === next.current && state.total === next.total)) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type PdfPagesStore = ReturnType<typeof createPdfPagesStore>;
