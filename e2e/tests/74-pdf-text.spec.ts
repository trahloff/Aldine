import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const SENTENCE = 'The quick brown fox jumps over the lazy dog.';

/** Ten pages: a sentence and a reference on the first, a word to find on the
 *  second and the last, filler between. */
const DOC = [
  '\\documentclass{article}',
  '\\usepackage{hyperref}',
  '\\begin{document}',
  `${SENTENCE}`,
  '',
  'The marker is in Section~\\ref{sec:far}, a page on.',
  '\\newpage',
  '\\section{Far}\\label{sec:far}',
  'The word zanzibar is here, and zanzibar once more.',
  ...Array.from({ length: 7 }, (_, k) => `\\newpage\nFiller page ${k + 3}.`),
  '\\newpage',
  'The last page says Zanzibar.',
  '\\end{document}',
  '',
].join('\n');

type Box = { x: number; y: number; width: number; height: number };

/** In the page: the boxes of the first and the last character of `needle`
 *  in a page's text layer, read across its spans. */
function charBoxes(page: Page, needle: string, pageNo = 1): Promise<[Box, Box] | null> {
  return page.evaluate(([needle, n]) => {
    const layer = document.querySelector(`canvas[data-page="${n}"]`)?.parentElement?.querySelector('.pdf-text');
    if (!layer) return null;
    const nodes: Text[] = [];
    const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) nodes.push(t as Text);
    const all = nodes.map((t) => t.data).join('');
    const at = all.indexOf(needle);
    if (at < 0) return null;
    const box = (i: number) => {
      let k = 0;
      for (const t of nodes) {
        if (i < k + t.data.length) {
          const r = document.createRange();
          r.setStart(t, i - k);
          r.setEnd(t, i - k + 1);
          const b = r.getBoundingClientRect();
          return { x: b.left, y: b.top, width: b.width, height: b.height };
        }
        k += t.data.length;
      }
      throw new Error('out of range');
    };
    return [box(at), box(at + needle.length - 1)] as [Box, Box];
  }, [needle, pageNo] as const);
}

/** A box as fractions of its page's canvas: the same at every zoom. */
function onPage(page: Page, b: Box, pageNo = 1): Promise<number[]> {
  return page.locator(`canvas[data-page="${pageNo}"]`).evaluate((c, b) => {
    const r = c.getBoundingClientRect();
    return [(b.x - r.left) / r.width, (b.y - r.top) / r.height, b.width / r.width, b.height / r.height];
  }, b);
}

