import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

/**
 * Format document: the command palette entry and Shift+Alt+F run latexindent
 * on the compile service over the open file, the indentation lands as one
 * undo step, a second run says it is already formatted, and a file
 * latexindent does not format is refused with the reason.
 *
 * Needs a compiler with latexindent (the published images have it; a
 * BasicTeX checkout does not): without one the test is skipped, saying so.
 */

const MESSY = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\begin{itemize}',
  '\\item First point',
  '\\begin{enumerate}',
  '\\item Nested point',
  '\\end{enumerate}',
  '\\end{itemize}',
  '\\begin{verbatim}',
  'kept   as   typed',
  '\\end{verbatim}',
  '\\end{document}',
  '',
].join('\n');

const put = (request: APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
const fileText = async (request: APIRequestContext, id: string, path: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();
/** The editor's lines as CodeMirror holds them, whitespace included. */
const editorLines = (page: Page) => page.locator('.cm-content .cm-line').evaluateAll((ls) => ls.map((l) => l.textContent ?? ''));
const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text });

async function runFromPalette(page: Page) {
  await page.getByTestId('palette-open').click();
  await page.getByTestId('palette-input').fill('format document');
  await page.getByTestId('palette-item-format-document').click();
}

test.describe('format document', () => {
  test('indents the open file from the palette and Shift+Alt+F, undoes in one step, and refuses a .bib', async ({ page, request }) => {
    const id = await createProject(request, 'Format Document');
    try {
      const probe = await request.post(`/api/projects/${id}/format`, { data: { branch: 'main', path: 'probe.tex', text: '\\item x\n', indent: '  ' } });
      const probed = await probe.json();
      test.skip(probe.status() === 503 && probed.reason === 'unavailable', `the compiler has no latexindent: ${probed.error}`);
      expect(probe.ok(), JSON.stringify(probed)).toBeTruthy();

      expect((await put(request, id, 'main.tex', MESSY)).ok()).toBeTruthy();
      expect((await put(request, id, 'refs.bib', '@article{a,\ntitle={T}}\n')).ok()).toBeTruthy();
      await openProject(page, id);
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      await expect(page.locator('.cm-content')).toContainText('Nested point');
      expect((await editorLines(page)).join('\n')).toBe(MESSY);

      await runFromPalette(page);
      await expect(toast(page, 'Formatted main.tex with latexindent')).toBeVisible();
      const formatted = await editorLines(page);
      expect(formatted).toHaveLength(MESSY.split('\n').length);
      const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
      const line = (text: string) => formatted.find((l) => l.trim() === text)!;
      expect(line('\\item First point')).toMatch(/^ {2}\\item/);
      expect(indentOf(line('\\begin{enumerate}'))).toBeGreaterThan(indentOf(line('\\item First point')));
      expect(indentOf(line('\\item Nested point'))).toBeGreaterThan(indentOf(line('\\begin{enumerate}')));
      expect(line('\\begin{itemize}')).toBe('\\begin{itemize}');
      expect(formatted).toContain('kept   as   typed');
      // the formatted text is what autosave writes
      await expect.poll(() => fileText(request, id, 'main.tex'), { timeout: 15_000 }).toBe(formatted.join('\n'));

      await runFromPalette(page);
      await expect(toast(page, 'Already formatted')).toBeVisible();

      // one undo step takes the whole formatting back
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => (await editorLines(page)).join('\n')).toBe(MESSY);
      await expect.poll(() => fileText(request, id, 'main.tex'), { timeout: 15_000 }).toBe(MESSY);

      // the keys, in the text
      await page.keyboard.press('Shift+Alt+KeyF');
      await expect.poll(async () => (await editorLines(page)).join('\n')).toBe(formatted.join('\n'));

      await page.getByTestId('file-refs.bib').click();
      await expect(page.getByTestId('active-file')).toHaveText('refs.bib');
      await runFromPalette(page);
      await expect(toast(page, 'Format document works on .tex, .sty and .cls files; latexindent can’t format refs.bib')).toBeVisible();
      expect(await fileText(request, id, 'refs.bib')).toBe('@article{a,\ntitle={T}}\n');
    } finally {
      await cleanup(request, id);
    }
  });
});
