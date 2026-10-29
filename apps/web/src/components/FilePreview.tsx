import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { api, type TreeEntry } from '../api';
import { formatBytes, IMAGE_ZOOM_STEPS, nextZoom, PDF_ZOOM_STEPS, previewKind } from '../util/filePreview';
import { createPdfPagesStore, pagesOnScreen, scrollTopForPage } from '../util/pdfPages';
import { IconFile } from './Icons';
import PdfPageNav from './PdfPageNav';

if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
}
// From the worker's URL, never the page's: see PdfPane.
const cMapUrl = new URL('../cmaps/', pdfjs.GlobalWorkerOptions.workerSrc).toString();

interface Props {
  projectId: string;
  branch: string;
  path: string;
  /** The listing's entry: the size to show, and the mtime that tells a
   *  replaced file's bytes from the ones already loaded. */
  entry?: TreeEntry;
}

/**
 * A project file the code editor cannot show: an image or a PDF drawn from
 * the file route, anything else as its name, size and a download. Never a
 * collab document. An SVG is only ever an <img>: inlined into the page its
 * scripts would run as the viewer.
 */
export default function FilePreview({ projectId, branch, path, entry }: Props) {
  const kind = previewKind(path, entry) ?? 'file';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const url = api.fileUrl(projectId, branch, path, entry?.mtime);
  if (kind === 'image') return <ImagePreview url={url} path={path} name={name} size={entry?.size} />;
  if (kind === 'pdf') return <PdfPreview url={url} path={path} name={name} />;
  return (
    <div className="file-preview" data-testid="file-preview" data-kind="file">
      <PreviewHeader path={path} />
      <div className="file-preview__stage">
        <div className="file-preview__card" data-testid="preview-file-card">
          <IconFile width={28} height={28} aria-hidden="true" />
          <p className="file-preview__name">{name}</p>
          {entry?.size != null && <p className="file-preview__size" data-testid="preview-size">{formatBytes(entry.size)}</p>}
          <p className="file-preview__note">There is no preview for this kind of file.</p>
          <DownloadLink url={url} name={name} primary />
        </div>
      </div>
    </div>
  );
}

function PreviewHeader({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="pane__header file-preview__header">
      <span className="statusbar__file" data-testid="active-file" title={path}>{path}</span>
      {children}
    </div>
  );
}

function DownloadLink({ url, name, primary = false }: { url: string; name: string; primary?: boolean }) {
  return (
    <a className={primary ? 'btn btn--primary' : 'btn btn--ghost btn--small'} href={url} download={name} title={`Download ${name}`} data-testid="preview-download">
      Download
    </a>
  );
}

function ZoomControls({ label, fitLabel, onZoom }: { label: string; fitLabel: string; onZoom(dir: 1 | -1 | 0): void }) {
  return (
    <div className="zoom" role="group" aria-label="Zoom" data-testid="preview-zoom">
      <button type="button" className="btn btn--ghost btn--small" onClick={() => onZoom(-1)} title="Zoom out" aria-label="Zoom out" data-testid="preview-zoom-out">−</button>
      <button type="button" className="zoom__label" onClick={() => onZoom(0)} title={fitLabel} aria-label={`Zoom ${label}. ${fitLabel}`} data-testid="preview-zoom-fit">{label}</button>
      <button type="button" className="btn btn--ghost btn--small" onClick={() => onZoom(1)} title="Zoom in" aria-label="Zoom in" data-testid="preview-zoom-in">+</button>
    </div>
  );
}

/** + and - zoom, 0 fits, wherever focus is inside the preview but in the
 *  page field, where 0 is a digit of the page number. */
function zoomKeys(onZoom: (dir: 1 | -1 | 0) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
    const dir = e.key === '+' || e.key === '=' ? 1 : e.key === '-' ? -1 : e.key === '0' ? 0 : null;
    if (dir === null) return;
    e.preventDefault();
    onZoom(dir);
  };
}

