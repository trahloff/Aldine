// The worker build must be evaluated before the display build: it registers
// globalThis.pdfjsWorker, which makes pdf.js run its worker on the main thread.
// A real Worker is impossible under the MCP App sandbox CSP (no worker-src,
// no blob: scripts), so this is the only way to stay self-contained.
import 'pdfjs-dist/build/pdf.worker.min.mjs';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { App, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';

// ---------------------------------------------------------------------------
// Tool-result contract (apps/server/src/mcp/tools.ts, compile / get_pdf_url)
// ---------------------------------------------------------------------------

interface CompileError { type?: string; file?: string | null; line?: number | null; message?: string }

interface Payload {
  ok?: boolean;
  pdfUrl?: string | null;
  pdfFile?: string | null;
  pdfStale?: boolean;
  pages?: number | null;
  typesetAt?: string | null;
  deepLink?: string;
  project?: string;
  projectName?: string;
  branch?: string;
  head?: string;
  errors?: CompileError[];
  errorsTotal?: number;
  timedOut?: boolean;
  /** Set by the viewer when the host hands over a prose error (isError). */
  failureText?: string;
}

/** Fetching more than this into a chat column is never what the user wants. */
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const MAX_DPR = 2;
/** Pages this far outside the well keep their pixels; further ones are released. */
const KEEP_MARGIN = '150% 0px';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`viewer: missing ${sel}`);
  return el;
};
const root = $<HTMLDivElement>('[data-testid="pdf-viewer"]');
const statusEl = $<HTMLDivElement>('[data-testid="viewer-status"]');
const errorsEl = $<HTMLElement>('[data-testid="viewer-errors"]');
const errorsToggle = $<HTMLButtonElement>('[data-testid="viewer-errors-toggle"]');
const errorsSummary = $<HTMLSpanElement>('.errors-summary');
const errorsList = $<HTMLUListElement>('[data-testid="viewer-errors-list"]');
const noticeEl = $<HTMLDivElement>('[data-testid="viewer-notice"]');
const pagesEl = $<HTMLDivElement>('[data-testid="viewer-pages"]');
const prevBtn = $<HTMLButtonElement>('[data-testid="viewer-prev"]');
const nextBtn = $<HTMLButtonElement>('[data-testid="viewer-next"]');
const countEl = $<HTMLSpanElement>('[data-testid="viewer-page-count"]');
const zoomOut = $<HTMLButtonElement>('[data-testid="viewer-zoom-out"]');
const zoomBtn = $<HTMLButtonElement>('[data-testid="viewer-zoom"]');
const zoomIn = $<HTMLButtonElement>('[data-testid="viewer-zoom-in"]');
const expandBtn = $<HTMLButtonElement>('[data-testid="viewer-expand"]');
const openLink = $<HTMLAnchorElement>('[data-testid="viewer-open"]');

// ---------------------------------------------------------------------------
// Host bridge
// ---------------------------------------------------------------------------

let app: App | null = null;
let hostCtx: McpUiHostContext | undefined;
let locale: string | undefined;
let timeZone: string | undefined;

function applyHostContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  hostCtx = ctx;
  if (ctx.theme === 'dark' || ctx.theme === 'light') {
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.locale) locale = ctx.locale;
  if (ctx.timeZone) timeZone = ctx.timeZone;
  document.documentElement.setAttribute('data-display', ctx.displayMode ?? 'inline');
  const dims = ctx.containerDimensions as { maxHeight?: number; height?: number } | undefined;
  const h = dims?.height ?? dims?.maxHeight;
  if (ctx.displayMode !== 'fullscreen' && typeof h === 'number' && h > 0) {
    // The bars need ~110px; never squeeze the well below a readable strip.
    root.style.setProperty('--v-canvas-h', `${Math.max(240, Math.floor(h - 110))}px`);
  }
  const modes = ctx.availableDisplayModes ?? [];
  expandBtn.hidden = !modes.includes('fullscreen');
  expandBtn.textContent = ctx.displayMode === 'fullscreen' ? '⤡' : '⤢';
  expandBtn.title = ctx.displayMode === 'fullscreen' ? 'Back to inline' : 'Expand';
  expandBtn.setAttribute('aria-label', expandBtn.title);
  if (state.doc) queueLayout();
}

/** Both notification shapes hydrate the same payload: structuredContent when
 *  the host passes it through, else the JSON text block the model reads. */
