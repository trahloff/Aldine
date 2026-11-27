import { test, expect } from '../fixtures';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

const WITH_BOOKMARKS = [
  '\\documentclass{article}',
  '\\usepackage[hidelinks]{hyperref}',
  '\\begin{document}',
  '\\section{First chapter}',
  'The first page.',
  '\\newpage',
  '\\section{Second chapter}',
  'The target page.',
  '\\subsection{Nested subsection}',
  'A nested bookmark.',
  '\\newpage',
  'The third page.',
  '\\end{document}',
  '',
].join('\n');

const WITHOUT_BOOKMARKS = [
  '\\documentclass{article}',
  '\\usepackage[hidelinks]{hyperref}',
  '\\begin{document}',
  'This document has no PDF bookmarks.',
  '\\end{document}',
  '',
].join('\n');

test.describe('PDF bookmarks', () => {
  test('shows the nested native outline and follows a bookmark', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'PDF Bookmarks');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: WITH_BOOKMARKS } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(3);

      const toggle = page.getByTestId('pdf-outline-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();

      const outline = page.getByTestId('pdf-outline');
      await expect(outline).toBeVisible();
      await expect(outline.getByTestId('pdf-outline-item').filter({ hasText: /Second chapter/ })).toHaveCount(1);
      await expect(outline.locator('ol ol')).toHaveCount(1);
      await expect(outline.getByTestId('pdf-outline-item').filter({ hasText: /Nested subsection/ })).toHaveCount(1);

      await outline.getByTestId('pdf-outline-item').filter({ hasText: /Second chapter/ }).click();
      await expect(page.getByTestId('pdf-page-indicator')).toHaveText('2 / 3');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await page.keyboard.press('Escape');
      await expect(outline).toHaveCount(0);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await toggle.click();
      await expect(outline).toBeVisible();
      await page.getByTestId('pdf-outline-close').click();
      await expect(outline).toHaveCount(0);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await cleanup(request, id);
    }
  });

  test('does not offer an outline for a PDF without bookmarks', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'PDF Without Bookmarks');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: WITHOUT_BOOKMARKS } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(1);
      await expect(page.getByTestId('pdf-outline-toggle')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });
});