function ImagePreview({ url, path, name, size }: { url: string; path: string; name: string; size?: number }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => { setFailed(false); }, [url]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      setBox({
        w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // An SVG without width and height has no pixel size; it fills the pane.
  const dims = !failed && natural && natural.w > 0 && natural.h > 0 ? natural : null;
  // Fit never enlarges: a 16 px icon shows at 16 px, not as a blur.
  const fit = dims && box.w > 0 && box.h > 0 ? Math.min(1, box.w / dims.w, box.h / dims.h) : 1;
  const scale = zoom === 'fit' ? fit : zoom;
  const onZoom = (dir: 1 | -1 | 0) => setZoom(dir === 0 ? 'fit' : nextZoom(scale, dir, IMAGE_ZOOM_STEPS));

  return (
    <div className="file-preview" data-testid="file-preview" data-kind="image" onKeyDown={dims ? zoomKeys(onZoom) : undefined}>
      <PreviewHeader path={path}>
        {dims && <span className="file-preview__meta" data-testid="preview-dimensions">{dims.w} × {dims.h} px</span>}
        {size != null && <span className="file-preview__meta">{formatBytes(size)}</span>}
        <span className="toolbar__spacer" />
        {dims && <ZoomControls label={`${Math.round(scale * 100)}%`} fitLabel="Fit to the pane" onZoom={onZoom} />}
        <DownloadLink url={url} name={name} />
      </PreviewHeader>
      <div className="file-preview__stage" ref={stageRef} tabIndex={0} role="region" aria-label={`Preview of ${name}`} data-testid="preview-stage">
        {failed ? (
          <div className="pdf-empty" data-testid="preview-error">
            <p>Could not show this image. Download it to open it in another app.</p>
          </div>
        ) : (
          <img
            className={`file-preview__img${dims ? '' : ' file-preview__img--unsized'}`}
            src={url}
            alt={name}
            draggable={false}
            data-testid="preview-image"
            style={dims ? { width: Math.max(1, Math.round(dims.w * scale)), height: Math.max(1, Math.round(dims.h * scale)) } : undefined}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

type LoadedPdf = { pdf: PDFDocumentProxy; sizes: Array<{ w: number; h: number }> };

/**
 * pdf.js like the compiled-PDF pane, on its own document: every page gets
 * its laid-out size at once, pixels only near the viewport, and pages far
 * off screen give their bitmaps back.
 */
function PdfPreview({ url, path, name }: { url: string; path: string; name: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<Array<HTMLCanvasElement | null>>([]);
  const [doc, setDoc] = useState<LoadedPdf | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [zoom, setZoom] = useState(1); // a multiple of fit width
  const [width, setWidth] = useState(0);
  const [pages] = useState(createPdfPagesStore);
  /** The middle of the view as a fraction of the content height: a zoom or a resize keeps it in place. */
  const anchor = useRef(0);
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    // An uploaded PDF is arbitrary bytes drawn on the app's origin: no font
    // program compiled to a JavaScript function.
    const task = pdfjs.getDocument({ url, cMapUrl, cMapPacked: true, isEvalSupported: false });
    (async () => {
      try {
        const pdf = await task.promise;
        const sizes: LoadedPdf['sizes'] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
          sizes.push({ w: vp.width, h: vp.height });
        }
        if (!live) return;
        setDoc({ pdf, sizes });
        setStatus('ready');
      } catch {
        if (live) setStatus('error');
      }
    })();
    return () => {
      live = false;
      void task.destroy();
    };
  }, [url]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => setWidth(el.clientWidth), 150);
    });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, []);

  const fitWidth = Math.max(120, width - 36);
  const pageWidth = Math.floor(fitWidth * zoom);
  const sizes = doc?.sizes ?? [];
  pagesRef.current.length = sizes.length;

  const readPosition = () => {
    const el = scrollRef.current;
    if (!el) return;
    anchor.current = el.scrollHeight ? (el.scrollTop + el.clientHeight / 2) / el.scrollHeight : 0;
    pages.set(pagesOnScreen(el, pagesRef.current.length, (i) => pagesRef.current[i]));
  };

  const goToPage = (page: number) => {
    const el = scrollRef.current, canvases = pagesRef.current;
    if (!el || !canvases.length) return;
    const i = Math.min(Math.max(1, page), canvases.length) - 1;
    const canvas = canvases[i];
    if (canvas) el.scrollTo({ top: scrollTopForPage(canvas, canvases[i - 1]) });
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !sizes.length) return;
    el.scrollTop = anchor.current * el.scrollHeight - el.clientHeight / 2;
    readPosition();
  }, [pageWidth, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom clicks come in bursts and a pane drag resizes every frame: the
  // canvases stretch at once, and are redrawn sharp once it settles.
  const [settled, setSettled] = useState(pageWidth);
  useEffect(() => {
    const t = setTimeout(() => setSettled(pageWidth), 150);
    return () => clearTimeout(t);
  }, [pageWidth]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!doc || !scroller) return;
    const gen = String(++generation.current);
    let live = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const busy = new Set<number>();
    const tasks = new Set<RenderTask>();
    let chain: Promise<void> = Promise.resolve(); // one render at a time in the worker

    const rasterize = (i: number) => {
      const canvas = pagesRef.current[i - 1];
      if (!canvas || busy.has(i) || canvas.dataset.drawn === gen) return;
      busy.add(i);
      chain = chain.then(async () => {
        try {
          if (!live) return;
          const pdfPage = await doc.pdf.getPage(i);
          if (!live) return;
          const viewport = pdfPage.getViewport({ scale: (canvas.clientWidth / doc.sizes[i - 1].w) * dpr });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const task = pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport });
          tasks.add(task);
          try { await task.promise; } finally { tasks.delete(task); }
          if (live) canvas.dataset.drawn = gen;
        } catch {
          // cancelled by a newer layout, or the file was replaced meanwhile
        } finally {
          busy.delete(i);
        }
      });
    };
    const release = (i: number) => {
      const canvas = pagesRef.current[i - 1];
      if (!canvas || busy.has(i) || canvas.width === 0) return;
      // Zero the backing store; the CSS size keeps the layout.
      canvas.width = 0;
      canvas.height = 0;
      delete canvas.dataset.drawn;
    };

    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.page);
        if (!i) continue;
        if (e.isIntersecting) rasterize(i);
        else release(i);
      }
    }, { root: scroller, rootMargin: '150% 0px' });
    for (const c of pagesRef.current) if (c) observer.observe(c);
    return () => {
      live = false;
      observer.disconnect();
      for (const t of tasks) t.cancel();
    };
  }, [doc, settled]);

  const onZoom = (dir: 1 | -1 | 0) => setZoom((z) => (dir === 0 ? 1 : nextZoom(z, dir, PDF_ZOOM_STEPS)));

  return (
    <div className="file-preview" data-testid="file-preview" data-kind="pdf" onKeyDown={doc ? zoomKeys(onZoom) : undefined}>
      <PreviewHeader path={path}>
        <span className="toolbar__spacer" />
        {doc && <PdfPageNav store={pages} onGo={goToPage} testId="preview-page" />}
        {doc && <ZoomControls label={`${Math.round(zoom * 100)}%`} fitLabel="Fit width" onZoom={onZoom} />}
        <DownloadLink url={url} name={name} />
      </PreviewHeader>
      <div
        className="file-preview__stage file-preview__stage--pdf"
        ref={scrollRef}
        onScroll={readPosition}
        tabIndex={0}
        role="region"
        aria-label={`Pages of ${name}`}
        data-testid="preview-stage"
      >
        <div className="file-preview__pages">
          {sizes.map((s, i) => (
            <canvas
              key={i}
              ref={(el) => { pagesRef.current[i] = el; }}
              className="file-preview__page"
              data-page={i + 1}
              data-testid="preview-pdf-page"
              style={{ width: pageWidth, height: Math.floor((pageWidth * s.h) / s.w) }}
            />
          ))}
        </div>
        {status !== 'ready' && (
          <div className="pdf-empty" data-testid={status === 'error' ? 'preview-error' : 'preview-loading'}>
            {status === 'loading'
              ? <><span className="spinner" /><p>Opening the PDF…</p></>
              : <p>Could not open this PDF. It may be damaged or protected by a password — download it to open it in another app.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
