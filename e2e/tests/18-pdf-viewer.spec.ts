import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, cleanup } from './helpers';

/**
 * The MCP App PDF viewer (ui://aldine/pdf-viewer, spec 04-phase3 §3.2), loaded
 * standalone: the built HTML is served by a throwaway loopback server on its
 * own origin so the signed-URL fetch crosses origins the way the host sandbox
 * does (a page.route-fulfilled document has no address space, and Chrome then
 * blocks its fetches to loopback as local-network access). The tool result
 * arrives through the standalone contract (?payload= / postMessage) in most
 * tests; the last one runs the real host handshake (ext-apps AppBridge over
 * postMessage) from a host page on the same loopback server.
 */
const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp';
const PORT = process.env.E2E_PORT || 3100;
const BASE = process.env.ALDINE_URL || `http://localhost:${PORT}`;
const VIEWER_HTML = path.resolve(__dirname, '..', '..', 'apps', 'server', 'assets', 'pdf-viewer.html');

const TWO_PAGES = [
  '\\documentclass{article}',
  '\\begin{document}',
  'First page of the viewer fixture.',
  '\\newpage',
  'Second page of the viewer fixture.',
  '\\end{document}',
  '',
].join('\n');
const BROKEN = TWO_PAGES.replace('First page of the viewer fixture.', 'First page.\n\\thisisnotacommand');
/** The error comes after the first page shipped out: under -halt-on-error
 *  pdfTeX then removes the PDF it had started ("no output PDF file produced"). */
const BROKEN_LATE = TWO_PAGES.replace('Second page of the viewer fixture.', 'Second page.\n\\thisisnotacommand');
/** Undefined citation/reference warnings plus an Overfull box (an unbreakable
 *  string wider than the line), which is a typesetting note, not a warning. */
const WARNINGS = TWO_PAGES.replace('First page of the viewer fixture.', `First page, citing~\\cite{nothing} and \\ref{nowhere}. \\texttt{${'x'.repeat(120)}}`);

/** A host page: the bridge is connected BEFORE the iframe navigates, so the
 *  viewer's ui/initialize (sent at script eval) always finds a listener. */
const HOST_HTML = `<!doctype html><meta charset="utf-8"><title>e2e host</title>
<script src="/host.js"></script>
<body style="margin:0"><script>
const { AppBridge, PostMessageTransport } = window.__AldineHost;
window.__opened = []; window.__events = [];
const iframe = document.createElement('iframe');
iframe.id = 'app'; iframe.style.cssText = 'width:760px;height:700px;border:0';
document.body.append(iframe);
const bridge = new AppBridge(null, { name: 'aldine-e2e-host', version: '0.0.0' }, { openLinks: {} }, {
  hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], locale: 'en-GB', timeZone: 'UTC' },
});
bridge.onopenlink = async (p) => { window.__opened.push(p.url); return {}; };
bridge.oninitialized = () => { window.__events.push('initialized'); };
bridge.onrequestdisplaymode = async (p) => { window.__events.push('display:' + p.mode); return { mode: p.mode }; };
bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow)).then(() => {
  window.__bridge = bridge;
  iframe.src = '/pdf-viewer.html';
});
</script>`;

async function connect(): Promise<Client> {
  const client = new Client({ name: 'aldine-e2e-viewer', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${BASE}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } } },
  ));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return { isError: res.isError === true, body: res.isError ? null : JSON.parse(text), structuredContent: res.structuredContent, raw: res };
}

let viewerServer: http.Server;
let viewerOrigin = '';
let hostBundle = '';