function payloadFromToolResult(result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }): Payload {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Payload;
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) return { ok: false, failureText: text || 'The compile request failed' };
  try { return JSON.parse(text) as Payload; } catch { return { ok: false, failureText: text || 'The tool result could not be read' }; }
}

type ToolResultLike = Parameters<typeof payloadFromToolResult>[0];
function isToolResultShaped(x: unknown): x is ToolResultLike {
  return !!x && typeof x === 'object' && ('content' in x || 'structuredContent' in x);
}

function connectHost(): void {
  if (window.parent === window) return;
  const a = new App({ name: 'aldine-pdf-viewer', version: '0.3.0' }, {}, { autoResize: true });
  a.ontoolresult = (params) => hydrate(payloadFromToolResult(params));
  a.ontoolcancelled = () => {
    if (root.dataset.state === 'waiting') showNotice('The compile was cancelled', 'Nothing to show yet.');
  };
  a.onhostcontextchanged = (ctx) => applyHostContext({ ...(hostCtx ?? {}), ...ctx });
  a.connect().then(() => {
    app = a;
    applyHostContext(a.getHostContext());
  }).catch((err: unknown) => {
    // Not an MCP host (or one that never answered): the standalone contract
    // below still works, and the waiting notice is already on screen.
    console.warn('[viewer] host handshake failed', err);
  });
}

/** Standalone contract (plain browser, Playwright): ?payload=<base64 JSON>
 *  or window.postMessage({ type: 'aldine-pdf-viewer/tool-result', result }).
 *  `result` is either a CallToolResult or the bare structuredContent object. */
function readUrlPayload(): Payload | null {
  const raw = new URLSearchParams(location.search).get('payload');
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return isToolResultShaped(parsed) ? payloadFromToolResult(parsed) : parsed as Payload;
  } catch (err) {
    console.warn('[viewer] bad ?payload', err);
    return { ok: false, failureText: 'The payload in the URL could not be read' };
  }
}

window.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data as { type?: string; result?: unknown } | null;
  if (!data || data.type !== 'aldine-pdf-viewer/tool-result') return;
  const r = data.result;
  hydrate(isToolResultShaped(r) ? payloadFromToolResult(r) : (r as Payload));
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PageSlot {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  w: number;
  h: number;
  task: RenderTask | null;
  state: 'blank' | 'rendering' | 'done';
  /** Inside the observer margin — the render chain skips (and drops) pages that left it. */
  visible: boolean;
  /** Bumped by every release(): a queued render for an older epoch is void. */
  epoch: number;
}

const state = {
  payload: null as Payload | null,
  doc: null as PDFDocumentProxy | null,
  slots: [] as PageSlot[],
  zoom: 1,
  current: 1,
  generation: 0,
  observer: null as IntersectionObserver | null,
  chain: Promise.resolve(),
  layoutTimer: 0,
  fetchCtl: null as AbortController | null,
};

function deepLinkTo(file: string | null | undefined, line: number | null | undefined): string {
  const base = state.payload?.deepLink ?? '#';
  if (!file) return base;
  const q = `file=${encodeURIComponent(file.replace(/^\.\//, ''))}${line ? `&line=${line}` : ''}`;
  return `${base}${base.includes('?') ? '&' : '?'}${q}`;
}

