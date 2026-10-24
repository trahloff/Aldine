import { test, expect } from '../fixtures';
import type { Browser, Page, APIRequestContext } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

// A file with Windows line endings. Editors count "\r\n" as one character, so
// a shared text holding the CRs put every edit one character to the left per
// line above it, and the stored file and the other editor no longer matched
// what the typist saw.

const CRLF = '\\section{One}\r\nline two\r\nline three\r\nline four\r\nplain end\r\n';

async function peer(browser: Browser, name: string) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((n) => {
    window.localStorage.setItem('aldine.onboarded', '1');
    window.localStorage.setItem('aldine.editorMode', 'source');
    window.localStorage.setItem('aldine.name', n);
  }, name);
  return { ctx, page: await ctx.newPage() };
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

/** The editor's lines without collaborators' caret labels. */
const shownLines = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((line) => {
  const copy = line.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.cm-ySelectionCaret').forEach((e) => e.remove());
  return copy.textContent ?? '';
}));

async function typeAtEndOf(page: Page, line: string, text: string) {
  await page.locator('.cm-line', { hasText: line }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

test.describe('files with CRLF line endings', () => {
  test('edits land where they are typed, for every editor and in the stored file', async ({ browser, request }) => {
    const id = await createProject(request, 'CRLF endings');
    const put = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: CRLF } });
    expect(put.ok()).toBeTruthy();
    const A = await peer(browser, 'Ada');
    const B = await peer(browser, 'Grace');
    try {
      await openProject(A.page, id);
      await typeAtEndOf(A.page, 'line four', 'XYZ');
      const first = CRLF.replace('line four', 'line fourXYZ');
      // the file keeps its CRLF line endings
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toBe(first);

      await openProject(B.page, id);
      await expect(B.page.locator('.cm-content')).toContainText('line fourXYZ');
      expect(await shownLines(B.page)).toEqual(first.split('\r\n'));

      await typeAtEndOf(B.page, 'line two', '!');
      const second = first.replace('line two', 'line two!');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toBe(second);
      await expect(A.page.locator('.cm-content')).toContainText('line two!');
      await expect.poll(() => shownLines(A.page)).toEqual(second.split('\r\n'));

      await A.page.reload();
      await expect(A.page.locator('.cm-content')).toContainText('line two!');
      expect(await shownLines(A.page)).toEqual(second.split('\r\n'));
      expect(await stored(request, id)).toBe(second);
    } finally {
      await A.ctx.close();
      await B.ctx.close();
      await cleanup(request, id);
    }
  });
});
