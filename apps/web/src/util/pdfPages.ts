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

/** A laid-out page: offsets against the scroller it stacks in. */
type PageEl = Pick<HTMLElement, 'offsetTop' | 'offsetHeight'>;
type Scroller = Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>;

/** The page on screen and the page count of `count` stacked pages in a
 *  scroller, null with none. */
export function pagesOnScreen(scroller: Scroller, count: number, page: (i: number) => PageEl | null | undefined): PdfPages | null {
  if (count <= 0) return null;
  const { scrollTop, clientHeight, scrollHeight } = scroller;
  const atEnd = scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2;
  const box = (i: number): Box => {
    const el = page(i);
    return { top: el?.offsetTop ?? 0, height: el?.offsetHeight ?? 0 };
  };
  return { current: pageInView(count, box, scrollTop, clientHeight, atEnd), total: count };
}

/** The scroll position that shows `page` from its top. Half the gap above it
 *  stays in view, so the page reads as the start of the view rather than as
 *  cut off; the first page (no `prev`) goes to the very top. */
export function scrollTopForPage(page: PageEl, prev: PageEl | null | undefined): number {
  const above = prev ? (page.offsetTop - (prev.offsetTop + prev.offsetHeight)) / 2 : page.offsetTop;
  return Math.max(0, page.offsetTop - above);
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

/** A point of the document: a page (0-based) and where on it, as fractions
 *  of the page's box. Unlike a scroll offset in pixels, it names the same
 *  place after a zoom, a width change or a new typeset. */
export interface PageSpot { page: number; fx: number; fy: number }

export interface Rect { left: number; top: number; width: number; height: number }

/**
 * The spot at (x, y) among `count` pages stacked top to bottom, `rect` read
 * lazily. It is on the first page whose bottom edge is at or below y, so a
 * point in the gap between two pages belongs to the one below, and a point
 * past the last page to the last.
 */
export function spotAt(count: number, rect: (i: number) => Rect, x: number, y: number): PageSpot | null {
  if (count <= 0) return null;
  let lo = 0, hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = rect(mid);
    if (r.top + r.height < y) lo = mid + 1;
    else hi = mid;
  }
  const r = rect(lo);
  return { page: lo, fx: r.width ? (x - r.left) / r.width : 0, fy: r.height ? (y - r.top) / r.height : 0 };
}

/** How far to scroll so that `spot` is back at (x, y). A document that has
 *  fewer pages now holds it on its last page. */
export function scrollToSpot(count: number, rect: (i: number) => Rect, spot: PageSpot, x: number, y: number): { left: number; top: number } {
  const r = rect(Math.min(spot.page, count - 1));
  return { left: r.left + spot.fx * r.width - x, top: r.top + spot.fy * r.height - y };
}

/**
 * The pages (0-based) on screen once `spot` is `refY` pixels below the top
 * of a view `viewHeight` tall, for pages `heights` tall stacked `gap` apart.
 * The view stays inside the pages, as the scroll range keeps it; `margin`
 * pixels past either edge count as on screen. Without a spot the view is at
 * the top.
 */
export function pagesAt(heights: number[], gap: number, spot: PageSpot | null, refY: number, viewHeight: number, margin = 0): number[] {
  const n = heights.length;
  if (!n) return [];
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) { tops.push(y); y += h + gap; }
  const end = y - gap;
  let start = 0;
  if (spot) {
    const i = Math.min(spot.page, n - 1);
    start = tops[i] + spot.fy * heights[i] - refY;
  }
  start = Math.max(0, Math.min(start, end - viewHeight));
  const from = start - margin, to = start + viewHeight + margin;
  const on: number[] = [];
  for (let i = 0; i < n; i++) {
    if (tops[i] >= to) break;
    if (tops[i] + heights[i] > from) on.push(i);
  }
  return on;
}