function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  try {
    return new Intl.DateTimeFormat(locale, {
      ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
      hour: '2-digit', minute: '2-digit', timeZone,
    }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

// ---------------------------------------------------------------------------
// Rendering the chrome
// ---------------------------------------------------------------------------

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}
function sep(): HTMLSpanElement { return span('sep', ''); }

/** pdfUrl is this run's result — the viewer keys its state on that, not on
 *  `ok`: TeX logs errors and still ships a complete document. A stale link
 *  is the previous run's only when this run failed; an ok run that wrote
 *  nothing (latexmk found the document up to date) still stands behind it. */
function hasFreshPdf(p: Payload): boolean {
  return !!p.pdfUrl && (!p.pdfStale || p.ok !== false);
}

/** Only type 'error' rows: warnings and box reports are not errors. */
function errorCount(p: Payload): number {
  const errors = Array.isArray(p.errors) ? p.errors : [];
  return errors.filter((e) => e.type === 'error').length;
}

function renderStatus(p: Payload, pages: number | null): void {
  statusEl.replaceChildren();
  const parts: HTMLElement[] = [];
  const failed = p.ok === false;
  parts.push(span('file', p.pdfFile ?? p.projectName ?? 'PDF'));
  if (p.branch) parts.push(sep(), span('branch', p.branch));
  if (failed) {
    const n = errorCount(p);
    const label = p.timedOut ? 'Typesetting timed out'
      : hasFreshPdf(p) && n > 0 ? `${n} ${n === 1 ? 'error' : 'errors'}`
      : 'Typesetting failed';
    parts.push(sep(), span('failed', label));
  }
  const t = formatTime(p.typesetAt);
  if (t && p.pdfUrl) parts.push(sep(), span('time', `typeset ${t}`));
  if (pages != null && p.pdfUrl) parts.push(sep(), span('pagecount', `${pages} ${pages === 1 ? 'page' : 'pages'}`));
  if (p.pdfStale && p.pdfUrl && p.ok === false) {
    const s = span('stale', 'previous PDF');
    s.title = 'This run wrote no PDF; the one shown is from an earlier typeset.';
    parts.push(sep(), s);
  }
  if (p.head) {
    const h = span('head', p.head);
    h.title = 'Commit';
    parts.push(sep(), h);
  }
  statusEl.append(...parts);
}

function renderErrors(p: Payload): void {
  const errors = Array.isArray(p.errors) ? p.errors : [];
  const total = typeof p.errorsTotal === 'number' ? p.errorsTotal : errors.length;
  if (errors.length === 0 && !p.failureText) { errorsEl.hidden = true; return; }
  const nErr = errorCount(p);
  const nWarn = errors.length - nErr;
  const bits: string[] = [];
  if (nErr) bits.push(`${nErr} ${nErr === 1 ? 'error' : 'errors'}`);
  if (nWarn) bits.push(`${nWarn} ${nWarn === 1 ? 'warning' : 'warnings'}`);
  if (p.failureText && errors.length === 0) bits.push('Compile failed');
  errorsSummary.textContent = bits.join(' · ');
  errorsList.replaceChildren();
  if (p.failureText) {
    const li = document.createElement('li');
    const row = span('row', '');
    row.append(span('loc', 'Aldine'), span('msg', p.failureText));
    li.append(row);
    errorsList.append(li);
  }
  for (const e of errors) {
    const li = document.createElement('li');
    li.dataset.testid = 'viewer-error-row';
    const file = e.file ? e.file.replace(/^\.\//, '') : null;
    const loc = file ? `${file}${e.line ? `:${e.line}` : ''}` : (e.type ?? 'error');
    const msg = e.message ?? '';
    if (file) {
      const a = document.createElement('a');
      a.href = deepLinkTo(file, e.line);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = `Open ${loc} in Aldine`;
      a.append(span('loc', loc), span('msg', msg));
      a.addEventListener('click', onLinkClick);
      li.append(a);
    } else {
      const row = span('row', '');
      row.append(span('loc', loc), span('msg', msg));
      li.append(row);
    }
    errorsList.append(li);
  }
  if (total > errors.length) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `Showing the first ${errors.length} of ${total} — the full log is in Aldine.`;
    errorsList.append(li);
  }
  setErrorsOpen(p.ok === false);
  errorsEl.hidden = false;
}

function setErrorsOpen(open: boolean): void {
  errorsEl.dataset.open = String(open);
  errorsToggle.setAttribute('aria-expanded', String(open));
}
errorsToggle.addEventListener('click', () => setErrorsOpen(errorsEl.dataset.open !== 'true'));

function showNotice(title: string, text?: string, opts: { spinner?: boolean; link?: { href: string; label: string } } = {}): void {
  noticeEl.replaceChildren();
  if (opts.spinner) noticeEl.append(span('spinner', ''));
  noticeEl.append(span('title', title));
  if (text) noticeEl.append(span('text', text));
  if (opts.link) {
    const a = document.createElement('a');
    a.href = opts.link.href;
    a.textContent = opts.link.label;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.addEventListener('click', onLinkClick);
    noticeEl.append(a);
  }
  noticeEl.hidden = false;
}

function setControlsEnabled(on: boolean): void {
  for (const b of [prevBtn, nextBtn, zoomOut, zoomBtn, zoomIn]) b.disabled = !on;
}

/** Inside a host, links leave the sandbox through ui/open-link; a plain
 *  browser follows the href. */
function onLinkClick(ev: MouseEvent): void {
  const a = ev.currentTarget as HTMLAnchorElement;
  if (!app || !app.getHostCapabilities()?.openLinks) return;
  ev.preventDefault();
  app.openLink({ url: a.href }).catch((err: unknown) => console.warn('[viewer] open-link failed', err));
}
openLink.addEventListener('click', onLinkClick);

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

function hydrate(p: Payload): void {
  state.payload = p;
  teardownDoc();
  const failed = p.ok === false;
  const fresh = hasFreshPdf(p);
  root.dataset.state = fresh ? 'loading' : 'failed';
  renderStatus(p, p.pages ?? null);
  renderErrors(p);
  const firstErr = (p.errors ?? []).find((e) => e.file);
  openLink.href = failed && firstErr ? deepLinkTo(firstErr.file, firstErr.line) : (p.deepLink ?? '#');
  openLink.hidden = !p.deepLink;
  pagesEl.hidden = true;
  setControlsEnabled(false);
  countEl.textContent = '– / –';

  if (fresh) {
    void loadPdf(p.pdfUrl!);
    return;
  }
  if (!failed && !p.pdfUrl) {
    showNotice('No PDF yet', 'Typeset the project once and the PDF shows up here.');
    return;
  }
  const n = p.errorsTotal ?? p.errors?.length ?? 0;
  const title = p.timedOut ? 'Typesetting timed out' : 'No PDF from this run';
  const hint = p.failureText ? undefined : (n ? `Fix the ${n === 1 ? 'error' : `${n} errors`} above, then ask for a recompile.` : 'Ask for a recompile once the source is fixed.');
  if (!p.pdfUrl) {
    showNotice(title, hint);
    return;
  }
  // pdfStale: the link is an earlier typeset's PDF, offered but not assumed.
  showNotice(title, hint, { link: { href: p.pdfUrl, label: 'Show the previous PDF' } });
  const a = noticeEl.querySelector('a')!;
  a.removeEventListener('click', onLinkClick);
  a.addEventListener('click', (ev) => { ev.preventDefault(); root.dataset.state = 'loading'; void loadPdf(p.pdfUrl!); });
}

function teardownDoc(): void {
  state.generation++;
  state.fetchCtl?.abort();
  state.fetchCtl = null;
  state.observer?.disconnect();
  state.observer = null;
  for (const s of state.slots) s.task?.cancel();
  state.slots = [];
  pagesEl.replaceChildren();
  const doc = state.doc;
  state.doc = null;
  if (doc) doc.destroy().catch(() => { /* already gone */ });
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function loadPdf(url: string): Promise<void> {
  const gen = state.generation;
  const ctl = new AbortController();
  state.fetchCtl = ctl;
  showNotice('Loading the PDF…', undefined, { spinner: true });
  let data: Uint8Array;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctl.signal });
    if (gen !== state.generation) return;
    if (!res.ok) {
      const expired = res.status === 403;
      throw new Error(expired ? 'This PDF link has expired — ask for a fresh one (get_pdf_url) or open the project in Aldine.' : `The PDF could not be fetched (HTTP ${res.status}).`);
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_PDF_BYTES) throw new Error(`This PDF is ${fmtBytes(declared)} — too large to preview here. Open it in Aldine instead.`);
    const chunks: Uint8Array[] = [];
    let got = 0;
    const reader = res.body?.getReader();
    if (!reader) {
      data = new Uint8Array(await res.arrayBuffer());
    } else {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== state.generation) { await reader.cancel(); return; }
        chunks.push(value);
        got += value.byteLength;
        if (got > MAX_PDF_BYTES) {
          await reader.cancel();
          throw new Error('This PDF is over 50 MB — too large to preview here. Open it in Aldine instead.');
        }
        showNotice('Loading the PDF…', fmtBytes(got), { spinner: true });
      }
      data = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.byteLength; }
    }
  } catch (err) {
    if (gen !== state.generation) return;
    const msg = err instanceof Error ? err.message : String(err);
    const network = /fetch|network|load failed/i.test(msg) && !/HTTP|expired|large/.test(msg);
    root.dataset.state = 'error';
    showNotice("Couldn't load the PDF", network ? 'The Aldine server did not answer, or the link has expired.' : msg,
      state.payload?.deepLink ? { link: { href: state.payload.deepLink, label: 'Open in Aldine' } } : undefined);
    return;
  }

  try {
    const doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false, // sandbox CSP has no unsafe-eval
      useSystemFonts: true,
    }).promise;
    if (gen !== state.generation) { doc.destroy().catch(() => { /* noop */ }); return; }
    state.doc = doc;
    await buildSlots(doc, gen);
    if (gen !== state.generation) return;
    noticeEl.hidden = true;
    pagesEl.hidden = false;
    root.dataset.state = 'ready';
    if (state.payload) renderStatus(state.payload, doc.numPages);
    setControlsEnabled(true);
    state.zoom = 1;
    layout();
    observePages();
    updateCurrent();
  } catch (err) {
    if (gen !== state.generation) return;
    root.dataset.state = 'error';
    showNotice("Couldn't render the PDF", err instanceof Error ? err.message : String(err),
      state.payload?.deepLink ? { link: { href: state.payload.deepLink, label: 'Open in Aldine' } } : undefined);
  }
}

