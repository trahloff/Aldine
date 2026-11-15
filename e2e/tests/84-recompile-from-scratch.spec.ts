import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

/**
 * Typeset from scratch (#309): a document whose own source is fine but
 * whose generated files from an earlier run break every typeset recovers
 * from the Typeset button's menu, and again from the command palette, and
 * the sources stay as they were.
 *
 * The stale state is real: the first version, which has no pages yet,
 * writes \@@end into its .aux, so every later run stops while reading that
 * .aux at \begin{document}, before LaTeX rewrites it, and no PDF is ever
 * made. latexmk keeps failing after the line is gone from the source; only
 * deleting .aldine-out fixes it.
 */

const POISONED = [
  '\\documentclass{article}',
  '\\makeatletter\\AtEndDocument{\\immediate\\write\\@mainaux{\\string\\@@end}}\\makeatother',
  '\\begin{document}',
  '\\end{document}',
  '',
].join('\n');
const FIXED = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Fresh start.',
  '\\end{document}',
  '',
].join('\n');

const put = (request: APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
const fileText = async (request: APIRequestContext, id: string, path: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();
const cleanRun = (page: Page) => page.waitForResponse((r) => r.url().includes('/compile') && r.request().method() === 'POST' && r.request().postDataJSON()?.clean === true, { timeout: 150_000 });
const typesetApi = async (request: APIRequestContext, id: string) =>
  (await request.post(`/api/projects/${id}/compile`, { data: { branch: 'main' }, timeout: 150_000 })).json();

test.describe('typeset from scratch', () => {
  test('clears stale build files from the Typeset menu and the palette, keeping the sources', async ({ page, request }) => {
    test.setTimeout(300_000);
    const id = await createProject(request, 'Recompile From Scratch');
    try {
      expect((await put(request, id, 'main.tex', POISONED)).ok()).toBeTruthy();
      await typesetApi(request, id);
      expect((await put(request, id, 'main.tex', FIXED)).ok()).toBeTruthy();
      const stale = await typesetApi(request, id);
      expect(stale.ok, 'the stale .aux still breaks a plain typeset of the fixed source').toBe(false);

      await openProject(page, id);
      await expect(page.getByTestId('pdf-status')).toContainText(/error|Failed/, { timeout: 120_000 });

      await page.getByTestId('typeset-options').click();
      const menu = page.getByTestId('typeset-options-menu');
      await expect(menu).toBeVisible();
      await expect(menu).toContainText('never your sources');
      const fromMenu = cleanRun(page);
      await page.getByTestId('typeset-clean').click();
      expect((await (await fromMenu).json()).ok, 'the clean run succeeds').toBe(true);
      await expectTypesetOk(page);
      await expect(page.getByTestId('pdf-status')).not.toContainText(/error|Failed/);
      expect(await fileText(request, id, 'main.tex')).toBe(FIXED);

      // A plain typeset now passes too: the stale files are gone for good.
      expect((await typesetApi(request, id)).ok).toBe(true);

      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('typeset from scratch');
      const fromPalette = cleanRun(page);
      await page.getByTestId('palette-item-typeset-clean').click();
      expect((await (await fromPalette).json()).ok, 'the palette asks for a clean run too').toBe(true);
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });
      expect(await fileText(request, id, 'main.tex')).toBe(FIXED);
    } finally {
      await cleanup(request, id);
    }
  });
});
