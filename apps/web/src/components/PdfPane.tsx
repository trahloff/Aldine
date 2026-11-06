import { useCallback, useEffect, useImperativeHandle, forwardRef, useRef, useState } from 'react';
import { useShortcutLabel } from '../util/shortcuts';
import { pagesAt, pagesOnScreen, scrollTopForPage, scrollToSpot, spotAt, type PageSpot, type PdfPagesStore } from '../util/pdfPages';
import { cMapUrl, pdfjs } from '../util/pdfjs';
import { pageLinks, resolveDest, toPage, type DestTarget, type PageBox } from '../util/pdfLinks';
import { clampZoom, PDF_ZOOM_STEPS, wheelZoom } from '../util/filePreview';
import { outputFileName } from '../util/outputFiles';
import type { PageViewport, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

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
 *  `views` are its pages at scale 1. */
type LoadedPdf = { url: string; pdf: PDFDocumentProxy; views: PageViewport[] };

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
  /** Resolves once every page asked for so far is drawn or has failed. */
  settled(): Promise<void>;
  /** Draws and links pages near the view of `scroller`, and frees far ones. */
  watch(scroller: HTMLElement): void;
  /** Stops drawing and frees the canvases; the layout must be off screen. */
  stop(): void;
}

function createLayout(doc: LoadedPdf, width: number, zoom: number, dests: Map<string, Promise<DestTarget | null>>): Layout {
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

  return {
    pdf,
    zoom,
    info,
    frag,
    draw,
    drawn: (i) => states.get(i) === 'done',
    settled: () => chain,
    watch(scroller) {
      if (!live) return;
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const i = Number((entry.target as HTMLElement).dataset.page);
          if (!i) continue;
          if (entry.isIntersecting) { draw(i); linkify(i); }
          else release(i);
        }
      }, { root: scroller, rootMargin: '150% 0px' });
      for (const { el } of info) observer.observe(el);
    },
    stop() {
      live = false;
      observer?.disconnect();
      for (const task of tasks) task.cancel();
      for (const { el } of info) { el.width = 0; el.height = 0; }
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
  for (const { el } of info) {
    const w = Number(el.dataset.w), h = Number(el.dataset.h);
    if (w && h) { el.style.width = `${Math.floor(w * ratio)}px`; el.style.height = `${Math.floor(h * ratio)}px`; }
  }
}

/** CSS pixels per PDF point of a page as it is sized now, stretched or not. */
const shownScale = (info: PageInfo) => info.el.offsetHeight / info.view.height;

const PdfPane = forwardRef<PdfPaneHandle, Props>(function PdfPane({ pdfUrl, branch, status, zoom = 1, hasErrors = false, stale = false, ready = true, hasTex = true, onFirstOpen, onInverse, pages, onZoom }, ref) {
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

  // auto-typeset once per branch when the pane opens on it with no pdf
  useEffect(() => {
    const on = branch ?? '';
    if (openedFor.current !== on && ready && !pdfUrl && status === 'idle') {
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
        docRef.current = { url: pdfUrl, pdf, views };
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
    const layout = createLayout(doc, width, layoutZoom, map);
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
          for (const i of due) layout.draw(i);
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
  }, [doc, layoutZoom, widthTick, refitTick, measurePage, collect, empty]);

  // Typesetting an unchanged document again keeps its PDF link: the new run
  // is the moment to retry the one that would not open, once a run, so a
  // retry that fails again waits for the next one.
  useEffect(() => {
    if (status !== 'compiling' || !failedUrl) return;
    setFailedUrl(null);
    setLoadTick((n) => n + 1);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // closest() instead of an instanceof check: works whatever element ends up
    // on top (canvas, flash overlay remnants, future wrappers).
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-page]');
    if (!target?.dataset.page) return;
    const idx = Number(target.dataset.page) - 1;
    const info = pageInfo.current[idx];
    if (!info) return;
    const rect = target.getBoundingClientRect();
    const scale = rect.height / info.view.height;
    onInverse(idx + 1, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
  };

  return (
    <div className="pdf-pane" ref={scrollRef} tabIndex={0} role="region" aria-label="Pages of the typeset PDF" data-testid="pdf-pane">
      {stale && rendered && (
        <div className="pdf-stale" data-testid="pdf-stale">Preview is from the last successful typeset</div>
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
          ) : status === 'error' ? (
            // Only blame the document when there are errors to fix — a failed
            // run without parsed errors (missing root, server trouble) isn't
            // the user's LaTeX.
            <p>{hasErrors ? 'Fix the errors on the left, then typeset again.' : 'Typesetting didn’t finish — open the log for details.'}</p>
          ) : ready && !hasTex ? (
            <p data-testid="pdf-empty-no-tex">Create a .tex file to typeset and preview.</p>
          ) : (
            <p>Press <span className="kbd">{typesetKeys}</span> to typeset and preview.</p>
          )}
        </div>
      )}
    </div>
  );
});

export default PdfPane;
