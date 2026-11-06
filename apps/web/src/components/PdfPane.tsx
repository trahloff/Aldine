import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, forwardRef, useRef, useState } from 'react';
import { matchesChord, useShortcutLabel, type Chord } from '../util/shortcuts';
import { pagesAt, pagesOnScreen, scrollTopForPage, scrollToSpot, spotAt, type PageSpot, type PdfPagesStore } from '../util/pdfPages';
import { cMapUrl, pdfjs } from '../util/pdfjs';
import { pageLinks, resolveDest, toPage, type DestTarget, type PageBox } from '../util/pdfLinks';
import { findCount, findMatches, findPattern, pageText, type Match, type PageText } from '../util/pdfFind';
import { bindSelection, markHits, unbindSelection, type TextSpans } from '../util/pdfText';
import { clampZoom, PDF_ZOOM_STEPS, wheelZoom } from '../util/filePreview';
import { outputFileName } from '../util/outputFiles';
import PdfFindBar from './PdfFindBar';
import type { PageViewport, PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

export interface PdfPaneHandle {
  /** Scroll to a page + PDF-space y and flash a highlight (forward SyncTeX). */
  showForward(page: number, y: number, h?: number): void;
  /** Re-run the fit-to-width layout without changing zoom — the zoom label's
   *  reset is a no-op at 100%, which is exactly where a stale fit hurts. */
  refit(): void;
  /** Scroll so the top of a page (1-based, clamped) is at the top of the pane. */
  goToPage(page: number): void;
  /** Inverse SyncTeX for the middle of the view; false while no page shows. */
  sourceAtView(): boolean;
  /** Opens Find over the pages, its field focused. */
  openFind(): void;
}

interface Props {
  pdfUrl: string | null;
  /** The branch whose PDF is shown; a change empties the pane (see below). */
  branch?: string;
  status: 'idle' | 'compiling' | 'ok' | 'error';
  zoom?: number; // multiplier on fit-width (1 = fit width)
  /** Whether the failed compile produced actual parsed errors — gates the "fix the errors" copy. */
  hasErrors?: boolean;
  /** The last run failed: whatever is on screen is from the last successful typeset. */
  stale?: boolean;
  /** What the banner over stale pages says instead of the default. */
  staleNote?: string;
  /** What the pane says, and offers, when a run left no page to show and
   *  there are no errors to point at: a failed request, a stopped run. */
  notice?: { text: string; action?: { label: string; onClick(): void; testId: string } };
  /** onFirstOpen waits for this: the parent knows what the project holds only
   *  after its file listing arrives. */
  ready?: boolean;
  /** No .tex on the branch: the idle copy must not invite a typeset that
   *  would only fail. */
  hasTex?: boolean;
  onFirstOpen(): void;
  /** Inverse SyncTeX: user double-clicked at (page, pdfX, pdfY) in PDF points. */
  onInverse?(page: number, x: number, y: number): void;
  /** Receives the page on screen and the page count; null while no PDF shows. */
  pages?: PdfPagesStore;
  /** A pinch or Ctrl+wheel over the pages asks for this zoom. */
  onZoom?(zoom: number): void;
}

/** A laid-out page: its canvas, CSS pixels per PDF point, and its viewport
 *  at scale 1 (for coordinates in PDF user space). */
type PageInfo = { el: HTMLCanvasElement; scale: number; view: PageViewport };

/** Where a link goes: an address for a new tab, or a page of this PDF and
 *  the point on it, in PDF points from the page's top (null: the page top). */
type LinkTarget = { url: string } | { page: number; y: number | null };

/** How far below the pane's top a link's destination lands, in pixels. Page
 *  offsets measure from the pages' box, which starts below the stale banner
 *  when it shows: a scroll to an offset lands that point the same distance
 *  below the pinned banner, never under it. */
const LINK_MARGIN = 12;
/** The band flashed at a link's destination, in PDF points: hyperref raises
 *  its anchors a line above the target, so two lines cover the heading or
 *  the bibliography entry. */
const LINK_FLASH = 24;

/** A link's element over its page: an anchor for an address, a button for a
 *  place in this PDF. */
function linkElement(box: PageBox, target: LinkTarget): HTMLElement {
  let el: HTMLElement, label: string;
  if ('url' in target) {
    const a = document.createElement('a');
    a.href = target.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    el = a;
    label = target.url;
  } else {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.destPage = String(target.page);
    if (target.y != null) b.dataset.destY = String(target.y);
    el = b;
    label = `Go to page ${target.page}`;
  }
  el.className = 'pdf-link';
  el.dataset.testid = 'pdf-link';
  el.title = label;
  el.setAttribute('aria-label', label);
  el.style.left = `${box.left}%`;
  el.style.top = `${box.top}%`;
  el.style.width = `${box.width}%`;
  el.style.height = `${box.height}%`;
  return el;
}

/** A typeset PDF, held for as long as its link is the one shown: a zoom or a
 *  width change lays it out again without fetching it. /output can't be
 *  cached for this: a halted run rewrites the file behind the link it keeps.
 *  `views` are its pages at scale 1; `texts` their text, read once for the
 *  text layers at every zoom and for Find (`find`, every page). */
type LoadedPdf = {
  url: string;
  pdf: PDFDocumentProxy;
  views: PageViewport[];
  texts: Map<number, Promise<TextContent>>;
  find?: Promise<FindPage[]>;
};

/** A page as Find reads it: its folded text, and its text items for where a
 *  match sits on the page. */
type FindPage = { text: PageText; items: TextItem[] };

/** A match, and where it starts on its page as fractions of the page's box. */
type FoundMatch = Match & { fx: number; fy: number; fh: number };

function textOf(doc: LoadedPdf, page: number): Promise<TextContent> {
  let text = doc.texts.get(page);
  if (!text) {
    text = doc.pdf.getPage(page).then((p) => p.getTextContent());
    doc.texts.set(page, text);
    text.catch(() => { if (doc.texts.get(page) === text) doc.texts.delete(page); });
  }
  return text;
}

// One page after the other: the worker draws pages between them.
function findPages(doc: LoadedPdf): Promise<FindPage[]> {
  doc.find ??= (async () => {
    const pages: FindPage[] = [];
    for (let i = 1; i <= doc.views.length; i++) {
      const items = (await textOf(doc, i)).items.filter((it): it is TextItem => 'str' in it);
      pages.push({ text: pageText(items), items });
    }
    return pages;
  })();
  return doc.find;
}

/** Where each match starts: its first item's baseline origin, moved along
 *  the item to the match, up to the top of the font. */
function locate(matches: Match[], pages: FindPage[], views: PageViewport[]): FoundMatch[] {
  return matches.map((m) => {
    const view = views[m.page - 1];
    const { item, from } = m.ranges[0];
    const it = pages[m.page - 1].items[item];
    const [, , c, d, e, f] = it.transform as number[];
    const size = Math.hypot(c, d) || it.height || 10;
    const x = e + (it.str.length ? (it.width * from) / it.str.length : 0);
    const [x1, y1] = toPage(view, x, f + size);
    const [x2, y2] = toPage(view, x, f);
    return { ...m, fx: Math.min(x1, x2) / view.width, fy: Math.min(y1, y2) / view.height, fh: Math.abs(y2 - y1) / view.height };
  });
}

const FIND_KEYS: Chord = { mod: true, shift: false, alt: false, key: 'f' };
const NEXT_KEYS: Chord = { mod: true, shift: false, alt: false, key: 'g' };
const PREV_KEYS: Chord = { mod: true, shift: true, alt: false, key: 'g' };

/** Pixels past the predicted view that are drawn before a layout shows, for
 *  the padding and banner the prediction leaves out. */
const DRAW_MARGIN = 40;

/** One layout of a document's pages at one size, built off screen: it draws
 *  the pages that will be on screen first, replaces the shown layout, and then
 *  draws pages as they come near the view. */
interface Layout {
  pdf: PDFDocumentProxy;
  /** The zoom it was laid out at. */
  zoom: number;
  info: PageInfo[];
  frag: DocumentFragment;
  draw(i: number): void;
  drawn(i: number): boolean;
  /** Lays a page's text layer over it. */
  text(i: number): void;
  /** The pages whose text layer is drawn, by page. */
  spans: ReadonlyMap<number, TextSpans>;
  /** Resolves once every page and text layer asked for so far is drawn or has failed. */
  settled(): Promise<void>;
  /** Draws, links and lays text over pages near the view of `scroller`, and frees far ones. */
  watch(scroller: HTMLElement): void;
  /** Stops drawing and frees the canvases; the layout must be off screen. */
  stop(): void;
}

/** CSS pixels per PDF point of a page as its canvas is sized, also off
 *  screen: the text layer places its spans from it. */
const textScale = (page: PageInfo) => page.scale * ((parseFloat(page.el.style.height) / Number(page.el.dataset.h)) || 1);

function createLayout(
  doc: LoadedPdf, width: number, zoom: number, dests: Map<string, Promise<DestTarget | null>>,
  onText: (page: number, spans: TextSpans, pdf: PDFDocumentProxy) => void,
): Layout {
  const { pdf } = doc;
  // Virtualized rendering: every page gets a correctly-sized canvas
  // immediately (layout only, no rasterization), so scroll geometry, SyncTeX
  // offsets, and test selectors are all valid from the start. Pixels are
  // rasterized only for pages near the viewport; far offscreen pages release
  // their backing store (a 100-page paper would otherwise hold ~660 MB of
  // RGBA at zoom 1, gigabytes when zoomed).
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const states = new Map<number, 'blank' | 'rendering' | 'done'>();
  const tasks = new Set<RenderTask>();
  const linked = new Set<number>();
  let chain: Promise<void> = Promise.resolve(); // serialize worker renders
  let live = true;
  let observer: IntersectionObserver | null = null;

  const frag = document.createDocumentFragment();
  const info: PageInfo[] = doc.views.map((view, k) => {
    const scale = width / view.width;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.dataset.page = String(k + 1);
    canvas.dataset.w = String(Math.floor(view.width * scale));
    canvas.dataset.h = String(Math.floor(view.height * scale));
    canvas.style.width = `${canvas.dataset.w}px`;
    canvas.style.height = `${canvas.dataset.h}px`;
    canvas.style.background = '#fff';
    // The wrapper stacks the page's link layer on it and stays
    // unpositioned: the canvas's offsets still measure from the pages' box.
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.appendChild(canvas);
    frag.appendChild(wrap);
    states.set(k + 1, 'blank');
    return { el: canvas, scale, view };
  });

  const draw = (i: number) => {
    const state = states.get(i);
    if (!state || state === 'rendering' || state === 'done') return;
    states.set(i, 'rendering');
    chain = chain.then(async () => {
      const page = info[i - 1];
      try {
        if (!live) return;
        const proxy = await pdf.getPage(i);
        if (!live) return;
        const viewport = proxy.getViewport({ scale: page.scale });
        const canvas = page.el;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        const cctx = canvas.getContext('2d')!;
        cctx.scale(dpr, dpr);
        const task = proxy.render({ canvasContext: cctx, viewport });
        tasks.add(task);
        try { await task.promise; } finally { tasks.delete(task); }
        if (live) states.set(i, 'done');
      } catch (err) {
        if (live && (err as { name?: string })?.name !== 'RenderingCancelledException') console.error('[pdf] page render failed', err);
      } finally {
        if (states.get(i) === 'rendering') states.set(i, 'blank');
      }
    });
  };

  // A page's links, laid over it the first time it comes near the viewport;
  // percent boxes keep them on their spots however the page is sized.
  const linkify = (i: number) => {
    if (linked.has(i)) return;
    linked.add(i);
    (async () => {
      try {
        const page = await pdf.getPage(i);
        const annotations = await page.getAnnotations({ intent: 'display' });
        if (!live) return;
        const view = info[i - 1]?.view;
        if (!view) return;
        const found = await Promise.all(pageLinks(annotations, view).map(async (link): Promise<[PageBox, LinkTarget] | null> => {
          if ('url' in link) return [link.box, { url: link.url }];
          const key = typeof link.dest === 'string' ? `name:${link.dest}` : JSON.stringify(link.dest);
          let target = dests.get(key);
          if (!target) dests.set(key, (target = resolveDest(pdf, link.dest)));
          const t = await target;
          const on = t && info[t.page - 1]?.view;
          if (!t || !on) return null;
          return [link.box, { page: t.page, y: t.y == null ? null : Math.max(0, toPage(on, t.x ?? 0, t.y)[1]) }];
        }));
        const host = info[i - 1]?.el.parentElement;
        if (!live || !host) return;
        const layer = document.createElement('div');
        layer.className = 'pdf-links';
        for (const f of found) if (f) layer.appendChild(linkElement(...f));
        if (layer.childElementCount) host.appendChild(layer);
      } catch (err) {
        if (live) console.error('[pdf] page links failed', err);
      }
    })();
  };

  const release = (i: number) => {
    if (states.get(i) !== 'done') return;
    // Zero the backing store (frees the bitmap); CSS size stays, so layout,
    // offsets, and visibility checks are untouched.
    const { el } = info[i - 1];
    el.width = 0;
    el.height = 0;
    states.set(i, 'blank');
  };

  // A page's text layer: pdf.js's transparent spans over its glyphs, for
  // selecting, copying and Find. It sits between the page and its links, so
  // the links stay on top, in a box of the page's size: the layer's own box
  // is the unrotated page, which would otherwise widen the page's cell.
  const texts = new Map<number, { box: HTMLElement; div: HTMLElement; layer: TextLayer | null }>();
  const spans = new Map<number, TextSpans>();
  const textJobs = new Set<Promise<void>>();
  const text = (i: number) => {
    const page = info[i - 1];
    if (!page || texts.has(i) || !live) return;
    const box = document.createElement('div');
    box.className = 'pdf-text-box';
    const div = document.createElement('div');
    div.className = 'pdf-text';
    div.dataset.testid = 'pdf-text';
    box.appendChild(div);
    page.el.after(box);
    const entry = { box, div, layer: null as TextLayer | null };
    texts.set(i, entry);
    const job = (async () => {
      try {
        const content = await textOf(doc, i);
        if (!live || texts.get(i) !== entry) return;
        div.style.setProperty('--scale-factor', String(textScale(page)));
        const layer = new pdfjs.TextLayer({ textContentSource: content, container: div, viewport: page.view.clone({ scale: page.scale }) });
        entry.layer = layer;
        await layer.render();
        if (!live || texts.get(i) !== entry) return;
        bindSelection(div);
        const s: TextSpans = { divs: layer.textDivs, strs: layer.textContentItemsStr, marked: new Set() };
        spans.set(i, s);
        onText(i, s, pdf);
      } catch (err) {
        if (live && texts.get(i) === entry && (err as { name?: string })?.name !== 'AbortException') console.error('[pdf] page text failed', err);
      }
    })();
    textJobs.add(job);
    void job.then(() => textJobs.delete(job));
  };

  const untext = (i: number) => {
    const entry = texts.get(i);
    if (!entry) return;
    // Freeing the text under a selection would drop the selection.
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.containsNode(entry.box, true)) return;
    entry.layer?.cancel();
    unbindSelection(entry.div);
    entry.box.remove();
    texts.delete(i);
    spans.delete(i);
  };

  return {
    pdf,
    zoom,
    info,
    frag,
    draw,
    drawn: (i) => states.get(i) === 'done',
    text,
    spans,
    settled: () => Promise.all([chain, ...textJobs]).then(() => undefined),
    watch(scroller) {
      if (!live) return;
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const i = Number((entry.target as HTMLElement).dataset.page);
          if (!i) continue;
          if (entry.isIntersecting) { draw(i); linkify(i); text(i); }
          else { release(i); untext(i); }
        }
      }, { root: scroller, rootMargin: '150% 0px' });
      for (const { el } of info) observer.observe(el);
    },
    stop() {
      live = false;
      observer?.disconnect();
      for (const task of tasks) task.cancel();
      for (const { el } of info) { el.width = 0; el.height = 0; }
      for (const { div, layer } of texts.values()) { layer?.cancel(); unbindSelection(div); }
    },
  };
}

