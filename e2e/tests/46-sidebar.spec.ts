import { test, expect } from '../fixtures';
import { createProject, openProject, openPluginTab, cleanup } from './helpers';

const put = (request: import('@playwright/test').APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });

/**
 * The sidebar keeps three tabs of its own (Files, Cite, Review) and one More
 * menu for the rest, History included; it folds to a rail and remembers that,
 * and its divider sets its width (#193).
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

  test('the sidebar divider follows a drag and the keys, is remembered, and resets on double-click', async ({ page, request }) => {
    const id = await createProject(request, 'Sidebar Width');
    try {
      await openProject(page, id);
      const sidebar = page.getByTestId('sidebar');
      const editor = page.locator('.pane--editor');
      const width = async () => Math.round((await sidebar.boundingBox())!.width);
      const divider = page.getByTestId('sidebar-resizer');
      expect(await width()).toBe(230);
      await expect(divider).toHaveAttribute('role', 'separator');
      await expect(divider).toHaveAttribute('aria-valuenow', '230');

      // Drag 100px to the right, leaving the divider's strip on the way.
      const box = (await divider.boundingBox())!;
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 50, y + 40, { steps: 4 });
      await expect(divider).toHaveClass(/resizer--drag/);
      await page.mouse.move(box.x + box.width / 2 + 100, y + 80, { steps: 4 });
      await page.mouse.up();
      await expect(divider).not.toHaveClass(/resizer--drag/);
      expect(await width()).toBe(330);
      await expect(divider).toHaveAttribute('aria-valuenow', '330');

      // Keyboard: the arrows move the divider, Shift by more.
      await divider.focus();
      await page.keyboard.press('ArrowRight');
      expect(await width()).toBe(346);
      await page.keyboard.press('Shift+ArrowLeft');
      expect(await width()).toBe(266);

      // Remembered by this browser.
      await page.reload();
      await expect(page.getByTestId('tab-files')).toBeVisible({ timeout: 15_000 });
      expect(await width()).toBe(266);

      // Held to its bounds: never under 180, and never so wide the editor goes.
      const drag = async (dx: number) => {
        const b = (await divider.boundingBox())!;
        await page.mouse.move(b.x + b.width / 2, b.y + 100);
        await page.mouse.down();
        await page.mouse.move(b.x + b.width / 2 + dx, b.y + 100, { steps: 6 });
        await page.mouse.up();
      };
      await drag(-400);
      expect(await width()).toBe(180);
      await drag(1200);
      expect(await width()).toBeLessThanOrEqual(520);
      expect((await editor.boundingBox())!.width).toBeGreaterThanOrEqual(270);

      // Double-click: the default width, and nothing remembered.
      await divider.dblclick();
      expect(await width()).toBe(230);
      expect(await page.evaluate(() => localStorage.getItem('aldine.sidebarWidth'))).toBeNull();

      // Folded to the rail there is nothing to drag.
      await page.getByTestId('sidebar-collapse').click();
      await expect(divider).toHaveCount(0);
      await page.getByTestId('sidebar-expand').click();
      await expect(divider).toBeVisible();
    } finally {
      await page.evaluate(() => { localStorage.removeItem('aldine.sidebarWidth'); localStorage.removeItem('aldine.sidebarHidden'); }).catch(() => {});
      await cleanup(request, id);
    }
  });

  test('a wide sidebar gives way in a narrow window and on a phone', async ({ page, request }) => {
    const id = await createProject(request, 'Sidebar Narrow');
    try {
      await page.addInitScript(() => localStorage.setItem('aldine.sidebarWidth', '520'));
      await openProject(page, id);
      expect(Math.round((await page.getByTestId('sidebar').boundingBox())!.width)).toBe(520);

      // A narrower window keeps the editor's room; the chosen width comes back with the room.
      await page.setViewportSize({ width: 1000, height: 800 });
      await expect.poll(async () => Math.round((await page.getByTestId('sidebar').boundingBox())!.width)).toBeLessThan(520);
      expect(Math.round((await page.locator('.pane--editor').boundingBox())!.width)).toBeGreaterThanOrEqual(260);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(async () => Math.round((await page.getByTestId('sidebar').boundingBox())!.width)).toBe(520);

      // A phone shows the sidebar as an overlay of its own width, with no divider.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(page.getByTestId('tab-files')).toBeVisible({ timeout: 15_000 });
      expect(Math.round((await page.getByTestId('sidebar').boundingBox())!.width)).toBe(350);
      await expect(page.getByTestId('sidebar-resizer')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } finally {
      await page.evaluate(() => localStorage.removeItem('aldine.sidebarWidth')).catch(() => {});
      await cleanup(request, id);
    }
  });

  test('Cite keeps search and add on screen under a long bibliography', async ({ page, request }) => {
    const id = await createProject(request, 'Cite Footer');
    try {
      const bib = Array.from({ length: 40 }, (_, i) => `@article{key${i},\n  title = {Entry number ${i}},\n  author = {Doe, Jane},\n  year = {2020}\n}\n`).join('\n');
      await put(request, id, 'references.bib', `@book{knuth,\n  title = {The {\\TeX}book},\n  author = {Knuth, Donald E.},\n  year = {1984}\n}\n\n${bib}`);
      await page.setViewportSize({ width: 1280, height: 720 });
      await openProject(page, id);
      await openPluginTab(page, 'references');
      await expect(page.getByTestId('cite-bib-key39')).toBeAttached({ timeout: 15_000 });
      // TeX markup prints as it would typeset, not cut at the first command
      await expect(page.getByTestId('cite-bib-knuth')).toContainText('The TeXbook');
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
