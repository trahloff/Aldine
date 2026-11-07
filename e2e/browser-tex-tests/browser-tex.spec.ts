import { test as base, expect } from '../fixtures';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { createPaperProject, openProject, typeset, expectTypesetOk, typeAtEnd, cleanup } from '../tests/helpers';

/**
 * ALDINE_TYPESET=browser end to end, in a real browser running TeX Live as
 * WebAssembly: typesets happen in the tab and never reach POST /compile;
 * TikZ, which the suite's profile lacks, comes from on-demand packages; the
 * runs a tab publishes feed the project list, tabs without TeX and API
 * callers; SyncTeX works on a PDF that never left the tab.
 */

const BASE = process.env.ALDINE_BROWSER_TEX_URL || `http://localhost:${process.env.E2E_BROWSER_TEX_PORT || 3410}`;

/** One browser context for the whole run: its pages share the HTTP cache and
 *  IndexedDB, so TeX is downloaded once rather than once per test (a fresh
 *  context per test would spend most of the suite on the same 160 MB). */
const test = base.extend<object, { texContext: BrowserContext }>({
  texContext: [async ({ browser }, use) => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    await use(ctx);
    await ctx.close();
  }, { scope: 'worker' }],
  page: async ({ texContext }, use) => {
    const page = await texContext.newPage();
    await use(page);
    await page.close();
  },
});

/** Waits until the server has the branch's PDF from a published run. */
async function published(request: APIRequestContext, id: string, after = 0): Promise<{ runId: number; pdfUrl: string }> {
  let last: { runId: number; pdfUrl: string } | null = null;
  await expect.poll(async () => {
    const st = await (await request.get(`/api/projects/${id}/compile-status?branch=main`)).json();
    last = st.result?.ok && st.result.runId > after ? st.result : null;
    return !!last;
  }, { timeout: 60_000 }).toBe(true);
  return last!;
}

function watchRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
  return seen;
}

test.describe('typesetting in the browser', () => {
  test('typesets in the tab, fetching packages its profile lacks', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Browser TeX');
    const seen = watchRequests(page);
    try {
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page, 150_000);
      expect(await page.locator('canvas.pdf-page').count()).toBeGreaterThanOrEqual(2);
      expect(seen.filter((r) => r === `POST /api/projects/${id}/compile`)).toEqual([]);
      expect(seen.some((r) => r.startsWith('GET /browser-tex/') && r.endsWith('/busytex.wasm'))).toBe(true);
      // tikz.sty is not in the basic profile: kpathsea asked the server for it.
      expect(seen.some((r) => /^GET \/api\/texlive\/\d+\/tikz\.sty$/.test(r))).toBe(true);
      await expect(page.getByTestId('pdf-status')).toContainText(/Typeset in \d+(\.\d+)?s/);
    } finally {
      await cleanup(request, id);
    }
  });

  test('publishes runs for the project list, thinned out', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Browser TeX Publish');
    const seen = watchRequests(page);
    try {
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page, 150_000);
      const run = await published(request, id);
      expect((await request.get(run.pdfUrl)).headers()['content-type']).toContain('pdf');
      const list = await (await request.get('/api/projects')).json();
      await expect.poll(async () => (await (await request.get('/api/projects')).json()).find((p: { id: string }) => p.id === id)?.thumb ?? null, { timeout: 30_000 }).not.toBeNull();
      expect(Array.isArray(list)).toBe(true);
      // Two more typesets of the same text: no second upload of the same PDF.
      const uploads = () => seen.filter((r) => r === `POST /api/projects/${id}/compile/publish`).length;
      const before = uploads();
      await typeset(page);
      await expectTypesetOk(page);
      await page.waitForTimeout(12_000);
      expect(uploads()).toBe(before);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a tab without TeX follows the PDF the others publish', async ({ browser, page, request }) => {
    const id = await createPaperProject(request, 'Browser TeX Follow');
    const phone = await browser.newPage();
    await phone.addInitScript(() => window.localStorage.setItem('aldine.browserTex', 'off'));
    const phoneSeen = watchRequests(phone);
    try {
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page, 150_000);
      const first = await published(request, id);
      await openProject(phone, id);
      await expect(phone.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 30_000 });
      expect(phoneSeen.some((r) => r.startsWith('GET /browser-tex/'))).toBe(false);
      // An edit in the TeX tab reaches the other tab as a newer published PDF.
      await typeAtEnd(page, '\nA sentence typed after the first typeset.');
      const second = await published(request, id, first.runId);
      await expect.poll(async () => phone.evaluate(() => document.querySelectorAll('canvas.pdf-page').length), { timeout: 30_000 }).toBeGreaterThan(0);
      expect(second.runId).toBeGreaterThan(first.runId);
    } finally {
      await phone.close();
      await cleanup(request, id);
    }
  });

  test('an API caller\'s typeset is run by an open tab', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Browser TeX API');
    try {
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page, 150_000);
      const res = await request.post(`/api/projects/${id}/compile`, { data: { branch: 'main' }, timeout: 120_000 });
      const body = await res.json();
      expect(body.ok, body.error).toBe(true);
      expect(body.pdfUrl).toContain('/output?');
    } finally {
      await cleanup(request, id);
    }
  });

  test('venue templates are offered, and one whose class is not in the profile typesets', async ({ page, request }) => {
    const templates: Array<{ id: string }> = await (await request.get('/api/templates')).json();
    const venues = templates.map((t) => t.id).filter((id) => id.startsWith('venue:'));
    expect(venues).toEqual(expect.arrayContaining(['venue:revtex', 'venue:elsarticle', 'venue:ieeetran', 'venue:acmart']));
    const res = await request.post('/api/projects', { data: { name: 'Browser TeX REVTeX', template: 'venue:revtex' } });
    expect(res.ok(), await res.text()).toBe(true);
    const { id } = await res.json();
    const seen = watchRequests(page);
    try {
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page, 150_000);
      // revtex4-2.cls is not in the basic profile: it came on demand.
      expect(seen.some((r) => /^GET \/api\/texlive\/\d+\/revtex4-2\.cls$/.test(r))).toBe(true);
    } finally {
      await cleanup(request, id);
    }
  });

  test('with no tab open, an API caller is told to open one', async ({ request }) => {
    const id = await createPaperProject(request, 'Browser TeX No Tab');
    try {
      const body = await (await request.post(`/api/projects/${id}/compile`, { data: { branch: 'main' }, timeout: 60_000 })).json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/Open the project in a browser/);
    } finally {
      await cleanup(request, id);
    }
  });
});