/** The pages' boxes on screen, read one at a time. */
const rectOf = (info: PageInfo[]) => (i: number) => info[i].el.getBoundingClientRect();

/** The middle of the pane's view, in client pixels. */
function viewMiddle(scroller: HTMLElement): { x: number; y: number } {
  const r = scroller.getBoundingClientRect();
  return { x: r.left + scroller.clientWidth / 2, y: r.top + scroller.clientHeight / 2 };
}

/** Scroll so `spot` is at (x, y) again. */
function scrollBackTo(scroller: HTMLElement, info: PageInfo[], spot: PageSpot, x: number, y: number) {
  if (!info.length) return;
  const by = scrollToSpot(info.length, rectOf(info), spot, x, y);
  scroller.scrollLeft += by.left;
  scroller.scrollTop += by.top;
}

/** Size the pages `ratio` times their laid-out size: the zoom shows at once,
 *  and the next layout draws them sharp. */
function stretch(info: PageInfo[], ratio: number) {
  for (const page of info) {
    const { el } = page;
    const w = Number(el.dataset.w), h = Number(el.dataset.h);
    if (w && h) { el.style.width = `${Math.floor(w * ratio)}px`; el.style.height = `${Math.floor(h * ratio)}px`; }
    el.parentElement?.querySelector<HTMLElement>('.pdf-text')?.style.setProperty('--scale-factor', String(textScale(page)));
  }
}

