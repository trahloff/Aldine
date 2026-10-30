/**
 * The link annotations of a typeset PDF (hyperref's \ref, \cite, \href,
 * table of contents), as boxes to lay over the page. Every collaborator
 * writes the sources the PDF is made from, so a link's target is untrusted:
 * only web and mail addresses ever leave the app.
 */

const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

/** The address an external link may open, normalized; null for anything but
 *  an absolute http, https or mailto URL. */
export function safeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  return OPENABLE.has(url.protocol) ? url.href : null;
}

/** A box on a page in percent of the page's width and height: it stays on
 *  its spot at any zoom, and while a page is stretched before its redraw. */
export interface PageBox { left: number; top: number; width: number; height: number }

/** The page's viewport at scale 1: `transform` maps PDF user space to CSS
 *  pixels on the page, crop box and rotation included. */
export interface PageView { transform: ArrayLike<number>; width: number; height: number }

/** A point in PDF user space as CSS pixels from the page's top left corner. */
export function toPage(view: PageView, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = Array.from(view.transform);
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Where a PDF rectangle [x1, y1, x2, y2] (user space, either corner order)
 *  sits on the page; null when it has no area or the page has no size. */
export function rectToBox(rect: ArrayLike<number>, view: PageView): PageBox | null {
  const [x1, y1] = toPage(view, rect[0], rect[1]);
  const [x2, y2] = toPage(view, rect[2], rect[3]);
  const left = Math.min(x1, x2), top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
  if (!(width > 0 && height > 0 && view.width > 0 && view.height > 0)) return null;
  return {
    left: (left / view.width) * 100,
    top: (top / view.height) * 100,
    width: (width / view.width) * 100,
    height: (height / view.height) * 100,
  };
}

/** A destination as pdf.js reports it: a name, or an explicit array
 *  [page ref or index, { name: kind }, ...kind's numbers]. */
export type PdfDest = string | unknown[];

export type PageLink = { box: PageBox; url: string } | { box: PageBox; dest: PdfDest };

/** The links among pdf.js's annotations for a page: Link annotations with a
 *  safe URL or an internal destination. Anything else (javascript:, file:,
 *  relative paths, launch and named actions) is no link at all. */
export function pageLinks(annotations: readonly unknown[], view: PageView): PageLink[] {
  const links: PageLink[] = [];
  for (const a of annotations) {
    if (!a || typeof a !== 'object') continue;
    const { subtype, rect, url, dest } = a as { subtype?: unknown; rect?: unknown; url?: unknown; dest?: unknown };
    if (subtype !== 'Link' || !Array.isArray(rect)) continue;
    const box = rectToBox(rect, view);
    if (!box) continue;
    if (url !== undefined) {
      const safe = safeLinkUrl(url);
      if (safe) links.push({ box, url: safe });
    } else if (typeof dest === 'string' || Array.isArray(dest)) {
      links.push({ box, dest });
    }
  }
  return links;
}

/** The two lookups a destination needs, as on pdf.js's PDFDocumentProxy. */
export interface DestLookup {
  numPages: number;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

/** Where an internal link goes: a 1-based page and, when the destination
 *  names them, the point to show in PDF user space. */
export interface DestTarget { page: number; x: number | null; y: number | null }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The point a destination of each kind shows (PDF 32000-1 §12.3.2.2). */
function destPoint(kind: unknown, args: unknown[]): { x: number | null; y: number | null } {
  switch (kind) {
    case 'XYZ': return { x: num(args[0]), y: num(args[1]) };
    case 'FitH': case 'FitBH': return { x: null, y: num(args[0]) };
    case 'FitV': case 'FitBV': return { x: num(args[0]), y: null };
    case 'FitR': return { x: num(args[0]), y: num(args[3]) };
    default: return { x: null, y: null }; // Fit, FitB: the whole page
  }
}

/** The page and point a link's destination names; null for a name the PDF
 *  does not define, a page it does not have, or a malformed array. */
export async function resolveDest(doc: DestLookup, dest: PdfDest): Promise<DestTarget | null> {
  const explicit = typeof dest === 'string' ? await doc.getDestination(dest).catch(() => null) : dest;
  if (!Array.isArray(explicit) || explicit.length < 2) return null;
  const [ref, kind] = explicit;
  let index: number;
  if (Number.isInteger(ref)) index = ref as number;
  else if (ref && typeof ref === 'object' && Number.isInteger((ref as { num?: unknown }).num) && Number.isInteger((ref as { gen?: unknown }).gen)) {
    index = await doc.getPageIndex(ref as { num: number; gen: number }).catch(() => -1);
  } else return null;
  if (!(index >= 0 && index < doc.numPages)) return null;
  const name = kind && typeof kind === 'object' ? (kind as { name?: unknown }).name : undefined;
  return { page: index + 1, ...destPoint(name, explicit.slice(2)) };
}