async function openViewer(page: Page, payload: unknown | null): Promise<void> {
  const q = payload ? `?payload=${Buffer.from(JSON.stringify(payload)).toString('base64url')}` : '';
  await page.goto(`${viewerOrigin}/pdf-viewer.html${q}`);
  await expect(page.getByTestId('pdf-viewer')).toBeVisible();
}

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('MCP App PDF viewer', () => {
  test.beforeAll(async () => {
    expect(fs.existsSync(VIEWER_HTML), `viewer not built: ${VIEWER_HTML} (npm run build:viewer -w apps/server)`).toBeTruthy();
    // the sandbox loads the whole resource on every conversation
    expect(fs.statSync(VIEWER_HTML).size).toBeLessThan(2.5 * 1024 * 1024);
    const bundle = await build({
      stdin: {
        contents: "import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'; window.__AldineHost = { AppBridge, PostMessageTransport };",
        resolveDir: path.resolve(__dirname, '..', '..'),
        loader: 'js',
      },
      bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
    });
    hostBundle = bundle.outputFiles[0].text;
    viewerServer = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/host.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(hostBundle); }
      if (url.startsWith('/host.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HOST_HTML); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(VIEWER_HTML));
    });
    await new Promise<void>((r) => viewerServer.listen(0, '127.0.0.1', r));
    viewerOrigin = `http://127.0.0.1:${(viewerServer.address() as AddressInfo).port}`;
  });
  test.afterAll(async () => {
    await new Promise<void>((r) => viewerServer?.close(() => r()));
  });

  test('renders a compiled PDF: status row, virtualized pages, nav, zoom, deep link, both themes', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Viewer OK');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: TWO_PAGES } });
      const compiled = await call(client, 'compile', { project: id });
      expect(compiled.isError).toBeFalsy();
      expect(compiled.body.ok).toBe(true);
      expect(compiled.body.pages).toBe(2);
      // the app hydrates from structuredContent; it must equal the text block
      expect(compiled.structuredContent).toEqual(compiled.body);

      await openViewer(page, compiled.structuredContent);
      const status = page.getByTestId('viewer-status');
      await expect(status).toContainText('main.pdf');
      await expect(status).toContainText('main');
      await expect(status).toContainText('typeset');
      await expect(status).toContainText('2 pages');
      await expect(page.getByTestId('viewer-errors')).toBeHidden();

      // page 1 is rasterized eagerly; page 2 gets a sized box up front
      const pages = page.getByTestId('viewer-page');
      await expect(pages).toHaveCount(2);
      expect((await pages.nth(1).boundingBox())!.height).toBeGreaterThan(100);
      await expect(pages.first().locator('canvas')).toHaveCount(1, { timeout: 30_000 });
      await expect(pages.first()).toHaveClass(/rendered/);
      const box = await pages.first().boundingBox();
      expect(box!.width).toBeGreaterThan(400);
      expect(box!.height).toBeGreaterThan(box!.width); // portrait A4/letter
      await expect(page.getByTestId('viewer-page-count')).toHaveText('1 / 2');

      // nav: buttons and keys
      await page.getByTestId('viewer-next').click();
      await expect(page.getByTestId('viewer-page-count')).toHaveText('2 / 2');
      await expect(pages.nth(1)).toHaveClass(/rendered/, { timeout: 30_000 });
      await expect(page.getByTestId('viewer-next')).toBeDisabled();
      await page.getByTestId('viewer-prev').click();
      await expect(page.getByTestId('viewer-page-count')).toHaveText('1 / 2');
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('viewer-page-count')).toHaveText('2 / 2');
      await page.keyboard.press('PageUp');
      await expect(page.getByTestId('viewer-page-count')).toHaveText('1 / 2');
      await page.keyboard.press('PageDown');
      await expect(page.getByTestId('viewer-page-count')).toHaveText('2 / 2');
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('viewer-page-count')).toHaveText('1 / 2');

      // zoom: 100% = fit width; + widens the page, − narrows it, the label resets it
      await expect(page.getByTestId('viewer-zoom')).toHaveText('100%');
      await page.getByTestId('viewer-zoom-in').click();
      await expect(page.getByTestId('viewer-zoom')).toHaveText('125%');
      const zoomed = await pages.first().boundingBox();
      expect(zoomed!.width).toBeGreaterThan(box!.width * 1.2);
      // the page is re-rasterized at the new width, not stretched
      await expect(pages.first()).toHaveClass(/rendered/, { timeout: 30_000 });
      expect(await pages.first().locator('canvas').evaluate((c: HTMLCanvasElement) => c.width / c.clientWidth)).toBeGreaterThanOrEqual(0.95);
      await page.getByTestId('viewer-zoom-out').click();
      await expect(page.getByTestId('viewer-zoom')).toHaveText('100%');
      await page.getByTestId('viewer-zoom-out').click();
      await expect(page.getByTestId('viewer-zoom')).toHaveText('75%');
      expect((await pages.first().boundingBox())!.width).toBeLessThan(box!.width * 0.8);
      await page.getByTestId('viewer-zoom').click();
      await expect(page.getByTestId('viewer-zoom')).toHaveText('100%');

      // exit
      const open = page.getByTestId('viewer-open');
      await expect(open).toBeVisible();
      await expect(open).toHaveAttribute('href', compiled.body.deepLink);
      await expect(open).toHaveAttribute('target', '_blank');

      // both color schemes: chrome follows the scheme, paper stays white
      await page.emulateMedia({ colorScheme: 'light' });
      const light = await bodyBg(page);
      await page.emulateMedia({ colorScheme: 'dark' });
      const dark = await bodyBg(page);
      expect(dark).not.toBe(light);
      await expect(pages.first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      // an explicit host theme beats the media query
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      expect(await bodyBg(page)).toBe(light);

      // compiling the unchanged document again is a success, not a "previous
      // PDF": latexmk skips the engine, the same link (same cache-buster,
      // same SyncTeX binding) comes back with its page count, and it renders
      const unchanged = await call(client, 'compile', { project: id });
      expect(unchanged.isError).toBeFalsy();
      expect(unchanged.body.ok).toBe(true);
      expect(unchanged.body.pdfStale).toBe(false);
      expect(unchanged.body.pages).toBe(2);
      expect(new URL(unchanged.body.pdfUrl).searchParams.get('t')).toBe(new URL(compiled.body.pdfUrl).searchParams.get('t'));
      await openViewer(page, unchanged.structuredContent);
      await expect(status).toContainText('2 pages');
      await expect(status).not.toContainText('previous PDF');
      await expect(page.getByTestId('viewer-notice')).not.toContainText('No PDF');
      await expect(page.getByTestId('viewer-page').first()).toHaveClass(/rendered/, { timeout: 30_000 });

      // a fresh link from get_pdf_url hydrates the same viewer over postMessage
      const again = await call(client, 'get_pdf_url', { project: id });
      expect(again.isError).toBeFalsy();
      await openViewer(page, null);
      await expect(status).toContainText('Waiting for the compile result');
      await page.evaluate((result) => window.postMessage({ type: 'aldine-pdf-viewer/tool-result', result }, '*'), again.structuredContent);
      await expect(status).toContainText('main.pdf');
      await expect(status).toContainText('2 pages');
      await expect(page.getByTestId('viewer-page').first()).toHaveClass(/rendered/, { timeout: 30_000 });

      // an expired / tampered link is an honest message, never a blank frame —
      // the 403 answers CORS, so the cross-origin viewer sees the status
      const tampered = { ...again.body, pdfUrl: String(again.body.pdfUrl).replace(/sig=[^&]+/, 'sig=AAAA') };
      await openViewer(page, tampered);
      await expect(page.getByTestId('viewer-notice')).toContainText('This PDF link has expired');
      await expect(page.getByTestId('viewer-notice')).toContainText('get_pdf_url');
      await expect(page.getByTestId('viewer-page')).toHaveCount(0);
      await expect(page.getByTestId('viewer-open')).toHaveAttribute('href', again.body.deepLink);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('errors but a complete PDF: the PDF renders with the amber strip open and file:line deep links', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Viewer Broken');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: BROKEN } });
      const compiled = await call(client, 'compile', { project: id });
      expect(compiled.isError).toBeFalsy();
      // Without stop-on-first-error TeX runs to the end: errors AND this run's PDF.
      expect(compiled.body.ok).toBe(false);
      expect(compiled.body.pdfStale).toBe(false);
      expect(typeof compiled.body.pdfUrl).toBe('string');
      expect(compiled.body.pages).toBe(2);
      const err = compiled.body.errors.find((e: any) => e.type === 'error' && typeof e.line === 'number');
      expect(err).toBeTruthy();

      await openViewer(page, compiled.structuredContent);
      const status = page.getByTestId('viewer-status');
      await expect(status).toContainText('main.pdf');
      await expect(status).toContainText(/\d+ errors?/);
      await expect(status).not.toContainText('Typesetting failed');
      await expect(status).toContainText('2 pages');
      const strip = page.getByTestId('viewer-errors');
      await expect(strip).toBeVisible();
      await expect(strip).toHaveAttribute('data-open', 'true'); // errors: rows shown, not collapsed
      await expect(strip).toContainText(/\d+ errors?/);
      const rows = page.getByTestId('viewer-error-row');
      expect(await rows.count()).toBeGreaterThanOrEqual(1);
      const row = rows.filter({ hasText: `main.tex:${err.line}` }).first();
      await expect(row).toBeVisible();
      const expectedHref = `${compiled.body.deepLink}?file=main.tex&line=${err.line}`;
      await expect(row.locator('a')).toHaveAttribute('href', expectedHref);
      await expect(row).toContainText(/undefined control sequence|thisisnotacommand/i);

      // the PDF this run wrote is on screen beneath the strip
      const pages = page.getByTestId('viewer-page');
      await expect(pages).toHaveCount(2);
      await expect(pages.first()).toHaveClass(/rendered/, { timeout: 30_000 });
      await expect(page.getByTestId('viewer-notice')).toBeHidden();
      await expect(page.getByTestId('viewer-page-count')).toHaveText('1 / 2');

      // collapsed on click, reopened on click
      await page.getByTestId('viewer-errors-toggle').click();
      await expect(strip).toHaveAttribute('data-open', 'false');
      await expect(row).toBeHidden();
      await page.getByTestId('viewer-errors-toggle').click();
      await expect(row).toBeVisible();

      // the exit lands on the first error
      await expect(page.getByTestId('viewer-open')).toHaveAttribute('href', expectedHref);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('no PDF from this run (stop-on-first-error): status, open strip, no canvas, the previous PDF on request', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Viewer Stale');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: TWO_PAGES } });
      const good = await call(client, 'compile', { project: id });
      expect(good.body.ok).toBe(true);
      const patched = await request.patch(`/api/projects/${id}`, { data: { stopOnFirstError: true } });
      expect(patched.ok()).toBeTruthy();
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: BROKEN } });
      const compiled = await call(client, 'compile', { project: id });
      expect(compiled.isError).toBeFalsy();
      expect(compiled.body.ok).toBe(false);
      expect(compiled.body.pdfStale).toBe(true);
      expect(typeof compiled.body.pdfUrl).toBe('string');
      const err = compiled.body.errors.find((e: any) => e.type === 'error' && typeof e.line === 'number');
      expect(err).toBeTruthy();

      await openViewer(page, compiled.structuredContent);
      const status = page.getByTestId('viewer-status');
      await expect(status).toContainText('Typesetting failed');
      await expect(status).toContainText('previous PDF');
      await expect(status).not.toContainText(/\d+ pages?/);
      const strip = page.getByTestId('viewer-errors');
      await expect(strip).toBeVisible();
      await expect(strip).toHaveAttribute('data-open', 'true');
      const expectedHref = `${compiled.body.deepLink}?file=main.tex&line=${err.line}`;
      await expect(page.getByTestId('viewer-error-row').first().locator('a')).toHaveAttribute('href', expectedHref);

      // no canvas, an explanatory notice, and the exit lands on the first error
      await expect(page.getByTestId('viewer-page')).toHaveCount(0);
      await expect(page.getByTestId('viewer-pages')).toBeHidden();
      const notice = page.getByTestId('viewer-notice');
      await expect(notice).toContainText('No PDF from this run');
      await expect(page.getByTestId('viewer-open')).toHaveAttribute('href', expectedHref);
      await expect(page.getByTestId('viewer-next')).toBeDisabled();

      // the earlier typeset is one click away and stays labelled as such
      await notice.getByText('Show the previous PDF').click();
      await expect(page.getByTestId('viewer-page').first()).toHaveClass(/rendered/, { timeout: 30_000 });
      await expect(page.getByTestId('viewer-page-count')).toHaveText('1 / 2');
      await expect(status).toContainText('previous PDF');
      await expect(status).toContainText('2 pages');
      await expect(strip).toBeVisible();

      // an error AFTER the first shipout: the engine removes the PDF it had
      // begun, so there is no previous PDF to offer — no link, no dead click
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: BROKEN_LATE } });
      const late = await call(client, 'compile', { project: id });
      expect(late.isError).toBeFalsy();
      expect(late.body.ok).toBe(false);
      expect(late.body.pdfStale).toBe(true);
      expect(late.body.pdfUrl).toBeNull();
      expect(late.body.typesetAt).toBeNull();
      await openViewer(page, late.structuredContent);
      await expect(notice).toContainText('No PDF from this run');
      await expect(notice.getByText('Show the previous PDF')).toHaveCount(0);
      await expect(page.getByTestId('viewer-page')).toHaveCount(0);
      await expect(status).not.toContainText('previous PDF');
      const gone = await call(client, 'get_pdf_url', { project: id });
      expect(gone.isError).toBe(true);
      expect((gone.raw.content as Array<{ text: string }>)[0].text).toMatch(/compile/);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('warnings only: the strip is present but collapsed, the PDF renders', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Viewer Warnings');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: WARNINGS } });
      const compiled = await call(client, 'compile', { project: id });
      expect(compiled.isError).toBeFalsy();
      expect(compiled.body.ok).toBe(true);
      expect(compiled.body.errors.some((e: any) => e.type === 'warning')).toBeTruthy();
      expect(compiled.body.errors.some((e: any) => e.type === 'typesetting' || /Overfull/.test(e.message))).toBeFalsy();

      await openViewer(page, compiled.structuredContent);
      const strip = page.getByTestId('viewer-errors');
      await expect(strip).toBeVisible();
      await expect(strip).toHaveAttribute('data-open', 'false');
      await expect(strip).toContainText(/\d+ warnings?/);
      await expect(strip.locator('.errors-summary')).not.toContainText(/error/);
      await expect(page.getByTestId('viewer-status')).not.toContainText(/errors?|failed/);
      await expect(page.getByTestId('viewer-page').first()).toHaveClass(/rendered/, { timeout: 30_000 });
      await page.getByTestId('viewer-errors-toggle').click();
      await expect(strip).toHaveAttribute('data-open', 'true');
      await expect(page.getByTestId('viewer-error-row').first()).toContainText(/undefined|Citation/i);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('host bridge: ui/initialize context, tool-result hydration, ui/open-link and display mode', async ({ page, request, context }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Viewer Host');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: BROKEN } });
      const compiled = await call(client, 'compile', { project: id });
      expect(compiled.body.ok).toBe(false);
      const err = compiled.body.errors.find((e: any) => e.type === 'error' && typeof e.line === 'number');

      await page.goto(`${viewerOrigin}/host.html`);
      await expect.poll(() => page.evaluate(() => (window as any).__events as string[]), { timeout: 20_000 }).toContain('initialized');
      const frame = page.frameLocator('#app');
      const viewer = frame.getByTestId('pdf-viewer');
      await expect(viewer).toBeVisible();
      // host context: theme and display modes arrive with the handshake
      await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(frame.locator('html')).toHaveAttribute('data-display', 'inline');
      await expect(frame.getByTestId('viewer-expand')).toBeVisible();
      await expect(frame.getByTestId('viewer-status')).toContainText('Waiting for the compile result');

      // ui/notifications/tool-result hydrates the viewer
      await page.evaluate((result) => (window as any).__bridge.sendToolResult(result), {
        content: compiled.raw.content, structuredContent: compiled.raw.structuredContent,
      });
      await expect(frame.getByTestId('viewer-status')).toContainText('main.pdf');
      await expect(frame.getByTestId('viewer-errors')).toHaveAttribute('data-open', 'true');
      await expect(frame.getByTestId('viewer-page').first()).toHaveClass(/rendered/, { timeout: 30_000 });

      // an error row leaves through ui/open-link — no navigation, no popup
      const expectedHref = `${compiled.body.deepLink}?file=main.tex&line=${err.line}`;
      const before = context.pages().length;
      await frame.getByTestId('viewer-error-row').first().locator('a').click();
      await expect.poll(() => page.evaluate(() => (window as any).__opened as string[])).toContain(expectedHref);
      expect(page.url()).toBe(`${viewerOrigin}/host.html`);
      expect(context.pages().length).toBe(before);
      await frame.getByTestId('viewer-open').click();
      await expect.poll(() => page.evaluate(() => (window as any).__opened.length)).toBe(2);

      // fullscreen is negotiated with the host
      await frame.getByTestId('viewer-expand').click();
      await expect.poll(() => page.evaluate(() => (window as any).__events as string[])).toContain('display:fullscreen');
      await expect(frame.locator('html')).toHaveAttribute('data-display', 'fullscreen');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('deep link (§3.3): ?file=&line= opens the file at the line, flashes it, drops the params', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Viewer Deep Link');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: BROKEN } });
      const intro = Array.from({ length: 80 }, (_, i) => (i === 59 ? 'Line sixty is the deep-link target.' : `Filler line ${i + 1}.`)).join('\n') + '\n';
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'notes/intro.tex', content: intro } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'drafts/intro.tex', content: 'Another intro.\n' } });
      const compiled = await call(client, 'compile', { project: id });
      expect(compiled.body.ok).toBe(false);
      const err = compiled.body.errors.find((e: any) => e.type === 'error' && typeof e.line === 'number');
      expect(err).toBeTruthy();

      // The viewer's click-through, followed in the app (same tab: the
      // sandboxed iframe opens it via the host, which is not under test here).
      await openViewer(page, compiled.structuredContent);
      const href = await page.getByTestId('viewer-error-row').first().locator('a').getAttribute('href');
      expect(href).toBe(`${compiled.body.deepLink}?file=main.tex&line=${err.line}`);
      await page.goto(href!);
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      await expect(page.getByTestId('file-main.tex')).toHaveClass(/tree__item--active/);
      const flash = page.getByTestId('deeplink-flash');
      await expect(flash).toBeVisible({ timeout: 15_000 });
      await expect(flash).toContainText('thisisnotacommand');
      await expect(flash).toBeInViewport();
      await expect(page.locator('.cm-activeLine')).toContainText('thisisnotacommand');
      await expect.poll(() => new URL(page.url()).search).toBe('');
      expect(new URL(page.url()).pathname).toBe(`/p/${id}`);
      await expect(flash).toHaveCount(0, { timeout: 10_000 }); // one-shot

      // A file in a subdirectory, spelled the way TeX reports it, far enough
      // down that the editor has to scroll; the branch param survives.
      await page.goto(`/p/${id}?branch=main&file=${encodeURIComponent('./notes/intro.tex')}&line=60`);
      await expect(page.getByTestId('file-notes/intro.tex')).toHaveClass(/tree__item--active/);
      await expect(page.getByTestId('deeplink-flash')).toContainText('Line sixty is the deep-link target', { timeout: 15_000 });
      await expect(page.getByTestId('deeplink-flash')).toBeInViewport();
      await expect.poll(() => new URL(page.url()).search).toBe('?branch=main');

      // A bare name two files share is ambiguous: say so instead of guessing.
      await page.goto(`/p/${id}?file=intro.tex&line=2`);
      await expect(page.locator('.toast')).toContainText('"intro.tex" matches 2 files');
      await expect(page.getByTestId('file-main.tex')).toHaveClass(/tree__item--active/);

      // A directory is never opened as a file.
      await page.goto(`/p/${id}?file=notes&line=2`);
      await expect(page.locator('.toast')).toContainText('"notes" is not in this project');
      await expect(page.getByTestId('file-main.tex')).toHaveClass(/tree__item--active/);

      // A file that is not in the project: say so, land on the root file, no crash.
      await page.goto(`/p/${id}?file=missing/chapter.tex&line=2`);
      await expect(page.locator('.toast')).toContainText('"missing/chapter.tex" is not in this project');
      await expect(page.getByTestId('file-main.tex')).toHaveClass(/tree__item--active/);
      await expect(page.locator('.cm-content')).toBeVisible();
      await expect.poll(() => new URL(page.url()).search).toBe('');

      // A reload after the jump does not replay it: nothing flashes.
      await page.reload();
      await expect(page.locator('.cm-content')).toBeVisible();
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('deeplink-flash')).toHaveCount(0);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });
});