/** CSS pixels per PDF point of a page as it is sized now, stretched or not. */
const shownScale = (info: PageInfo) => info.el.offsetHeight / info.view.height;

const PdfPane = forwardRef<PdfPaneHandle, Props>(function PdfPane({ pdfUrl, branch, status, zoom = 1, hasErrors = false, stale = false, staleNote, notice, ready = true, hasTex = true, onFirstOpen, onInverse, pages, onZoom }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const typesetKeys = useShortcutLabel('typeset');
  const innerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  /** The PDF link pdf.js could not open; the pane offers it as a download. */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  /** Bumped by each layout and by anything that empties the pane: a layout
   *  that is no longer the latest never replaces the pages on screen. */
  const renderTask = useRef(0);
  /** The latest PDF loaded for pdfUrl; it is laid out at every zoom and width. */
  const [doc, setDoc] = useState<LoadedPdf | null>(null);
  const docRef = useRef<LoadedPdf | null>(null);
  /** The layout on screen. Its document stays open until another one's pages
   *  replace it, also while pdfUrl is null after a run that left no PDF. */
  const shown = useRef<Layout | null>(null);
  /** Every document opened and not yet destroyed. */
  const docs = useRef(new Set<PDFDocumentProxy>());
  /** Bumped when the pane empties, so a load started before is dropped. */
  const loads = useRef(0);
  const [loadTick, setLoadTick] = useState(0);
  // Each destination resolves once a document: one bibliography entry can be
  // cited on every page.
  const dests = useRef(new WeakMap<PDFDocumentProxy, Map<string, Promise<DestTarget | null>>>());
  /** The branch the on-open typeset was last asked for: a branch switch opens
   *  the other branch the way opening the project does. */
  const openedFor = useRef<string | null>(null);
  const onInverseRef = useRef(onInverse);
  onInverseRef.current = onInverse;
  // per-page viewport info for coordinate mapping
  const pageInfo = useRef<PageInfo[]>([]);
  /** Whether the first click of the current click run landed on a link. */
  const clickOnLink = useRef(false);

  /** Find: whether its bar is open, what it holds, the matches in a
   *  document, and the one it is on. */
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ doc: LoadedPdf; query: string; list: FoundMatch[] } | null>(null);
  const [current, setCurrent] = useState(-1);
  const findInput = useRef<HTMLInputElement>(null);
  const findBar = useRef<HTMLDivElement>(null);
  /** The query the matches on hand were found for; null after a close, so
   *  that the next search starts from the view again. */
  const foundQuery = useRef<string | null>(null);
  /** What the text layers mark, read by each one as it is drawn. */
  const marks = useRef<{ pdf: PDFDocumentProxy; list: FoundMatch[]; byPage: Map<number, number[]>; current: number } | null>(null);
  const markPage = useCallback((page: number, spans: TextSpans, pdf: PDFDocumentProxy) => {
    const m = marks.current;
    const on = m && m.pdf === pdf ? m.byPage.get(page) ?? [] : [];
    markHits(spans, on.map((k) => ({ ranges: m!.list[k].ranges, current: k === m!.current })));
  }, []);

  /** Flash a band across a page, `top` and `height` in PDF points. */
  const flash = (info: PageInfo, top: number, height: number) => {
    const el = document.createElement('div');
    const scale = shownScale(info);
    el.className = 'pdf-flash';
    el.style.left = `${info.el.offsetLeft}px`;
    el.style.top = `${info.el.offsetTop + top * scale}px`;
    el.style.width = `${info.el.clientWidth}px`;
    el.style.height = `${Math.max(16, height * scale)}px`;
    innerRef.current?.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  };

  /** An internal link: its destination near the top of the pane, flashed. */
  const followLink = (page: number, y: number | null) => {
    const all = pageInfo.current;
    const info = all[page - 1];
    const scroller = scrollRef.current;
    if (!info || !scroller) return;
    if (y == null) {
      scroller.scrollTo({ top: scrollTopForPage(info.el, all[page - 2]?.el), behavior: 'smooth' });
      return;
    }
    scroller.scrollTo({ top: info.el.offsetTop + y * shownScale(info) - LINK_MARGIN, behavior: 'smooth' });
    flash(info, y, LINK_FLASH);
  };

  useImperativeHandle(ref, () => ({
    showForward(page, y, h = 12) {
      const info = pageInfo.current[page - 1];
      const scroller = scrollRef.current;
      if (!info || !scroller) return;
      const top = info.el.offsetTop + y * shownScale(info);
      scroller.scrollTo({ top: top - scroller.clientHeight / 3, behavior: 'smooth' });
      flash(info, y - h, h * 2);
    },
    refit() {
      setRefitTick((n) => n + 1);
    },
    goToPage(page) {
      const info = pageInfo.current;
      const scroller = scrollRef.current;
      if (!info.length || !scroller) return;
      const i = Math.min(Math.max(1, Math.round(page)), info.length) - 1;
      scroller.scrollTo({ top: scrollTopForPage(info[i].el, info[i - 1]?.el) });
    },
    sourceAtView() {
      const info = pageInfo.current;
      const scroller = scrollRef.current;
      const inverse = onInverseRef.current;
      if (!info.length || !scroller || !inverse) return false;
      const view = scroller.getBoundingClientRect();
      const x = view.left + scroller.clientWidth / 2, y = view.top + scroller.clientHeight / 2;
      // The page under the middle of the view, or the nearest one when the
      // middle falls in the gap between two.
      let best = 0, bestRect = info[0].el.getBoundingClientRect(), bestDist = Infinity;
      for (let i = 0; i < info.length; i++) {
        const r = i === 0 ? bestRect : info[i].el.getBoundingClientRect();
        const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (dist < bestDist) { best = i; bestRect = r; bestDist = dist; }
        if (r.bottom >= y) break;
      }
      const { view: pageView } = info[best];
      // The canvas's drawn size, not the laid-out scale: a zoom stretches the
      // pages at once and lays them out again only once it settles.
      const px = Math.min(Math.max(x, bestRect.left), bestRect.right) - bestRect.left;
      const py = Math.min(Math.max(y, bestRect.top), bestRect.bottom) - bestRect.top;
      inverse(best + 1, (px / bestRect.width) * pageView.width, (py / bestRect.height) * pageView.height);
      return true;
    },
    openFind() {
      openFindRef.current();
    },
  }), []);

  // The page on screen, for the page field in the preview's header. Measured
  // at most once a frame while scrolling, and only around the viewport.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const measureFrame = useRef(0);
  const measurePage = useCallback(() => {
    if (measureFrame.current) return;
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = 0;
      const store = pagesRef.current, scroller = scrollRef.current;
      if (!store || !scroller) return;
      const info = pageInfo.current;
      store.set(pagesOnScreen(scroller, info.length, (i) => info[i].el));
    });
  }, []);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener('scroll', measurePage, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', measurePage);
      cancelAnimationFrame(measureFrame.current);
      measureFrame.current = 0;
      pagesRef.current?.set(null);
    };
  }, [measurePage]);

  // auto-typeset once per branch when the pane opens on it, unless a typeset
  // has already started; the branch's last PDF may be on screen already
  useEffect(() => {
    const on = branch ?? '';
    if (openedFor.current !== on && ready && status === 'idle') {
      openedFor.current = on;
      onFirstOpen();
    }
  }, [pdfUrl, status, ready, onFirstOpen, branch]);

  // A pinch or Ctrl+wheel over the pages zooms them, not the whole app: the
  // listener is not passive, so that it can keep the browser from zooming.
  // Each event chains on the zoom the one before asked for, since a pinch
  // sends several a frame.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  /** Where the pinch or wheel was, in client pixels: that spot of the page
   *  stays under the pointer. */
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const zoomTo = (next: number, x: number, y: number) => {
      if (!onZoomRef.current || next === zoomRef.current) return;
      zoomRef.current = next;
      zoomAnchor.current = { x, y };
      onZoomRef.current(next);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(wheelZoom(zoomRef.current, e, PDF_ZOOM_STEPS), e.clientX, e.clientY);
    };
    // Safari reports a pinch as gesture events, each with the scale since the
    // gesture began.
    let start = 1;
    const onGesture = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      if (e.type === 'gesturestart') start = zoomRef.current;
      else if (e.type === 'gesturechange') zoomTo(clampZoom(start * g.scale, PDF_ZOOM_STEPS), g.clientX, g.clientY);
    };
    const gestures = ['gesturestart', 'gesturechange', 'gestureend'];
    el.addEventListener('wheel', onWheel, { passive: false });
    for (const t of gestures) el.addEventListener(t, onGesture);
    return () => {
      el.removeEventListener('wheel', onWheel);
      for (const t of gestures) el.removeEventListener(t, onGesture);
    };
  }, []);

  // Zoom clicks arrive in bursts; debounce so three clicks trigger one
  // re-layout instead of three full render passes.
  const [layoutZoom, setLayoutZoom] = useState(zoom);
  useEffect(() => {
    const scroller = scrollRef.current;
    const layout = shown.current;
    // A zoom from the buttons or keys holds the middle of the view in place.
    const at = zoomAnchor.current ?? (scroller && viewMiddle(scroller));
    zoomAnchor.current = null;
    if (scroller && layout && at) {
      const spot = spotAt(layout.info.length, rectOf(layout.info), at.x, at.y);
      // The click itself must show: stretch the pages already on screen to
      // the new size at once, and let the debounced layout redraw them sharp.
      stretch(layout.info, zoom / layout.zoom);
      if (spot) scrollBackTo(scroller, layout.info, spot, at.x, at.y);
    }
    measurePage();
    const t = setTimeout(() => setLayoutZoom(zoom), 150);
    return () => clearTimeout(t);
  }, [zoom]);

  // A width change (splitter drag, window resize) must re-run the fit-to-width
  // layout: the layout below reads scroller.clientWidth once and bakes it
  // into every canvas size, so without tracking it the pages keep their old
  // width and zooming is the only way out. Debounced like zoom bursts — a drag
  // emits a resize event per frame. widthTick is purely the layout trigger;
  // the layout reads the live width itself.
  const [widthTick, setWidthTick] = useState(0);
  const [refitTick, setRefitTick] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      measurePage(); // a taller or shorter pane can put another page on screen
      clearTimeout(t);
      t = setTimeout(() => {
        if (el.clientWidth !== last) { last = el.clientWidth; setWidthTick((n) => n + 1); }
      }, 150);
    });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, []);

  /** Destroy every document that is neither the latest loaded nor on screen. */
  const collect = useCallback(() => {
    for (const pdf of docs.current) {
      if (pdf === docRef.current?.pdf || pdf === shown.current?.pdf) continue;
      docs.current.delete(pdf);
      void pdf.destroy().catch(() => { /* already gone */ });
    }
  }, []);

  /** Take the pages off screen and let go of their documents. */
  const empty = useCallback(() => {
    renderTask.current++;
    loads.current++;
    innerRef.current?.replaceChildren();
    pageInfo.current = [];
    shown.current?.stop();
    shown.current = null;
    docRef.current = null;
    setDoc(null);
    collect();
    setRendered(false);
    pagesRef.current?.set(null);
  }, [collect]);

  // A branch switch nulls pdfUrl, which alone never touches the canvases —
  // the pane would keep showing the previous branch's pages, and a failed
  // typeset on the new branch would label them as its last successful one.
  useEffect(() => {
    empty();
    setFailedUrl(null);
  }, [branch, empty]);

  useEffect(() => () => {
    renderTask.current++;
    shown.current?.stop();
    shown.current = null;
    docRef.current = null;
    collect();
  }, [collect]);

  // One document per link. A null pdfUrl (a run that left no PDF) keeps the
  // one on screen, and the same link again (an unchanged document) is the
  // document already open.
  useEffect(() => {
    if (!pdfUrl || docRef.current?.url === pdfUrl) return;
    const gen = loads.current;
    let live = true, kept = false;
    // CJK PDFs embed Identity-H CID fonts; pdf.js needs the packed CMaps to
    // map their glyphs or every CJK character renders as blank space (Latin
    // text and math are unaffected). cMapUrl says where they are served from.
    const task = pdfjs.getDocument({ url: pdfUrl, cMapUrl, cMapPacked: true });
    (async () => {
      try {
        const pdf = await task.promise;
        const views: PageViewport[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          views.push((await pdf.getPage(i)).getViewport({ scale: 1 }));
          if (!live || gen !== loads.current) return;
        }
        if (!live || gen !== loads.current) return;
        kept = true;
        docs.current.add(pdf);
        docRef.current = { url: pdfUrl, pdf, views, texts: new Map() };
        setDoc(docRef.current);
        collect();
      } catch (err) {
        if (!live || gen !== loads.current) return;
        console.error('[pdf] render failed', err);
        empty();
        setFailedUrl(pdfUrl);
      }
    })();
    return () => {
      live = false;
      if (!kept) void task.destroy();
    };
  }, [pdfUrl, loadTick, collect, empty]);

  // Each layout draws the pages it will put on screen before they replace
  // the ones there, and holds the spot in the middle of the view: a zoom, a
  // width change and a new typeset all keep the page being read, drawn.
  useEffect(() => {
    const container = innerRef.current, scroller = scrollRef.current;
    if (!doc || !container || !scroller) return;
    const my = ++renderTask.current;
    // A newer document, or an emptied pane, supersedes this layout.
    const current = () => my === renderTask.current && docRef.current === doc;
    let map = dests.current.get(doc.pdf);
    if (!map) dests.current.set(doc.pdf, (map = new Map()));
    const width = Math.max(320, scroller.clientWidth - 36) * layoutZoom;
    const layout = createLayout(doc, width, layoutZoom, map, markPage);
    const spotNow = () => {
      const on = shown.current;
      const at = viewMiddle(scroller);
      return { at, spot: on ? spotAt(on.info.length, rectOf(on.info), at.x, at.y) : null };
    };
    (async () => {
      try {
        // A zoom asked for after this layout started shows as a stretch.
        const ratio = () => zoomRef.current / layoutZoom;
        const gap = parseFloat(getComputedStyle(container).rowGap) || 0;
        // The view can move while pages draw: whatever came on screen meanwhile
        // is drawn too, a few rounds at most.
        for (let round = 0; round < 3; round++) {
          const { spot } = spotNow();
          const heights = layout.info.map(({ el }) => Number(el.dataset.h) * ratio());
          const due = pagesAt(heights, gap, spot, scroller.clientHeight / 2, scroller.clientHeight, DRAW_MARGIN)
            .map((i) => i + 1).filter((i) => !layout.drawn(i));
          if (!due.length) break;
          for (const i of due) { layout.draw(i); layout.text(i); }
          await layout.settled();
          if (!current()) return;
        }
        if (!current()) return;
        const { at, spot } = spotNow();
        const prev = shown.current;
        container.replaceChildren(layout.frag);
        pageInfo.current = layout.info;
        if (ratio() !== 1) stretch(layout.info, ratio());
        if (spot) scrollBackTo(scroller, layout.info, spot, at.x, at.y);
        shown.current = layout;
        prev?.stop();
        collect();
        // Find's matches can have arrived while the layout drew its text.
        for (const [i, s] of layout.spans) markPage(i, s, layout.pdf);
        setRendered(true);
        measurePage();
        layout.watch(scroller);
      } catch (err) {
        if (!current()) return;
        console.error('[pdf] render failed', err);
        empty();
        setFailedUrl(doc.url);
      }
    })();
    return () => { if (shown.current !== layout) layout.stop(); };
  }, [doc, layoutZoom, widthTick, refitTick, measurePage, collect, empty, markPage]);

  // Typesetting an unchanged document again keeps its PDF link: the new run
  // is the moment to retry the one that would not open, once a run, so a
  // retry that fails again waits for the next one.
  useEffect(() => {
    if (status !== 'compiling' || !failedUrl) return;
    setFailedUrl(null);
    setLoadTick((n) => n + 1);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find reads the document on screen while its bar is open.
  useEffect(() => {
    if (!findOpen || !doc) { setFound(null); return; }
    if (!findPattern(query)) { setFound({ doc, query, list: [] }); return; }
    let live = true;
    findPages(doc)
      .then((pages) => { if (live) setFound({ doc, query, list: locate(findMatches(pages.map((p) => p.text), query), pages, doc.views) }); })
      .catch((err) => {
        if (!live) return;
        console.error('[pdf] find failed', err);
        setFound({ doc, query, list: [] });
      });
    return () => { live = false; };
  }, [findOpen, doc, query]);

  /** The first match at or below the top of the view, else the first of all. */
  const firstFromView = (list: FoundMatch[]) => {
    if (!list.length) return -1;
    const info = pageInfo.current, scroller = scrollRef.current;
    if (!info.length || !scroller) return 0;
    const view = scroller.getBoundingClientRect();
    const spot = spotAt(info.length, rectOf(info), view.left, view.top);
    const k = spot ? list.findIndex((m) => m.page - 1 > spot.page || (m.page - 1 === spot.page && m.fy >= spot.fy)) : 0;
    return Math.max(0, k);
  };

  /** Scrolls a match into the view, clear of the banner and the find bar,
   *  unless it is in view already. */
  const reveal = (m: FoundMatch) => {
    const info = pageInfo.current[m.page - 1], scroller = scrollRef.current;
    if (!info || !scroller) return;
    const page = info.el.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    const top = page.top + m.fy * page.height, bottom = top + Math.max(m.fh * page.height, 12), left = page.left + m.fx * page.width;
    const banner = scroller.querySelector('.pdf-stale')?.getBoundingClientRect().bottom ?? 0;
    const clear = Math.max(view.top, banner, findBar.current?.getBoundingClientRect().bottom ?? 0) + 8;
    if (top < clear || bottom > view.top + scroller.clientHeight - 8) scroller.scrollTop += top - (view.top + scroller.clientHeight / 3);
    if (left < view.left + 8 || left > view.left + scroller.clientWidth - 48) scroller.scrollLeft += left - (view.left + scroller.clientWidth / 3);
  };

  // A new query goes to its first match from the top of the view; the same
  // query over a new typeset stays on the match it was on.
  useEffect(() => {
    if (!found) return;
    const { list } = found;
    if (foundQuery.current === found.query) {
      setCurrent((c) => (list.length ? Math.min(Math.max(c, 0), list.length - 1) : -1));
      return;
    }
    foundQuery.current = found.query;
    const k = firstFromView(list);
    setCurrent(k);
    if (k >= 0) reveal(list[k]);
  }, [found]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (findOpen && found) {
      const byPage = new Map<number, number[]>();
      found.list.forEach((m, k) => {
        let on = byPage.get(m.page);
        if (!on) byPage.set(m.page, (on = []));
        on.push(k);
      });
      marks.current = { pdf: found.doc.pdf, list: found.list, byPage, current };
    } else {
      marks.current = null;
    }
    const layout = shown.current;
    if (layout) for (const [i, s] of layout.spans) markPage(i, s, layout.pdf);
  }, [findOpen, found, current, markPage]);

  const step = (dir: 1 | -1) => {
    const list = found?.list;
    if (!list?.length) return;
    const k = current < 0 ? (dir > 0 ? 0 : list.length - 1) : (current + dir + list.length) % list.length;
    setCurrent(k);
    reveal(list[k]);
  };

  const openFind = () => {
    // Text selected on one line of the PDF is what to look for, as in a browser.
    const sel = document.getSelection();
    const picked = sel && !sel.isCollapsed && innerRef.current?.contains(sel.anchorNode) ? sel.toString().trim() : '';
    if (picked && !picked.includes('\n') && picked.length <= 200) setQuery(picked);
    setFindOpen(true);
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;

  const closeFind = () => {
    setFindOpen(false);
    foundQuery.current = null;
    scrollRef.current?.focus({ preventScroll: true });
  };

  // The editor keeps its own Find: these keys are the PDF's only while the
  // focus is in the preview.
  const onFindKeys = (e: React.KeyboardEvent) => {
    if (matchesChord(e.nativeEvent, FIND_KEYS)) {
      e.preventDefault();
      openFind();
    } else if (findOpen && (matchesChord(e.nativeEvent, NEXT_KEYS) || matchesChord(e.nativeEvent, PREV_KEYS))) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  // Only the text goes to the clipboard: a rich copy would paste the text
  // layer's transparent spans.
  const copyText = (e: React.ClipboardEvent) => {
    const sel = document.getSelection(), inner = innerRef.current;
    if (!sel || sel.isCollapsed || !inner?.contains(sel.anchorNode) || !inner.contains(sel.focusNode)) return;
    e.clipboardData.setData('text/plain', sel.toString().replace(/\0/g, ''));
    e.preventDefault();
  };

  // The bar sits below the banner over stale pages.
  const [barTop, setBarTop] = useState(8);
  useLayoutEffect(() => {
    if (!findOpen) return;
    setBarTop((scrollRef.current?.querySelector<HTMLElement>('.pdf-stale')?.offsetHeight ?? 0) + 8);
  }, [findOpen, stale, rendered, staleNote]);

  // A single click follows a link; the rest of a double-click on one does
  // nothing. Its second click would open a second tab, and after an internal
  // link has scrolled, the double-click lands on whatever moved under the
  // pointer, so it is no jump to source either.
  const handleClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('.pdf-link');
    if (e.detail <= 1) clickOnLink.current = !!link;
    if (!link) return;
    if (e.detail > 1) { e.preventDefault(); return; }
    if (link instanceof HTMLAnchorElement) return; // the browser opens it in a new tab
    const page = Number(link.dataset.destPage);
    if (page) followLink(page, link.dataset.destY ? Number(link.dataset.destY) : null);
  };

  const handleDblClick = (e: React.MouseEvent) => {
    if (!onInverse || clickOnLink.current) return;
    // The page under whatever is on top of it: its text layer, a flash.
    const hit = e.target as HTMLElement;
    const target = hit.closest('.pdf-page-wrap')?.querySelector<HTMLElement>('canvas[data-page]') ?? hit.closest<HTMLElement>('[data-page]');
    if (!target?.dataset.page) return;
    const idx = Number(target.dataset.page) - 1;
    const info = pageInfo.current[idx];
    if (!info) return;
    const rect = target.getBoundingClientRect();
    const scale = rect.height / info.view.height;
    onInverse(idx + 1, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
  };

  return (
    <div className="pdf-view" onKeyDown={onFindKeys} onCopy={copyText}>
      <div className="pdf-pane" ref={scrollRef} tabIndex={0} role="region" aria-label="Pages of the typeset PDF" data-testid="pdf-pane">
        {stale && rendered && (
          <div className="pdf-stale" data-testid="pdf-stale">{staleNote ?? 'Preview is from the last successful typeset'}</div>
        )}
        <div className="pdf-pane__inner" ref={innerRef} onClick={handleClick} onDoubleClick={handleDblClick} title={onInverse ? 'Double-click to jump to source' : undefined} />
        {!rendered && (
          <div className="pdf-empty">
            {status === 'compiling' ? (
              <><span className="spinner" /><p>Typesetting your document…</p></>
            ) : pdfUrl && failedUrl === pdfUrl ? (
              <>
                <p data-testid="pdf-load-error">Could not open the typeset PDF. Download it to open it in another app, or typeset again.</p>
                <a className="btn" href={pdfUrl} download={outputFileName(pdfUrl) ?? true} data-testid="pdf-load-error-download">Download the PDF</a>
              </>
            ) : pdfUrl ? (
              <><span className="spinner" /><p>Opening the PDF…</p></>
            ) : status === 'error' ? (
              // Only blame the document when there are errors to fix — a failed
              // run without parsed errors (missing root, server trouble) isn't
              // the user's LaTeX.
              notice && !hasErrors ? (
                <>
                  <p data-testid="pdf-notice">{notice.text}</p>
                  {notice.action && <button className="btn" onClick={notice.action.onClick} data-testid={notice.action.testId}>{notice.action.label}</button>}
                </>
              ) : <p>{hasErrors ? 'Fix the errors on the left, then typeset again.' : 'Typesetting didn’t finish — open the log for details.'}</p>
            ) : ready && !hasTex ? (
              <p data-testid="pdf-empty-no-tex">Create a .tex file to typeset and preview.</p>
            ) : (
              <p>Press <span className="kbd">{typesetKeys}</span> to typeset and preview.</p>
            )}
          </div>
        )}
      </div>
      {findOpen && (
        <PdfFindBar
          query={query}
          onQuery={setQuery}
          count={findCount(query, found ? found.list.length : doc ? null : 0, current)}
          canStep={!!found?.list.length}
          onStep={step}
          onClose={closeFind}
          inputRef={findInput}
          barRef={findBar}
          style={{ top: barTop }}
        />
      )}
    </div>
  );
});

export default PdfPane;
