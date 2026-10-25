import { test, expect } from '../fixtures';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { createProject, openProject, typeAtEnd, cleanup, openSidebarTab } from './helpers';

/**
 * Search and replace across a project (#112): every text file on the
 * branch, open or not, with match case, whole word and regular expressions;
 * Replace changes a document someone has open in front of them and lands as
 * one commit under the person who replaced.
 */

const put = (request: APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });

const fileText = async (request: APIRequestContext, id: string, path: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();

const log = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/projects/${id}/log?branch=main`)).json()) as Array<{ hash: string; message: string; author: string }>;

const occurrences = (s: string, word: string) => s.split(word).length - 1;

const fileRow = (page: Page, path: string) => page.locator(`[data-testid="search-file"][data-path="${path}"]`);
const count = (page: Page, path: string) => fileRow(page, path).getByTestId('search-file-count');

async function asWriter(ctx: BrowserContext, name: string, color: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript(([n, c]) => {
    localStorage.setItem('aldine.onboarded', '1');
    localStorage.setItem('aldine.name', n);
    localStorage.setItem('aldine.color', c);
  }, [name, color]);
  return page;
}

test.describe('project search', () => {
  test('searches open and never-opened files, with case, word and regex', async ({ page, request }) => {
    const id = await createProject(request, 'Project Search');
    try {
      await put(request, id, 'main.tex', '\\documentclass{article}\n\\begin{document}\n\\input{chapters/one}\nWidget widgets\n\\end{document}\n');
      await put(request, id, 'chapters/one.tex', 'widget Widget widgets\n');
      await put(request, id, 'main.log', 'widget in the log\n');
      await put(request, id, 'data/table.dat', `widget ${'1 2 3\n'.repeat(300_000)}`);
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('Widget widgets');
      // the live document runs ahead of the file on disk
      await typeAtEnd(page, ' widget');

      await page.keyboard.press('ControlOrMeta+Shift+F');
      await expect(page.getByTestId('search-input')).toBeFocused();
      await expect(page.getByTestId('search-empty')).toContainText('Searches every text file on this branch');
      await page.keyboard.type('widget');
      await expect(page.getByTestId('search-file')).toHaveCount(2);
      await expect(page.getByTestId('search-file').nth(0)).toHaveAttribute('data-path', 'chapters/one.tex');
      await expect(page.getByTestId('search-file').nth(1)).toHaveAttribute('data-path', 'main.tex');
      await expect(fileRow(page, 'main.log')).toHaveCount(0);
      await expect(count(page, 'main.tex')).toHaveText('3'); // Widget, widgets and the freshly typed widget
      await expect(count(page, 'chapters/one.tex')).toHaveText('3');
      await expect(page.getByTestId('search-summary')).toHaveText('6 results in 2 files');
      // a screen reader hears the outcome, and which files were too large to search
      await expect(page.getByTestId('search-status')).toHaveText('6 results in 2 files. 1 file over 1 MB was not searched');
      await page.getByTestId('search-skipped').locator('summary').click();
      await expect(page.getByTestId('search-skipped-files')).toHaveText('data/table.dat');

      await page.getByTestId('search-case').click();
      await expect(page.getByTestId('search-case')).toHaveAttribute('aria-pressed', 'true');
      await expect(count(page, 'main.tex')).toHaveText('2');
      await expect(count(page, 'chapters/one.tex')).toHaveText('2');
      await page.getByTestId('search-word').click();
      await expect(count(page, 'main.tex')).toHaveText('1');
      await expect(count(page, 'chapters/one.tex')).toHaveText('1');
      await page.getByTestId('search-regex').click();
      await page.getByTestId('search-input').fill('widgets?\\b');
      await expect(page.getByTestId('search-summary')).toHaveText('4 results in 2 files');
      await expect(count(page, 'main.tex')).toHaveText('2');
      await page.getByTestId('search-input').fill('(');
      await expect(page.getByTestId('search-error')).toContainText('Invalid regular expression');
      await page.getByTestId('search-input').fill('widgets?\\b');
      await expect(page.getByTestId('search-summary')).toHaveText('4 results in 2 files');

      // a click opens the file with the match selected
      await page.locator('[data-testid="search-match"][data-path="chapters/one.tex"]').first().click();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/one.tex');
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('widget');

      // keyboard: down into the results, down again, Enter opens it and keeps focus in the list
      await page.getByTestId('search-input').click();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('search-match').nth(0)).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('search-match').nth(1)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('search-match').nth(1)).toBeFocused();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/one.tex');
      // the shortcut from the list goes back to the query, which the opened match's selection leaves alone
      await page.keyboard.press('ControlOrMeta+Shift+F');
      await expect(page.getByTestId('search-input')).toBeFocused();
      await expect(page.getByTestId('search-input')).toHaveValue('widgets?\\b');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      // file headers are stops too: one collapsed is still reached, and opened again
      const mainFile = fileRow(page, 'main.tex');
      await page.keyboard.press('ArrowDown');
      await expect(mainFile).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(mainFile).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('ArrowLeft');
      await expect(mainFile).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(page.getByTestId('search-match').nth(1)).toBeFocused();
      await page.keyboard.press('End');
      await expect(mainFile).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(mainFile).toHaveAttribute('aria-expanded', 'true');
      // Delete leaves the focused file out; the status line brings it back
      await page.keyboard.press('Delete');
      await expect(mainFile).toHaveCount(0);
      await expect(fileRow(page, 'chapters/one.tex')).toBeFocused();
      await expect(page.getByTestId('search-summary')).toHaveText('2 results in 1 file');
      await page.getByTestId('search-show-left-out').click();
      await expect(page.getByTestId('search-summary')).toHaveText('4 results in 2 files');
      await page.getByTestId('search-match').nth(0).focus();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('search-input')).toBeFocused();

      // the panel keeps its state across tabs, and the toggles across reloads
      await page.getByTestId('tab-files').click();
      await page.getByTestId('tab-search').click();
      await expect(page.getByTestId('search-input')).toHaveValue('widgets?\\b');
      await page.reload();
      await page.getByTestId('tab-search').click();
      await expect(page.getByTestId('search-regex')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('search-input')).toHaveValue('');

      // in regex mode the editor's selection becomes a pattern that finds itself
      await page.getByTestId('search-input').fill('\\\\input\\{[a-z/]+\\}');
      await expect(page.getByTestId('search-summary')).toHaveText('1 result in 1 file');
      await page.getByTestId('search-match').first().click();
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('\\input{chapters/one}');
      await page.keyboard.press('ControlOrMeta+Shift+F');
      await expect(page.getByTestId('search-input')).toHaveValue('\\\\input\\{chapters/one\\}');
      await expect(page.getByTestId('search-summary')).toHaveText('1 result in 1 file');
      await expect(page.getByTestId('search-error')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('replace one, then replace all while a second person has a file open', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const id = await createProject(request, 'Project Replace');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await put(request, id, 'main.tex', '\\documentclass{article}\n\\begin{document}\ncolour and colour\n\\input{chapters/one}\n\\input{chapters/two}\n\\end{document}\n');
      await put(request, id, 'chapters/one.tex', 'colour colour colour\n');
      await put(request, id, 'chapters/two.tex', 'colour\ncolour\ncolour\ncolour\n');
      await request.post(`/api/projects/${id}/commit`, { data: { branch: 'main', message: 'Seed the chapters' } });
      const seeded = (await log(request, id)).length;

      const b = await asWriter(ctxB, 'Bob', '#2e933c');
      await openProject(b, id);
      await b.getByTestId('file-chapters/two.tex').click();
      await expect(b.getByTestId('active-file')).toHaveText('chapters/two.tex');
      await expect(b.locator('.cm-content')).toContainText('colour');

      const a = await asWriter(ctxA, 'Ada', '#e8554d');
      await openProject(a, id);
      await a.getByTestId('tab-search').click();
      await expect(a.getByTestId('search-input')).toBeFocused();
      await a.keyboard.type('colour');
      await expect(a.getByTestId('search-summary')).toHaveText('9 results in 3 files');
      // with nothing to replace with, a row's button deletes, and says so
      await expect(a.getByTestId('search-replace-one').first()).toHaveAttribute('aria-label', 'Delete this match');
      await a.getByTestId('search-replace-input').fill('color');
      await expect(a.getByTestId('search-replace-one').first()).toHaveAttribute('aria-label', 'Replace this match');
      // literal mode shows what each row becomes
      await expect(a.getByTestId('search-match').first().locator('ins')).toHaveText('color');

      const first = a.locator('[data-testid="search-match"][data-path="main.tex"]').first();
      await first.hover();
      await first.getByTestId('search-replace-one').click();
      await expect(a.getByTestId('search-summary')).toHaveText('8 results in 3 files');
      // focus lands on the row now in its place, not on the page
      await expect(a.locator('[data-testid="search-match"][data-path="main.tex"]').first()).toBeFocused();
      await expect.poll(async () => (await log(request, id))[0]?.message).toBe('Replace "colour" with "color" in main.tex');
      expect((await log(request, id))[0].author).toBe('Ada');
      expect((await log(request, id)).length).toBe(seeded + 1);

      // Bob keeps typing in the file Ada is about to change
      await typeAtEnd(b, 'TYPED-BY-BOB');
      await expect.poll(() => fileText(request, id, 'chapters/two.tex')).toContain('TYPED-BY-BOB');

      await a.getByTestId('search-replace-all').click();
      await expect(a.getByTestId('dialog-title')).toHaveText('Replace 8 matches in 3 files?');
      await expect(a.getByTestId('dialog-message')).toContainText('This lands as one commit.');
      // the shortcut does not reach behind the dialog
      await a.keyboard.press('ControlOrMeta+Shift+F');
      await expect(a.getByTestId('dialog-title')).toBeVisible();
      await expect(a.getByTestId('search-input')).not.toBeFocused();
      await a.getByTestId('dialog-confirm').click();
      await expect(a.getByText('Replaced 8 matches in 3 files')).toBeVisible();
      await expect(a.getByTestId('search-empty')).toHaveText('No results for “colour”');
      await expect(a.getByTestId('search-status')).toHaveText('No results for “colour”');
      await expect(a.getByTestId('search-input')).toBeFocused();

      // Bob sees it land in front of him, without a reload
      await expect(b.locator('.cm-content')).not.toContainText('colour');
      await expect.poll(async () => occurrences((await b.locator('.cm-content').textContent()) ?? '', 'color')).toBe(4);
      await expect(b.locator('.cm-content')).toContainText('TYPED-BY-BOB');

      // and after one: nothing was duplicated
      await b.reload();
      await b.getByTestId('file-chapters/two.tex').click();
      await expect(b.getByTestId('active-file')).toHaveText('chapters/two.tex');
      await expect(b.locator('.cm-content')).toContainText('TYPED-BY-BOB');
      const after = (await b.locator('.cm-content').textContent()) ?? '';
      expect(occurrences(after, 'color')).toBe(4);
      expect(occurrences(after, 'TYPED-BY-BOB')).toBe(1);

      const one = await fileText(request, id, 'chapters/one.tex');
      expect(occurrences(one, 'color')).toBe(3);
      expect(one).not.toContain('colour');
      // main.tex changed twice through Ada's own open document: nothing duplicated or misplaced
      expect(await fileText(request, id, 'main.tex')).toBe('\\documentclass{article}\n\\begin{document}\ncolor and color\n\\input{chapters/one}\n\\input{chapters/two}\n\\end{document}\n');

      const entries = await log(request, id);
      const all = entries.filter((c) => c.message === 'Replace "colour" with "color" in 3 files');
      expect(all).toHaveLength(1);
      expect(entries[0].message).toBe('Replace "colour" with "color" in 3 files');
      expect(entries[0].author).toBe('Ada');
      const { stat, patch } = await (await request.get(`/api/projects/${id}/commit/${entries[0].hash}/diff`)).json() as { stat: string; patch: string };
      for (const f of ['main.tex', 'chapters/one.tex', 'chapters/two.tex']) expect(stat).toContain(f);
      // Ada's commit holds her replacements and nothing else: Bob's typing went to an autosave
      const changed = patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
      const removed = changed.filter((l) => l.startsWith('-'));
      const added = changed.filter((l) => l.startsWith('+'));
      expect(changed.join('\n')).not.toContain('TYPED-BY-BOB');
      expect(added.map((l) => l.slice(1))).toEqual(removed.map((l) => l.slice(1).replaceAll('colour', 'color')));

      await openSidebarTab(a, 'history');
      await expect(a.getByTestId('history-panel')).toContainText('Replace "colour" with "color" in 3 files');
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });

  test('a file with CRLF line endings: a click selects the line shown, Replace all keeps its endings', async ({ page, request }) => {
    const id = await createProject(request, 'CRLF Search');
    try {
      // identical lines: only the match's offset tells it from its twins
      expect((await put(request, id, 'chapters/win.tex', 'colour\r\n'.repeat(30))).ok()).toBeTruthy();
      await openProject(page, id);
      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').fill('colour');
      await expect(count(page, 'chapters/win.tex')).toHaveText('30');
      await page.locator('[data-testid="search-match"][data-path="chapters/win.tex"][data-line="25"]').click();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/win.tex');
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('colour');
      await expect(page.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('25');

      await page.getByTestId('search-replace-input').fill('color');
      await page.getByTestId('search-replace-all').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('search-empty')).toHaveText('No results for “colour”');
      expect(await fileText(request, id, 'chapters/win.tex')).toBe('color\r\n'.repeat(30));
      const commit = (await log(request, id)).find((c) => c.message === 'Replace "colour" with "color" in chapters/win.tex');
      expect(commit).toBeTruthy();
      // the commit changes the replaced lines in the file's own endings, not every line to LF
      const { patch } = await (await request.get(`/api/projects/${id}/commit/${commit!.hash}/diff`)).json() as { patch: string };
      const changed = patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
      expect(changed.filter((l) => l.startsWith('-'))).toEqual(Array(30).fill('-colour\r'));
      expect(changed.filter((l) => l.startsWith('+'))).toEqual(Array(30).fill('+color\r'));
    } finally {
      await cleanup(request, id);
    }
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('the tab opens the panel and a tapped row folds the sidebar onto the match', async ({ page, request }) => {
      const id = await createProject(request, 'Phone Search');
      try {
        await put(request, id, 'main.tex', '\\documentclass{article}\n\\begin{document}\nA gadget here.\n\\end{document}\n');
        await openProject(page, id);
        await page.getByTestId('tab-search').tap();
        await expect(page.getByTestId('search-panel')).toBeVisible();
        await page.getByTestId('search-input').fill('gadget');
        const row = page.getByTestId('search-match').first();
        await expect(row).toBeVisible();
        // no hover on a touch screen: the row's replace button is always shown
        await expect(row.getByTestId('search-replace-one')).toHaveCSS('opacity', '1');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        // Enter from the keyboard keeps focus in the list, so the sidebar stays
        await page.getByTestId('search-input').press('ArrowDown');
        await expect(row).toBeFocused();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        await expect(page.getByTestId('sidebar')).toBeVisible();
        await expect(row).toBeFocused();
        await row.tap();
        await expect(page.getByTestId('sidebar')).toBeHidden();
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('gadget');
      } finally {
        await cleanup(request, id);
      }
    });
  });
});
