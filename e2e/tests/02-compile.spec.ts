import { test, expect } from '../fixtures';
import { createPaperProject, openProject, typeset, expectTypesetOk, cleanup } from './helpers';

test.describe('LaTeX compilation', () => {
  test('typesets the demo paper to a multi-page PDF', async ({ page, request }) => {
    const id = await createPaperProject(request);
    try {
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page);
      const pages = await page.locator('canvas.pdf-page').count();
      expect(pages).toBeGreaterThanOrEqual(2);
      // status shows craft detail: "Typeset in X.Xs"
      await expect(page.getByTestId('pdf-status')).toContainText(/Typeset in \d+(\.\d+)?s/);
      // the compiled PDF can be downloaded, named after the project
      const downloading = page.waitForEvent('download');
      await page.getByTestId('download-pdf').click();
      const download = await downloading;
      expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    } finally {
      await cleanup(request, id);
    }
  });

  test('surfaces errors with line numbers and jumps to the line', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Error Paper');
    try {
      // inject an undefined control sequence near the top
      const res = await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`);
      const content = await res.text();
      const broken = content.replace('\\section{Introduction}', '\\section{Introduction}\n\\thisisnotacommand');
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: broken } });

      await openProject(page, id);
      await typeset(page);
      await expect(page.getByTestId('pdf-status')).toContainText(/error/i, { timeout: 120_000 });
      const row = page.getByTestId('errors-panel').locator('.errors__row').first();
      await expect(row).toBeVisible();
      await expect(row).toContainText(/Undefined control sequence|error/i);
      await row.click();
      // clicking focuses the editor at the offending line
      await expect(page.locator('.cm-content')).toBeFocused();
    } finally {
      await cleanup(request, id);
    }
  });
});