// ---------------------------------------------------------------------------
// Pages: layout is computed for every page up front (getViewport only), pixels
// are rasterized near the viewport and released far from it.
// ---------------------------------------------------------------------------

async function buildSlots(doc: PDFDocumentProxy, gen: number): Promise<void> {
  const slots: PageSlot[] = [];
  const first = await doc.getPage(1);
  const firstVp = first.getViewport({ scale: 1 });
  for (let i = 1; i <= doc.numPages; i++) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.testid = 'viewer-page';
    el.dataset.page = String(i);
    el.append(span('num', String(i)));
    // Sizes default to page 1's; other pages correct themselves lazily below
    // so a 300-page document lays out without 300 getPage round trips.
    slots.push({ el, canvas: null, w: firstVp.width, h: firstVp.height, task: null, state: 'blank', visible: false, epoch: 0 });
  }
  if (gen !== state.generation) return;
  state.slots = slots;
  pagesEl.replaceChildren(...slots.map((s) => s.el));
  // Mixed page sizes (landscape figures) are the exception; fix them in the
  // background without blocking first paint.
  void (async () => {
    for (let i = 2; i <= doc.numPages; i++) {
      if (gen !== state.generation) return;
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const s = state.slots[i - 1];
      if (s && (Math.abs(s.w - vp.width) > 0.5 || Math.abs(s.h - vp.height) > 0.5)) {
        s.w = vp.width; s.h = vp.height;
        sizeSlot(s);
      }
    }
  })();
}

