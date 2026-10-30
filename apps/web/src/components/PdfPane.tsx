import { useCallback, useEffect, useImperativeHandle, forwardRef, useRef, useState } from 'react';
import { useShortcutLabel } from '../util/shortcuts';
import { pagesOnScreen, scrollTopForPage, type PdfPagesStore } from '../util/pdfPages';
import { cMapUrl, pdfjs } from '../util/pdfjs';
import { pageLinks, resolveDest, toPage, type DestTarget, type PageBox } from '../util/pdfLinks';
import type { PageViewport } from 'pdfjs-dist';

export interface PdfPaneHandle {
  /** Scroll to a page + PDF-space y and flash a highlight (forward SyncTeX). */
  showForward(page: number, y: number, h?: number): void;
  /** Re-run the fit-to-width layout without changing zoom — the zoom label's
   *  reset is a no-op at 100%, which is exactly where a stale fit hurts. */
  refit(): void;
  /** Scroll so the top of a page (1-based, clamped) is at the top of the pane. */
  goToPage(page: number): void;
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
}

/** A laid-out page: its canvas, CSS pixels per PDF point, and its viewport
 *  at scale 1 (for coordinates in PDF user space). */
type PageInfo = { el: HTMLCanvasElement; scale: number; view: PageViewport };

/** Where a link goes: an address for a new tab, or a page of this PDF and
 *  the point on it, in PDF points from the page's top (null: the page top). */
type LinkTarget = { url: string } | { page: number; y: number | null };

/** How far below the pane's top a link's destination lands, in pixels. */
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

