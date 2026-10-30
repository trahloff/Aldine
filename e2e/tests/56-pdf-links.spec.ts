import type { Locator } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

const DOC = [
  '\\documentclass{article}',
  '\\usepackage{hyperref}',
  '\\begin{document}',
  'The target is Section~\\ref{sec:target}, and the web has \\href{https://example.org}{an example site}.',
  '',
  'More words on the first page.',
  '\\newpage',
  'The second page opens with a paragraph before the heading.',
  '\\section{Target}\\label{sec:target}',
  'The section the reference points at.',
  '\\newpage',
  'A third page, so the second one can scroll to the top of the pane.',
  '\\end{document}',
  '',
].join('\n');

/** A link's box as fractions of its page: the same at every zoom. */
function spotOnPage(link: Locator): Promise<number[]> {
  return link.evaluate((el) => {
    const page = el.closest('.pdf-page-wrap')!.querySelector('canvas')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return [(r.left - page.left) / page.width, (r.top - page.top) / page.height, r.width / page.width, r.height / page.height];
  });
}

/** #221: links in the typeset PDF follow on a single click; a double-click
 *  still jumps to the source everywhere but on a link. */
test.describe('PDF links', () => {
  test('a reference scrolls to its target, a web link opens one new tab', async ({ page, context, request }) => {
    // The web link's tab gets a stub: no test reaches the network.
    await context.route('https://example.org/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>stub</title>' }));
    const id = await createProject(request, 'PDF Links');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(3);

      const pane = page.getByTestId('pdf-pane');
      const indicator = page.getByTestId('pdf-page-indicator');
      const flash = page.locator('.pdf-flash');
      const links = page.getByTestId('pdf-link');
      const internal = links.and(page.getByRole('button', { name: 'Go to page 2' }));
      const external = links.and(page.getByRole('link', { name: 'https://example.org/' }));
      await expect(links).toHaveCount(2);
      await expect(internal).toHaveAttribute('title', 'Go to page 2');
      await expect(internal).toHaveCSS('cursor', 'pointer');
      await expect(external).toHaveAttribute('href', 'https://example.org/');
      await expect(external).toHaveAttribute('target', '_blank');
      await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(external).toHaveCSS('cursor', 'pointer');
      await expect(indicator).toHaveText('1 / 3');

      // A zoom redraws every page; the links come back on the same spots.
      const before = await spotOnPage(internal);
      const widthBefore = (await page.locator('canvas.pdf-page').first().boundingBox())!.width;
      await page.locator('canvas.pdf-page').first().evaluate((el) => { el.dataset.before = '1'; });
      await page.getByTestId('zoom-controls').getByRole('button', { name: 'Zoom in' }).click();
      await expect(page.locator('canvas.pdf-page[data-before]')).toHaveCount(0);
      await expect(links).toHaveCount(2);
      expect((await page.locator('canvas.pdf-page').first().boundingBox())!.width).toBeGreaterThan(widthBefore * 1.05);
      const after = await spotOnPage(internal);
      for (let k = 0; k < 4; k++) expect(Math.abs(after[k] - before[k])).toBeLessThan(0.005);

      // One click on the reference: the heading near the top of the pane, flashed.
      await internal.click();
      await expect(indicator).toHaveText('2 / 3');
      await expect(flash).toHaveCount(1);
      await expect.poll(async () => {
        const offset = await pane.evaluate((el) => el.querySelector<HTMLElement>('canvas[data-page="2"]')!.offsetTop - el.scrollTop);
        const height = (await page.locator('canvas[data-page="2"]').boundingBox())!.height;
        // the page's top is above the pane, the heading a little way down it
        return offset < -20 && offset > -height / 3;
      }).toBe(true);

      // One click on the web link: a new tab at that address.
      const opening = context.waitForEvent('page');
      await external.click();
      const tab = await opening;
      await tab.waitForLoadState();
      expect(tab.url()).toBe('https://example.org/');
      await tab.close();

      // A double-click on it opens one tab, not two.
      let tabs = 0;
      context.on('page', () => { tabs++; });
      await external.dblclick();
      await expect.poll(() => tabs).toBe(1);
      await page.waitForTimeout(1000);
      expect(tabs).toBe(1);
      for (const p of context.pages()) if (p !== page) await p.close();

      // A double-click on the reference follows it once and is no jump to
      // source: not when both clicks hit the link...
      const top = async () => {
        await pane.evaluate((el) => { el.scrollTop = 0; });
        await expect(indicator).toHaveText('1 / 3');
        await expect(flash).toHaveCount(0);
      };
      await top();
      await internal.dblclick();
      await expect(indicator).toHaveText('2 / 3');
      await expect(flash).toHaveCount(1);
      // ...and not when the second one lands on the page that scrolled under it.
      await top();
      const at = (await internal.boundingBox())!;
      const x = at.x + at.width / 2, y = at.y + at.height / 2;
      await page.mouse.click(x, y);
      await page.waitForTimeout(200);
      // the second press of the same double-click (mouse.click would press once more first)
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await expect(indicator).toHaveText('2 / 3');
      await expect(flash).toHaveCount(1);
      await page.waitForTimeout(1000);
      await expect(page.locator('.cm-content')).not.toBeFocused();

      // Beside the link, a double-click still jumps to the source.
      await pane.evaluate((el) => { el.scrollTop = 0; });
      await expect(indicator).toHaveText('1 / 3');
      const box = (await internal.boundingBox())!;
      await page.mouse.dblclick(box.x - 30, box.y + box.height / 2);
      await expect(page.locator('.cm-content')).toBeFocused({ timeout: 10_000 });
    } finally { await cleanup(request, id); }
  });
});