function fitWidth(): number {
  const pad = 24;
  return Math.max(200, pagesEl.clientWidth - pad);
}

function sizeSlot(s: PageSlot): void {
  const cssW = Math.floor(fitWidth() * state.zoom);
  const cssH = Math.floor(cssW * (s.h / s.w));
  s.el.style.width = `${cssW}px`;
  s.el.style.height = `${cssH}px`;
}

function layout(): void {
  for (const s of state.slots) sizeSlot(s);
  zoomBtn.textContent = `${Math.round(state.zoom * 100)}%`;
  zoomOut.disabled = state.zoom <= ZOOM_STEPS[0];
  zoomIn.disabled = state.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

function queueLayout(): void {
  clearTimeout(state.layoutTimer);
  state.layoutTimer = window.setTimeout(() => {
    if (!state.doc) return;
    // A width change invalidates every rasterized page.
    for (const s of state.slots) release(s, true);
    layout();
    observePages();
  }, 120);
}

function observePages(): void {
  state.observer?.disconnect();
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const s = state.slots[Number((e.target as HTMLElement).dataset.page) - 1];
      if (!s) continue;
      s.visible = e.isIntersecting;
      if (e.isIntersecting) rasterize(s); else release(s, false);
    }
  }, { root: pagesEl, rootMargin: KEEP_MARGIN });
  for (const s of state.slots) obs.observe(s.el);
  state.observer = obs;
  // Page 1 is eager: the first paint must not wait for the observer's first
  // callback.
  if (state.slots[0]) { state.slots[0].visible = true; rasterize(state.slots[0]); }
}

