import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { createProject, openProject, cleanup, expectTypesetOk, typeset } from './helpers';

/** Tests that count typesets, or need the project untypeset, turn auto-typeset off before the page loads. */
const withoutAutoTypeset = (page: Page) => page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
const doc = (...body: string[]) => ['\\documentclass{article}', '\\begin{document}', ...body, '\\end{document}', ''].join('\n');
const put = (request: import('@playwright/test').APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
/** Type at the end of the line holding `text`, where TeX still reads it. */
async function typeOnLine(page: Page, text: string, typed: string) {
  await page.locator('.cm-line', { hasText: text }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
  await page.keyboard.press('Escape');
}

test.describe('the PDF preview across typesets', () => {
  test('Download sits beside the PDF and waits for one', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Download');
    try {
      await put(request, id, 'main.tex', doc('Some text.'));
      await withoutAutoTypeset(page);
      await openProject(page, id);
      const download = page.getByTestId('pdf-download');
      await expect(download).toBeDisabled();
      await typeset(page);
      await expectTypesetOk(page);
      await expect(download).toHaveAttribute('href', /\/api\/projects\/.+\/output\?.*path=.*main\.pdf/);
      const file = page.waitForEvent('download');
      await download.click();
      expect((await file).suggestedFilename()).toBe('Pane Download.pdf');
    } finally { await cleanup(request, id); }
  });

  test('errors auto-typeset finds while you type fold to one line; Typeset or a repeat opens them', async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await createProject(request, 'Pane Fold');
    try {
      await put(request, id, 'main.tex', doc('Some text.', '', 'More text.'));
      await openProject(page, id);
      await expectTypesetOk(page);
      const panel = page.getByTestId('errors-panel');
      const toggle = page.getByTestId('errors-toggle');

      // an auto-typeset run with a new error: the header only, the editor keeps its room
      await typeOnLine(page, 'Some text.', ' \\nosuchmacro');
      await expect(page.getByTestId('pdf-status')).toContainText('1 error', { timeout: 60_000 });
      await expect(panel).toHaveAttribute('data-open', 'false');
      await expect(toggle).toHaveText('1 error');
      expect((await panel.boundingBox())!.height).toBeLessThan(40);

      // the same error on the next run is no half-typed command any more
      await typeOnLine(page, 'More text.', ' and on');
      await expect(panel).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
      await expect(panel.locator('.errors__row').first()).toContainText(/Undefined control sequence/);

      // folding it is the person's call until they typeset
      await toggle.click();
      await expect(panel).toHaveAttribute('data-open', 'false');
      await typeset(page);
      await expect(panel).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
    } finally { await cleanup(request, id); }
  });

  test('bad boxes fold into a Layout group whose rows open their line', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Layout');
    try {
      await put(request, id, 'main.tex', doc('A claim \\cite{nobody2020}.', '', '\\noindent\\hbox to 2cm{This sentence is far too wide for its little box}', ''));
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page);

      await page.getByTestId('problems-toggle').click();
      await expect(page.getByTestId('problem-warning').filter({ hasText: 'nobody2020' })).toHaveCount(1);
      const group = page.getByTestId('layout-toggle');
      await expect(group).toHaveText('Layout (1)');
      await expect(group).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('problem-layout')).toHaveCount(0);
      await group.click();
      const box = page.getByTestId('problem-layout');
      await expect(box).toContainText(/Overfull \\hbox/);
      await expect(box).toContainText('main.tex · line 5');
      await box.click();
      await expect(page.locator('.cm-activeLine')).toContainText('far too wide');
    } finally { await cleanup(request, id); }
  });

  test('a document whose only problems are bad boxes says Layout (N)', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Layout Only');
    try {
      await put(request, id, 'main.tex', doc('\\noindent\\hbox to 1cm{Too wide by far for this}'));
      await page.addInitScript(() => window.localStorage.removeItem('aldine.layoutOpen'));
      await openProject(page, id);
      await expectTypesetOk(page);
      const toggle = page.getByTestId('problems-toggle');
      await expect(toggle).toHaveText('Layout (1)');
      await expect(page.getByTestId('errors-panel')).toHaveAttribute('data-open', 'false');
      await toggle.click();
      await expect(page.getByTestId('problem-layout')).toHaveCount(1);
    } finally { await cleanup(request, id); }
  });

  test('a warning in an \\input file opens that file at its line', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Warning File');
    try {
      await put(request, id, 'chapters/one.tex', 'Chapter text.\n\nHere we cite \\cite{ghost2001} for once.\n');
      await put(request, id, 'main.tex', doc('See \\ref{nowhere}.', '\\input{chapters/one}'));
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page);
      await page.getByTestId('problems-toggle').click();
      const row = page.getByTestId('problem-warning').filter({ hasText: 'ghost2001' });
      await expect(row).toContainText('chapters/one.tex · line 3');
      await row.locator('button.errors__jump').click();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/one.tex');
      await expect(page.locator('.cm-activeLine')).toContainText('ghost2001');
      // the one in main.tex goes there
      await page.getByTestId('problem-warning').filter({ hasText: 'nowhere' }).locator('button.errors__jump').click();
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      await expect(page.locator('.cm-activeLine')).toContainText('nowhere');
    } finally { await cleanup(request, id); }
  });

  test('Stop ends a runaway typeset', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Stop');
    try {
      await put(request, id, 'main.tex', doc('Before.', '\\def\\spin{\\spin}\\spin', 'After.'));
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await typeset(page);
      await expect(page.getByTestId('typeset-button')).toBeDisabled();
      const stop = page.getByTestId('typeset-stop');
      await expect(stop).toBeVisible({ timeout: 10_000 });
      const started = Date.now();
      await stop.click();
      await expect(page.getByTestId('pdf-status')).toContainText('Stopped', { timeout: 15_000 });
      expect(Date.now() - started).toBeLessThan(15_000);
      await expect(page.getByTestId('typeset-button')).toBeEnabled();
      await expect(stop).toHaveCount(0);
      await expect(page.getByTestId('pdf-notice')).toHaveText('Typesetting was stopped.');
      await expect(page.getByTestId('errors-panel')).toHaveCount(0);
      // the branch remembers the stopped run, for the co-authors who adopt it
      const status = await (await request.get(`/api/projects/${id}/compile-status?branch=main`)).json();
      expect(status.running).toBe(false);
      expect(status.result.stopped).toBe(true);
    } finally { await cleanup(request, id); }
  });

  test('a typeset that cannot reach the compiler says so once, with Try again', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Compiler Down');
    const sentence = 'The typesetting service isn’t answering. Try again in a moment; if it keeps happening, ask whoever runs this server to check the compiler.';
    try {
      await put(request, id, 'main.tex', doc('Some text.'));
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await page.route('**/api/projects/*/compile', (route) => route.fulfill({ status: 503, json: { ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: sentence } }));
      await typeset(page);
      await expect(page.getByTestId('pdf-notice')).toHaveText(sentence);
      await typeset(page);
      await expect(page.locator('.toast').filter({ hasText: 'isn’t answering' })).toHaveCount(1);
      await expect(page.locator('.toast').filter({ hasText: 'fetch failed' })).toHaveCount(0);
      await page.unroute('**/api/projects/*/compile');
      await page.getByTestId('pdf-retry').click();
      await expectTypesetOk(page);
      await expect(page.locator('.toast').filter({ hasText: 'isn’t answering' })).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('a run that left no PDF and named no error offers its log', async ({ page, request }) => {
    const id = await createProject(request, 'Pane No PDF');
    try {
      await put(request, id, 'main.tex', doc('Some text.'));
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await page.route('**/api/projects/*/compile', (route) => route.fulfill({ json: { ok: false, pdf: null, pdfUrl: null, log: 'Latexmk: gave up on the engine', errors: [], durationMs: 5, runId: Date.now() } }));
      await typeset(page);
      await expect(page.getByTestId('pdf-notice')).toContainText('open the log');
      await page.getByTestId('pdf-view-log').click();
      await expect(page.getByTestId('log-view')).toContainText('gave up on the engine');
    } finally { await cleanup(request, id); }
  });

  test('opening a project shows its last PDF at once, marked out of date', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Last PDF');
    try {
      await put(request, id, 'main.tex', doc('Some text for the last PDF.'));
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page);

      let compiles = 0;
      page.on('request', (r) => { if (r.method() === 'POST' && /\/compile$/.test(r.url())) compiles++; });
      // The project answers slowly; the file listing is asked for meanwhile.
      const asked: string[] = [];
      await page.route(new RegExp(`/api/projects/${id}(\\?|$)`), async (route) => {
        asked.push('project');
        await new Promise((r) => setTimeout(r, 800));
        asked.push('project answered');
        await route.continue();
      });
      page.on('request', (r) => { if (r.url().includes(`/api/projects/${id}/files`)) asked.push('files'); });
      await page.reload();
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 20_000 });
      expect(asked.indexOf('files')).toBeGreaterThan(-1);
      expect(asked.indexOf('files')).toBeLessThan(asked.indexOf('project answered'));
      await expect(page.getByTestId('pdf-stale')).toContainText('Out of date');
      await expect(page.getByTestId('pdf-status')).toContainText('Out of date');
      expect(compiles).toBe(0);

      await typeset(page);
      await expectTypesetOk(page);
      await expect(page.getByTestId('pdf-stale')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('a co-author’s preview follows the typesets someone else makes', async ({ browser, request }) => {
    test.setTimeout(180_000);
    const id = await createProject(request, 'Pane Follow');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await put(request, id, 'main.tex', doc('Shared text.'));
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await openProject(a, id);
      await expectTypesetOk(a);
      await openProject(b, id);
      await expectTypesetOk(b);
      const before = await b.getByTestId('preview').getAttribute('data-pdf');
      let bCompiles = 0;
      b.on('request', (r) => { if (r.method() === 'POST' && /\/compile$/.test(r.url())) bCompiles++; });

      await typeOnLine(a, 'Shared text.', ' FROM-ADA');
      await expect(b.locator('.cm-content')).toContainText('FROM-ADA', { timeout: 10_000 });
      await expect.poll(() => b.getByTestId('preview').getAttribute('data-pdf'), { timeout: 60_000 }).not.toBe(before);
      await expect.poll(() => a.getByTestId('preview').getAttribute('data-pdf')).toBe(await b.getByTestId('preview').getAttribute('data-pdf'));
      expect(bCompiles).toBe(0);
      await expect(b.getByTestId('pdf-status')).toContainText('Typeset in');
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });
});
