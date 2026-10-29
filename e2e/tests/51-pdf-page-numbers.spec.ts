import { test, expect } from '../fixtures';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  ...Array.from({ length: 6 }, (_, i) => `\\section*{Page ${i + 1}}\nText on page ${i + 1}.\n\\newpage`),
  '\\end{document}',
  '',
].join('\n');

/** #198: the preview says which page is on screen and goes to a page typed. */
test.describe('PDF page numbers', () => {
  test('follow the scroll and jump to a typed page', async ({ page, request }) => {
    const id = await createProject(request, 'Page Numbers');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(6);

      const indicator = page.getByTestId('pdf-page-indicator');
      const pane = page.getByTestId('pdf-pane');
      await expect(indicator).toHaveText('1 / 6');
      await expect(indicator).toHaveAttribute('aria-label', 'Page 1 of 6. Go to a page');

      // Scrolling: the page that fills most of the pane is the current one.
      await pane.evaluate((el) => {
        const p4 = el.querySelector<HTMLElement>('canvas[data-page="4"]')!;
        el.scrollTop = p4.offsetTop + 40;
      });
      await expect(indicator).toHaveText('4 / 6');
      await pane.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect(indicator).toHaveText('6 / 6');

      // Typing a page and Enter goes there, its top at the top of the pane.
      await indicator.click();
      const input = page.getByTestId('pdf-page-input');
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('6');
      await input.fill('2');
      await input.press('Enter');
      await expect(indicator).toHaveText('2 / 6');
      await expect(indicator).toBeFocused();
      const offset = await pane.evaluate((el) => el.querySelector<HTMLElement>('canvas[data-page="2"]')!.offsetTop - el.scrollTop);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(20);

      // Escape leaves the view alone.
      await indicator.click();
      await input.fill('5');
      await input.press('Escape');
      await expect(input).toHaveCount(0);
      await expect(indicator).toHaveText('2 / 6');
      await expect(indicator).toBeFocused();

      // A page past the end goes to the last one; something that is no page goes nowhere.
      await indicator.click();
      await input.fill('99');
      await input.press('Enter');
      await expect(indicator).toHaveText('6 / 6');
      await indicator.click();
      await input.fill('two');
      await input.press('Enter');
      await expect(indicator).toHaveText('6 / 6');
    } finally { await cleanup(request, id); }
  });
});