function rasterize(s: PageSlot): void {
  if (s.state !== 'blank' || !state.doc) return;
  s.state = 'rendering';
  const gen = state.generation;
  const epoch = s.epoch;
  const idx = Number(s.el.dataset.page);
  // The chain is serial, so by the time this entry runs the page may have
  // scrolled away or been re-laid out: both are checked here, not at enqueue.
  const live = () => gen === state.generation && s.epoch === epoch && s.state === 'rendering';
  state.chain = state.chain.then(async () => {
    if (!live() || !state.doc) return;
    if (!s.visible) { s.state = 'blank'; return; }
    try {
      const page = await state.doc.getPage(idx);
      if (!live()) return;
      const cssW = parseFloat(s.el.style.width) || fitWidth();
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const viewport = page.getViewport({ scale: cssW / s.w });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.scale(dpr, dpr);
      s.task = page.render({ canvasContext: ctx, viewport });
      await s.task.promise;
      s.task = null;
      if (!live()) { canvas.width = 0; canvas.height = 0; return; }
      if (!s.visible) {
        // Scrolled out while rendering: a bitmap nobody sees is not kept.
        canvas.width = 0; canvas.height = 0;
        s.state = 'blank';
        return;
      }
      s.canvas?.remove();
      s.canvas = canvas;
      s.el.prepend(canvas);
      s.el.classList.add('rendered');
      s.state = 'done';
    } catch (err) {
      s.task = null;
      if (live()) s.state = 'blank';
      if ((err as { name?: string })?.name !== 'RenderingCancelledException') console.error('[viewer] page render failed', err);
    }
  });
}

/** Drops the bitmap (the CSS box stays, so scroll geometry is untouched).
 *  A queued or in-flight render is voided too: with `force` its task is
 *  cancelled outright, otherwise the chain drops the result on arrival. */
function release(s: PageSlot, force: boolean): void {
  s.epoch++;
  if (s.state === 'rendering' && force) { s.task?.cancel(); s.task = null; }
  if (s.canvas) {
    s.canvas.width = 0;
    s.canvas.height = 0;
    s.canvas.remove();
    s.canvas = null;
  }
  s.el.classList.remove('rendered');
  s.state = 'blank';
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function updateCurrent(): void {
  const n = state.slots.length;
  if (!n) return;
  const probe = pagesEl.scrollTop + pagesEl.clientHeight * 0.4;
  let cur = n;
  for (let i = 0; i < n; i++) {
    const el = state.slots[i].el;
    if (el.offsetTop + el.offsetHeight > probe) { cur = i + 1; break; }
  }
  state.current = cur;
  countEl.textContent = `${cur} / ${n}`;
  prevBtn.disabled = cur <= 1;
  nextBtn.disabled = cur >= n;
}

function goTo(page: number): void {
  const s = state.slots[page - 1];
  if (!s) return;
  pagesEl.scrollTo({ top: s.el.offsetTop - 12, behavior: 'auto' });
  updateCurrent();
}

function setZoom(z: number): void {
  if (!state.doc || z === state.zoom) return;
  const ratio = pagesEl.scrollHeight > 0 ? pagesEl.scrollTop / pagesEl.scrollHeight : 0;
  state.zoom = z;
  for (const s of state.slots) release(s, true);
  layout();
  pagesEl.scrollTop = ratio * pagesEl.scrollHeight;
  observePages();
  updateCurrent();
}

prevBtn.addEventListener('click', () => goTo(state.current - 1));
nextBtn.addEventListener('click', () => goTo(state.current + 1));
zoomOut.addEventListener('click', () => setZoom(ZOOM_STEPS.filter((z) => z < state.zoom).pop() ?? ZOOM_STEPS[0]));
zoomIn.addEventListener('click', () => setZoom(ZOOM_STEPS.find((z) => z > state.zoom) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]));
zoomBtn.addEventListener('click', () => setZoom(1));
expandBtn.addEventListener('click', () => {
  if (!app) return;
  const mode = hostCtx?.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  app.requestDisplayMode({ mode }).then((r) => applyHostContext({ ...(hostCtx ?? {}), displayMode: r.mode }))
    .catch((err: unknown) => console.warn('[viewer] display mode refused', err));
});
pagesEl.addEventListener('scroll', () => updateCurrent(), { passive: true });
new ResizeObserver(() => { if (state.doc) queueLayout(); }).observe(pagesEl);
document.addEventListener('keydown', (ev) => {
  if (!state.doc || (ev.target as HTMLElement | null)?.tagName === 'INPUT') return;
  if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); goTo(state.current - 1); }
  if (ev.key === 'ArrowRight' || ev.key === 'PageDown') { ev.preventDefault(); goTo(state.current + 1); }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const urlPayload = readUrlPayload();
if (urlPayload) hydrate(urlPayload);
else connectHost();