const PdfPane = forwardRef<PdfPaneHandle, Props>(function PdfPane({ pdfUrl, branch, status, zoom = 1, hasErrors = false, stale = false, ready = true, hasTex = true, onFirstOpen, onInverse, pages }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const typesetKeys = useShortcutLabel('typeset');
  const innerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const renderTask = useRef(0);
  const firstOpenFired = useRef(false);
  // per-page viewport info for coordinate mapping
  const pageInfo = useRef<PageInfo[]>([]);
  /** Whether the first click of the current click run landed on a link. */
  const clickOnLink = useRef(false);

  /** Flash a band across a page, `top` and `height` in PDF points. */
  const flash = (info: PageInfo, top: number, height: number) => {
    const el = document.createElement('div');
    el.className = 'pdf-flash';
    el.style.left = `${info.el.offsetLeft}px`;
    el.style.top = `${info.el.offsetTop + top * info.scale}px`;
    el.style.width = `${info.el.clientWidth}px`;
    el.style.height = `${Math.max(16, height * info.scale)}px`;
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
    scroller.scrollTo({ top: info.el.offsetTop + y * info.scale - LINK_MARGIN, behavior: 'smooth' });
    flash(info, y, LINK_FLASH);
  };

  useImperativeHandle(ref, () => ({
    showForward(page, y, h = 12) {
      const info = pageInfo.current[page - 1];
      const scroller = scrollRef.current;
      if (!info || !scroller) return;
      const top = info.el.offsetTop + y * info.scale;
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

  // auto-typeset once when the pane first mounts with no pdf
  useEffect(() => {
    if (!firstOpenFired.current && ready && !pdfUrl && status === 'idle') {
      firstOpenFired.current = true;
      onFirstOpen();
    }
  }, [pdfUrl, status, ready, onFirstOpen]);

  // Zoom clicks arrive in bursts; debounce so three +10% clicks trigger one
  // re-layout instead of three full render passes.
  const [layoutZoom, setLayoutZoom] = useState(zoom);
  useEffect(() => {
    // The click itself must show: stretch the pages already on screen to the
    // new size at once, and let the debounced pass below redraw them sharp.
    const ratio = zoom / layoutZoom;
    for (const { el } of pageInfo.current) {
      const w = Number(el.dataset.w), h = Number(el.dataset.h);
      if (w && h) { el.style.width = `${Math.floor(w * ratio)}px`; el.style.height = `${Math.floor(h * ratio)}px`; }
    }
    measurePage();
    const t = setTimeout(() => setLayoutZoom(zoom), 150);
    return () => clearTimeout(t);
  }, [zoom]);

  // A width change (splitter drag, window resize) must re-run the fit-to-width
  // layout: the render pass below reads scroller.clientWidth once and bakes it
  // into every canvas size, so without tracking it the pages keep their old
  // width and zooming is the only way out. Debounced like zoom bursts — a drag
  // emits a resize event per frame. widthTick is purely the layout trigger;
  // the pass reads the live width itself.
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

  // A branch switch nulls pdfUrl, which alone never touches the canvases —
  // the pane would keep showing the previous branch's pages, and a failed
  // typeset on the new branch would label them as its last successful one.
  useEffect(() => {
    renderTask.current++;
    innerRef.current?.replaceChildren();
    pageInfo.current = [];
    setRendered(false);
    pagesRef.current?.set(null);
  }, [branch]);

  useEffect(() => {
    if (!pdfUrl || !innerRef.current) return;
    const my = ++renderTask.current;
    const container = innerRef.current;
    const scroller = scrollRef.current!;
    const prevScroll = scroller.scrollTop;
    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null;
    let observer: IntersectionObserver | null = null;

    // Virtualized rendering: every page gets a correctly-sized canvas
    // immediately (layout only — getViewport, no rasterization), so scroll
    // geometry, SyncTeX offsets, and test selectors are all valid from the
    // start. Pixels are rasterized only for pages near the viewport; far
    // offscreen pages release their backing store (a 100-page paper would
    // otherwise hold ~660 MB of RGBA at zoom 1, gigabytes when zoomed).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const states = new Map<number, 'blank' | 'rendering' | 'done'>();
    let chain: Promise<void> = Promise.resolve(); // serialize worker renders
    const linked = new Set<number>();
    // Each destination resolves once a pass: one bibliography entry can be
    // cited on every page.
    const dests = new Map<string, Promise<DestTarget | null>>();

    const rasterize = (i: number) => {
      if (states.get(i) === 'rendering' || states.get(i) === 'done') return;
      states.set(i, 'rendering');
      chain = chain.then(async () => {
        if (my !== renderTask.current || !doc) return;
        const info = pageInfo.current[i - 1];
        if (!info) return;
        try {
          const page = await doc.getPage(i);
          if (my !== renderTask.current) return;
          const viewport = page.getViewport({ scale: info.scale });
          const canvas = info.el;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          const cctx = canvas.getContext('2d')!;
          cctx.scale(dpr, dpr);
          await page.render({ canvasContext: cctx, viewport }).promise;
          if (my === renderTask.current) states.set(i, 'done');
        } catch (err) {
          states.set(i, 'blank');
          if ((err as { name?: string })?.name !== 'RenderingCancelledException') console.error('[pdf] page render failed', err);
        }
      });
    };

    // A page's links, laid over it the first time it comes near the viewport;
    // percent boxes keep them on their spots however the page is sized.
    const linkify = (i: number) => {
      if (linked.has(i) || !doc) return;
      linked.add(i);
      const d = doc;
      (async () => {
        try {
          const page = await d.getPage(i);
          const annotations = await page.getAnnotations({ intent: 'display' });
          if (my !== renderTask.current) return;
          const view = pageInfo.current[i - 1]?.view;
          if (!view) return;
          const found = await Promise.all(pageLinks(annotations, view).map(async (link): Promise<[PageBox, LinkTarget] | null> => {
            if ('url' in link) return [link.box, { url: link.url }];
            const key = typeof link.dest === 'string' ? `name:${link.dest}` : JSON.stringify(link.dest);
            let target = dests.get(key);
            if (!target) dests.set(key, (target = resolveDest(d, link.dest)));
            const t = await target;
            const on = t && pageInfo.current[t.page - 1]?.view;
            if (!t || !on) return null;
            return [link.box, { page: t.page, y: t.y == null ? null : Math.max(0, toPage(on, t.x ?? 0, t.y)[1]) }];
          }));
          const host = pageInfo.current[i - 1]?.el.parentElement;
          if (my !== renderTask.current || !host) return;
          const layer = document.createElement('div');
          layer.className = 'pdf-links';
          for (const f of found) if (f) layer.appendChild(linkElement(...f));
          if (layer.childElementCount) host.appendChild(layer);
        } catch (err) {
          if (my === renderTask.current) console.error('[pdf] page links failed', err);
        }
      })();
    };

    const release = (i: number) => {
      if (states.get(i) !== 'done') return;
      const info = pageInfo.current[i - 1];
      if (!info) return;
      // Zero the backing store (frees the bitmap); CSS size stays, so layout,
      // offsets, and visibility checks are untouched.
      info.el.width = 0;
      info.el.height = 0;
      states.set(i, 'blank');
    };

    (async () => {
      try {
        // CJK PDFs embed Identity-H CID fonts; pdf.js needs the packed CMaps
        // to map their glyphs or every CJK character renders as blank space
        // (Latin text and math are unaffected). cMapUrl says where they are
        // served from.
        doc = await pdfjs.getDocument({
          url: pdfUrl,
          cMapUrl,
          cMapPacked: true,
        }).promise;
        if (my !== renderTask.current) { try { doc.destroy(); } catch { /* noop */ } return; }
        const width = Math.max(320, scroller.clientWidth - 36) * layoutZoom;
        const frag = document.createDocumentFragment();
        const info: PageInfo[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (my !== renderTask.current) return;
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.dataset.page = String(i);
          canvas.dataset.w = String(Math.floor(base.width * scale));
          canvas.dataset.h = String(Math.floor(base.height * scale));
          canvas.style.width = `${canvas.dataset.w}px`;
          canvas.style.height = `${canvas.dataset.h}px`;
          canvas.style.background = '#fff';
          // The wrapper stacks the page's link layer on it and stays
          // unpositioned: the canvas's offsets still measure from the pane.
          const wrap = document.createElement('div');
          wrap.className = 'pdf-page-wrap';
          wrap.appendChild(canvas);
          frag.appendChild(wrap);
          info.push({ el: canvas, scale, view: base });
          states.set(i, 'blank');
        }
        if (my !== renderTask.current) return;
        container.replaceChildren(frag);
        pageInfo.current = info;
        scroller.scrollTop = prevScroll;

        // First visible page rasterizes before the spinner goes away — no
        // flash of blank paper on open.
        rasterize(1);
        await chain;
        if (my !== renderTask.current) return;
        setRendered(true);
        measurePage();

        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const i = Number((entry.target as HTMLElement).dataset.page);
            if (!i) continue;
            if (entry.isIntersecting) { rasterize(i); linkify(i); }
            else release(i);
          }
        }, { root: scroller, rootMargin: '150% 0px' });
        for (const { el } of info) observer.observe(el);
      } catch (err) {
        // a superseded render (fast retyping) cancels itself — that's expected, not an error
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') console.error('[pdf] render failed', err);
      }
    })();
    // Invalidate any in-flight render (so its guarded loop bails before touching
    // the DOM/state) and release the pdf.js document — each compile is a unique
    // URL, so without this the worker's document memory accretes every typeset.
    return () => {
      renderTask.current++;
      observer?.disconnect();
      Promise.resolve(doc).then((d) => { try { d?.destroy(); } catch { /* already gone */ } });
    };
  }, [pdfUrl, layoutZoom, widthTick, refitTick, measurePage]);

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
    const x = (e.clientX - rect.left) / info.scale;
    const y = (e.clientY - rect.top) / info.scale;
    onInverse(idx + 1, x, y);
  };

  return (
    <div className="pdf-pane" ref={scrollRef} data-testid="pdf-pane">
      {stale && rendered && (
        <div className="pdf-stale" data-testid="pdf-stale">Preview is from the last successful typeset</div>
      )}
      <div className="pdf-pane__inner" ref={innerRef} onClick={handleClick} onDoubleClick={handleDblClick} title={onInverse ? 'Double-click to jump to source' : undefined} />
      {!rendered && (
        <div className="pdf-empty">
          {status === 'compiling' ? (
            <><span className="spinner" /><p>Typesetting your document…</p></>
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
