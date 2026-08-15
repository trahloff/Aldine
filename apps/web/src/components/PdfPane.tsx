import { useEffect, useImperativeHandle, forwardRef, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { shortcut } from '../platform';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export interface PdfPaneHandle {
  /** Scroll to a page + PDF-space y and flash a highlight (forward SyncTeX). */
  showForward(page: number, y: number, h?: number): void;
}

interface Props {
  pdfUrl: string | null;
  status: 'idle' | 'compiling' | 'ok' | 'error';
  zoom?: number; // multiplier on fit-width (1 = fit width)
  /** Whether the failed compile produced actual parsed errors — gates the "fix the errors" copy. */
  hasErrors?: boolean;
  onFirstOpen(): void;
  /** Inverse SyncTeX: user double-clicked at (page, pdfX, pdfY) in PDF points. */
  onInverse?(page: number, x: number, y: number): void;
}

const PdfPane = forwardRef<PdfPaneHandle, Props>(function PdfPane({ pdfUrl, status, zoom = 1, hasErrors = false, onFirstOpen, onInverse }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const renderTask = useRef(0);
  const firstOpenFired = useRef(false);
  // per-page viewport info for coordinate mapping
  const pageInfo = useRef<Array<{ el: HTMLCanvasElement; scale: number; height: number }>>([]);

  useImperativeHandle(ref, () => ({
    showForward(page, y, h = 12) {
      const info = pageInfo.current[page - 1];
      const scroller = scrollRef.current;
      if (!info || !scroller) return;
      const top = info.el.offsetTop + y * info.scale;
      scroller.scrollTo({ top: top - scroller.clientHeight / 3, behavior: 'smooth' });
      // flash a highlight overlay
      const flash = document.createElement('div');
      flash.className = 'pdf-flash';
      flash.style.left = `${info.el.offsetLeft}px`;
      flash.style.top = `${info.el.offsetTop + (y - h) * info.scale}px`;
      flash.style.width = `${info.el.clientWidth}px`;
      flash.style.height = `${Math.max(16, h * 2 * info.scale)}px`;
      innerRef.current?.appendChild(flash);
      setTimeout(() => flash.remove(), 1400);
    },
  }), []);

  // auto-typeset once when the pane first mounts with no pdf
  useEffect(() => {
    if (!firstOpenFired.current && !pdfUrl && status === 'idle') {
      firstOpenFired.current = true;
      onFirstOpen();
    }
  }, [pdfUrl, status, onFirstOpen]);

  // Zoom clicks arrive in bursts; debounce so three +10% clicks trigger one
  // re-layout instead of three full render passes.
  const [layoutZoom, setLayoutZoom] = useState(zoom);
  useEffect(() => {
    const t = setTimeout(() => setLayoutZoom(zoom), 150);
    return () => clearTimeout(t);
  }, [zoom]);

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
        doc = await pdfjs.getDocument(pdfUrl).promise;
        if (my !== renderTask.current) { try { doc.destroy(); } catch { /* noop */ } return; }
        const width = Math.max(320, scroller.clientWidth - 36) * layoutZoom;
        const frag = document.createDocumentFragment();
        const info: Array<{ el: HTMLCanvasElement; scale: number; height: number }> = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (my !== renderTask.current) return;
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.dataset.page = String(i);
          canvas.style.width = `${Math.floor(base.width * scale)}px`;
          canvas.style.height = `${Math.floor(base.height * scale)}px`;
          canvas.style.background = '#fff';
          frag.appendChild(canvas);
          info.push({ el: canvas, scale, height: base.height });
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

        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const i = Number((entry.target as HTMLElement).dataset.page);
            if (!i) continue;
            if (entry.isIntersecting) rasterize(i);
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
  }, [pdfUrl, layoutZoom]);

  const handleDblClick = (e: React.MouseEvent) => {
    if (!onInverse) return;
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
      <div className="pdf-pane__inner" ref={innerRef} onDoubleClick={handleDblClick} title={onInverse ? 'Double-click to jump to source' : undefined} />
      {!rendered && (
        <div className="pdf-empty">
          {status === 'compiling' ? (
            <><span className="spinner" /><p>Typesetting your document…</p></>
          ) : status === 'error' ? (
            // Only blame the document when there are errors to fix — a failed
            // run without parsed errors (missing root, server trouble) isn't
            // the user's LaTeX.
            <p>{hasErrors ? 'Fix the errors on the left, then typeset again.' : 'Typesetting didn’t finish — open the log for details.'}</p>
          ) : (
            <p>Press <span className="kbd">{shortcut('S')}</span> to typeset and preview.</p>
          )}
        </div>
      )}
    </div>
  );
});

export default PdfPane;