test.describe('PDF text', () => {
  test('text in the preview selects and copies as plain text, and stays on its glyphs through a zoom', async ({ page, context, request }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const id = await createProject(request, 'PDF Text Select');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(10);
      // Only the pages near the view get their text.
      await expect.poll(() => charBoxes(page, SENTENCE)).not.toBeNull();
      expect(await page.getByTestId('pdf-text').count()).toBeLessThan(10);

      // A drag from the first letter to the full stop selects the sentence...
      const [first, last] = (await charBoxes(page, SENTENCE))!;
      await page.mouse.move(first.x + 1, first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(last.x + last.width - 1, last.y + last.height / 2, { steps: 12 });
      await page.mouse.up();
      expect(await page.evaluate(() => document.getSelection()!.toString())).toBe(SENTENCE);
      await expect(page.getByTestId('pdf-pane')).toBeFocused();

      // ...and copies it as text only: rich text would paste the layer's invisible spans.
      await page.keyboard.press(`${mod}+c`);
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(SENTENCE);
      expect(await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types))).toEqual(['text/plain']);

      // A zoom lays the text out again over the same glyphs.
      const before = await onPage(page, first);
      await page.locator('canvas.pdf-page').first().evaluate((el) => { el.dataset.before = '1'; });
      await page.getByTestId('zoom-controls').getByRole('button', { name: 'Zoom in' }).click();
      await expect(page.locator('canvas.pdf-page[data-before]')).toHaveCount(0);
      await expect.poll(() => charBoxes(page, SENTENCE)).not.toBeNull();
      const after = await onPage(page, (await charBoxes(page, SENTENCE))![0]);
      for (let k = 0; k < 4; k++) expect(Math.abs(after[k] - before[k])).toBeLessThan(0.005);
    } finally { await cleanup(request, id); }
  });

  test('Find in the PDF counts and steps through matches, and the editor keeps its own Find', async ({ page, request }) => {
    const id = await createProject(request, 'PDF Text Find');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(10);
      const pane = page.getByTestId('pdf-pane');
      const indicator = page.getByTestId('pdf-page-indicator');
      const bar = page.getByTestId('pdf-find');
      const input = page.getByTestId('pdf-find-input');
      const count = page.getByTestId('pdf-find-count');
      const hits = page.getByTestId('pdf-find-hit');
      const currentHit = page.locator('.pdf-hit--current');
      await expect(indicator).toHaveText('1 / 10');

      // The editor's Mod+F is the editor's.
      await page.locator('.cm-line', { hasText: 'zanzibar' }).first().click();
      await page.keyboard.press(`${mod}+f`);
      await expect(page.locator('.cm-search')).toBeVisible();
      await expect(bar).toHaveCount(0);
      await page.keyboard.press('Escape');

      // In the preview it opens Find there; a new query starts from the view.
      await pane.focus();
      await page.keyboard.press(`${mod}+f`);
      await expect(bar).toBeVisible();
      await expect(input).toBeFocused();
      await input.fill('nowhere to be found');
      await expect(count).toHaveText('No matches');
      await input.fill('ZANZIBAR');
      await expect(count).toHaveText('1 of 3');
      await expect(indicator).toHaveText('2 / 10');
      await expect(hits).toHaveCount(2);
      await expect(currentHit).toHaveCount(1);
      await expect(currentHit).toBeInViewport();

      // Enter steps on, to the last page and around; Shift+Enter steps back.
      await page.keyboard.press('Enter');
      await expect(count).toHaveText('2 of 3');
      await page.keyboard.press('Enter');
      await expect(count).toHaveText('3 of 3');
      await expect(indicator).toHaveText('10 / 10');
      await expect(currentHit).toBeInViewport();
      // the first page, far from the view now, has given its text up
      await expect(page.locator('canvas[data-page="1"]').locator('..').getByTestId('pdf-text')).toHaveCount(0);
      await page.keyboard.press('Enter');
      await expect(count).toHaveText('1 of 3');
      await expect(indicator).toHaveText('2 / 10');
      await page.keyboard.press('Shift+Enter');
      await expect(count).toHaveText('3 of 3');
      await page.getByTestId('pdf-find-prev').click();
      await expect(count).toHaveText('2 of 3');

      // Escape closes it and gives the keys back to the pages.
      await page.keyboard.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect(hits).toHaveCount(0);
      await expect(pane).toBeFocused();

      // The palette opens it too, the field focused; the preview has no Find icon of its own.
      await expect(page.getByTestId('pdf-find-open')).toHaveCount(0);
      await page.locator('.cm-line', { hasText: 'Filler page 3' }).click();
      await page.keyboard.press(`${mod}+k`);
      await page.getByTestId('palette-input').fill('find in the pdf');
      await page.keyboard.press('Enter');
      await expect(bar).toBeVisible();
      await expect(input).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect(pane).toBeFocused();

      // Reopened, it holds the query; a new typeset is searched again.
      await page.keyboard.press(`${mod}+f`);
      await expect(input).toHaveValue('ZANZIBAR');
      await expect(count).toHaveText(/ of 3$/);
      const pdf = (await page.getByTestId('preview').getAttribute('data-pdf'))!;
      await page.locator('.cm-line', { hasText: 'The last page says' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Zanzibar again.');
      await expect(page.getByTestId('preview')).not.toHaveAttribute('data-pdf', pdf, { timeout: 60_000 });
      await expect(count).toHaveText(/ of 4$/, { timeout: 20_000 });
      await expect(bar).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('links stay clickable over the text, and a double-click on text jumps to its source', async ({ page, request }) => {
    const id = await createProject(request, 'PDF Text Links');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expectTypesetOk(page);
      const pane = page.getByTestId('pdf-pane');
      const indicator = page.getByTestId('pdf-page-indicator');
      const link = page.getByTestId('pdf-link').and(page.getByRole('button', { name: 'Go to page 2' }));
      await expect(link).toHaveCount(1);
      await expect.poll(() => charBoxes(page, 'marker')).not.toBeNull();

      // The link is on top of the text under it, and one click follows it.
      const at = (await link.boundingBox())!;
      expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), [at.x + at.width / 2, at.y + at.height / 2])).toBe('pdf-link');
      await link.click();
      await expect(indicator).toHaveText('2 / 10');

      // A double-click on a word goes to the line it was typeset from.
      await pane.evaluate((el) => { el.scrollTop = 0; });
      await expect(indicator).toHaveText('1 / 10');
      const [word] = (await charBoxes(page, 'quick'))!;
      await page.mouse.dblclick(word.x + word.width / 2, word.y + word.height / 2);
      await expect(page.locator('.cm-content')).toBeFocused({ timeout: 10_000 });
      await expect(page.locator('.cm-activeLine')).toContainText('The quick brown fox');
    } finally { await cleanup(request, id); }
  });
});
