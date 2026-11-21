import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

const LONG = Array.from({ length: 300 }, (_, i) => `Line ${i + 1} of the long chapter.`).join('\n') + '\n    \\item PEER-END-MARK, indented, so the line carries a hanging indent';

test.describe('file tabs', () => {
  test('opened files become tabs that switch, close, and come back after a reload', async ({ page, request }) => {
    const id = await createProject(request, 'Tabs');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'methods.tex', content: 'METHODS-FILE text.\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'results.tex', content: 'RESULTS-FILE text.\n' } });
      await openProject(page, id);
      await expect(page.getByTestId('file-tabs'), 'one file needs no strip').toHaveCount(0);

      await page.getByTestId('file-methods.tex').click();
      await expect(page.locator('.cm-content')).toContainText('METHODS-FILE');
      await page.getByTestId('file-results.tex').click();
      await expect(page.locator('.cm-content')).toContainText('RESULTS-FILE');
      const tabs = page.getByTestId('file-tab');
      await expect(tabs).toHaveCount(3);
      await expect(page.locator('[data-testid="file-tab"][data-active="true"]')).toHaveAttribute('data-path', 'results.tex');

      await tabs.filter({ hasText: 'methods.tex' }).getByTestId('file-tab-name').click();
      await expect(page.getByTestId('active-file')).toHaveText('methods.tex');
      await expect(page.locator('.cm-content')).toContainText('METHODS-FILE');

      // closing the open tab shows its right neighbour
      await tabs.filter({ hasText: 'methods.tex' }).getByTestId('file-tab-close').click();
      await expect(page.getByTestId('active-file')).toHaveText('results.tex');
      await expect(tabs).toHaveCount(2);

      await page.reload();
      await expect(page.getByTestId('active-file')).toHaveText('results.tex');
      await expect(tabs).toHaveCount(2);
      await expect(page.locator('[data-testid="file-tab"][data-path="methods.tex"]')).toHaveCount(0);

      await tabs.filter({ hasText: 'results.tex' }).getByTestId('file-tab-close').click();
      await expect(page.getByTestId('file-tabs')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('collaborator cursors', () => {
  test('clicking a collaborator scrolls to their cursor, in their file; the name label fits its text', async ({ browser, request }) => {
    const id = await createProject(request, 'Peer Jump');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'long.tex', content: LONG } });
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await a.addInitScript(() => { localStorage.setItem('aldine.name', 'Ada'); localStorage.setItem('aldine.color', '#e8554d'); });
      await b.addInitScript(() => { localStorage.setItem('aldine.name', 'Bob Wide-Name Baker'); localStorage.setItem('aldine.color', '#2e933c'); });
      await openProject(a, id);
      await openProject(b, id);
      await b.getByTestId('file-long.tex').click();
      await expect(b.locator('.cm-content')).toContainText('Line 1 of');
      await b.locator('.cm-content').click();
      await b.keyboard.press('ControlOrMeta+End');

      const bob = a.getByTestId('presence').locator('[data-name="Bob Wide-Name Baker"]');
      await expect(bob).toHaveAttribute('data-file', 'long.tex');
      await bob.click();
      await expect(a.getByTestId('active-file')).toHaveText('long.tex');
      const label = a.locator('.cm-ySelectionInfo', { hasText: 'Bob Wide-Name Baker' });
      await expect(label).toBeInViewport({ timeout: 10_000 });
      await expect(a.locator('.cm-line', { hasText: 'PEER-END-MARK' })).toBeInViewport();

      // On an indented line the name starts inside its own background.
      const [box, text] = await label.evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return [el.getBoundingClientRect().left, r.getBoundingClientRect().left];
      });
      expect(text).toBeGreaterThanOrEqual(box);

      // back at the top, the same click (now in this file) scrolls down again
      await a.locator('.cm-content').click();
      await a.keyboard.press('ControlOrMeta+Home');
      await expect(label).not.toBeInViewport();
      await bob.click();
      await expect(label).toBeInViewport({ timeout: 5_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });
});
