import { test, expect } from '../fixtures';
import { createProject, openProject, openPluginTab, cleanup } from './helpers';

const put = (request: import('@playwright/test').APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });

/**
 * The sidebar keeps three tabs of its own (Files, Cite, Review) and one More
 * menu for the rest, History included; it folds to a rail and remembers that.
 */
test.describe('sidebar', () => {
  test('Files, Cite and Review are tabs; History is in More', async ({ page, request }) => {
    const id = await createProject(request, 'Sidebar Tabs');
    try {
      await openProject(page, id);
      await expect(page.getByTestId('tab-plugin:references')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('tab-plugin:references')).toHaveText('Cite');
      await expect(page.getByTestId('tab-history')).toHaveCount(0);
      // one row: every tab at the same height
      const tops = await page.locator('.sidebar__tabs > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);

      await page.getByTestId('tab-more').click();
      await expect(page.getByTestId('tab-more-menu').getByTestId('tab-plugin:zotero')).toBeVisible();
      await page.getByTestId('tab-history').click();
      await expect(page.getByTestId('history-panel')).toBeVisible();
      await expect(page.getByTestId('tab-more')).toHaveText(/^History/);
      await expect(page.getByTestId('tab-more')).toHaveAttribute('aria-selected', 'true');
    } finally { await cleanup(request, id); }
  });

  test('the sidebar folds to a rail and stays folded after a reload', async ({ page, request }) => {
    const id = await createProject(request, 'Sidebar Fold');
    try {
      await openProject(page, id);
      const code = page.locator('.pane--editor');
      const before = (await code.boundingBox())!.width;
      await page.getByTestId('sidebar-collapse').click();
      await expect(page.getByTestId('sidebar')).toBeHidden();
      await expect(page.getByTestId('sidebar-expand')).toBeVisible();
      expect((await code.boundingBox())!.width).toBeGreaterThan(before + 150);

      await page.reload();
      await expect(page.getByTestId('sidebar-expand')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('sidebar-expand').click();
      await expect(page.getByTestId('tab-files')).toBeVisible();
      await page.reload();
      await expect(page.getByTestId('tab-files')).toBeVisible({ timeout: 15_000 });

      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('hide the sidebar');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('sidebar')).toBeHidden();
    } finally {
      await page.evaluate(() => localStorage.removeItem('aldine.sidebarHidden')).catch(() => {});
      await cleanup(request, id);
    }
  });

  test('Cite keeps search and add on screen under a long bibliography', async ({ page, request }) => {
    const id = await createProject(request, 'Cite Footer');
    try {
      const bib = Array.from({ length: 40 }, (_, i) => `@article{key${i},\n  title = {Entry number ${i}},\n  author = {Doe, Jane},\n  year = {2020}\n}\n`).join('\n');
      await put(request, id, 'references.bib', bib);
      await page.setViewportSize({ width: 1280, height: 720 });
      await openProject(page, id);
      await openPluginTab(page, 'references');
      await expect(page.getByTestId('cite-bib-key39')).toBeAttached({ timeout: 15_000 });
      await expect(page.getByTestId('reference-search')).toBeInViewport();
      await expect(page.getByTestId('reference-add')).toBeInViewport();
      const list = page.getByTestId('cite-project');
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      // scrolling the entries leaves the footer where it was
      const searchTop = (await page.getByTestId('reference-search').boundingBox())!.y;
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      expect((await page.getByTestId('reference-search').boundingBox())!.y).toBe(searchTop);
    } finally { await cleanup(request, id); }
  });

  test('file rows line up with folders, level by level', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Indent');
    try {
      await put(request, id, 'chapters/intro.tex', '% intro\n');
      await put(request, id, 'chapters/appendix/proofs.tex', '% proofs\n');
      await openProject(page, id);
      await expect(page.getByTestId('file-chapters/appendix/proofs.tex')).toBeVisible({ timeout: 15_000 });
      const iconX = async (testid: string) => (await page.getByTestId(testid).locator('.tree__icon').boundingBox())!.x;
      const chevX = async (testid: string) => (await page.getByTestId(testid).locator('.tree__chevron').boundingBox())!.x;
      // a root file's icon is in the same column as a root folder's
      expect(await iconX('file-main.tex')).toBeCloseTo(await iconX('dir-chapters'), 0);
      // one level in: the folder's own icon column holds the child's chevron
      expect(await chevX('dir-chapters/appendix')).toBeCloseTo(await iconX('dir-chapters'), 0);
      expect(await iconX('file-chapters/intro.tex')).toBeCloseTo(await iconX('dir-chapters/appendix'), 0);
      expect(await iconX('file-chapters/appendix/proofs.tex')).toBeGreaterThan(await iconX('file-chapters/intro.tex'));
      // the chevron is drawn, not a glyph from the font
      await expect(page.getByTestId('dir-chapters').locator('.tree__chevron svg')).toHaveCount(1);
    } finally { await cleanup(request, id); }
  });
});
