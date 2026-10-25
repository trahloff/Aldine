import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { cleanup } from './helpers';

/**
 * The New project chooser: a sheet with a category rail, a search, page-1
 * previews and the name in the footer. Geometry and keyboard are asserted
 * directly, since a sheet that hides its footer or a grid that ignores the
 * arrow keys still reports every element visible.
 */
interface Template { id: string; name: string; kit?: { host: string }; preview?: { w: number; h: number; v: string } }

const COMPILER = process.env.COMPILER_URL || 'http://localhost:4020';

async function templates(request: APIRequestContext): Promise<Template[]> {
  const res = await request.get('/api/templates');
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function openChooser(page: Page) {
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('new-project-sheet')).toBeVisible();
  await expect(page.getByTestId('template-article')).toBeVisible();
}

const pressed = (page: Page) => page.locator('[data-testid="template-grid"] button.tpl[aria-pressed="true"]');

test.describe('New project chooser', () => {
  test('a sheet with the name prefilled and selected, a rail, and no emoji', async ({ page }) => {
    await openChooser(page);
    // min(960px, 92vw) x min(720px, 86vh) at 1440x900, once the open animation has settled
    await expect.poll(async () => {
      const box = (await page.getByTestId('new-project-sheet').boundingBox())!;
      return [Math.round(box.width), Math.round(box.height)];
    }).toEqual([960, 720]);

    const name = page.getByLabel('Project name');
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Untitled project');
    expect(await name.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 'Untitled project'.length]);

    await expect(page.getByTestId('template-rail-all')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('template-rail-General')).toBeVisible();
    const text = await page.getByTestId('new-project-sheet').innerText();
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  test('the rail moves with up and down and shows one group', async ({ page }) => {
    await openChooser(page);
    await page.getByTestId('template-rail-all').focus();
    await page.keyboard.press('ArrowDown');
    const second = page.locator('[data-testid="template-rail"] [role="tab"]').nth(1);
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(second).toBeFocused();
    const key = (await second.getAttribute('data-testid'))!.replace('template-rail-', '');
    const groups = page.locator('[data-testid="template-grid"] .tpl-group');
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toHaveAttribute('data-testid', key.startsWith('repo:') ? `template-category-repo-${key.slice(5)}` : `template-category-${key}`);
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('template-rail-all')).toHaveAttribute('aria-selected', 'true');
    expect(await groups.count()).toBeGreaterThan(0);
  });

  test('arrows move the choice through the grid, typing searches, Enter creates', async ({ page, request }) => {
    await openChooser(page);
    const article = page.getByTestId('template-article');
    await expect(article).toHaveAttribute('aria-pressed', 'true');
    await article.focus();
    await page.keyboard.press('ArrowRight');
    const next = pressed(page);
    await expect(next).toHaveCount(1);
    await expect(next).toBeFocused();
    await expect(article).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('ArrowLeft');
    await expect(article).toHaveAttribute('aria-pressed', 'true');
    await expect(article).toBeFocused();
    // Down lands on a tile below, never on the same row
    const top = (await article.boundingBox())!.y;
    await page.keyboard.press('ArrowDown');
    const below = pressed(page);
    if ((await below.getAttribute('data-testid')) !== 'template-article') {
      expect((await below.boundingBox())!.y).toBeGreaterThan(top + 10);
      await page.keyboard.press('ArrowUp');
    }

    // Typeahead: a letter on a tile goes to the search
    await page.getByTestId('template-article').focus();
    await page.keyboard.type('presen');
    const search = page.getByTestId('template-search');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('presen');
    await expect(page.getByTestId('template-beamer')).toBeVisible();
    await expect(page.getByTestId('template-article')).toHaveCount(0);
    await expect(page.getByTestId('template-choice')).toContainText('Presentation');

    // Down from the search enters the grid; Enter on a tile creates from it
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('template-beamer')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('project-name')).toHaveText('Untitled project');
    const id = page.url().split('/p/')[1].split('?')[0];
    try {
      const files = await (await request.get(`/api/projects/${id}/files?branch=main`)).json();
      expect(JSON.stringify(files)).toContain('main.tex');
    } finally { await cleanup(request, id); }
  });

  test('typing a name and pressing Enter creates; Escape closes', async ({ page, request }) => {
    await openChooser(page);
    await page.keyboard.type('Chooser Paper');
    await expect(page.getByLabel('Project name')).toHaveValue('Chooser Paper');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('new-project-sheet')).toHaveCount(0);

    await openChooser(page);
    await page.keyboard.type('Chooser Paper');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('project-name')).toHaveText('Chooser Paper');
    await cleanup(request, page.url().split('/p/')[1].split('?')[0]);
  });

  test('a venue kit without a preview shows a serif title page', async ({ page, request }) => {
    let kit: Template | undefined;
    for (let i = 0; i < 15 && !kit; i++) {
      kit = (await templates(request)).find((t) => t.kit && !t.preview);
      if (!kit) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(kit, 'the fetched-venue registry is served').toBeTruthy();
    await openChooser(page);
    await page.getByTestId('template-search').fill(kit!.name);
    const ph = page.getByTestId(`template-placeholder-${kit!.id}`);
    await expect(ph).toBeVisible();
    await expect(ph).toContainText(kit!.name);
    const font = await ph.locator('.tpl__ph-title').evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).toMatch(/Iowan|Palatino|Georgia|serif/);
    const bg = await ph.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(250, 248, 242)');
  });

  test('a shipped template shows page 1, served with a long cache', async ({ page, request }) => {
    test.setTimeout(180_000);
    const health = await request.get(`${COMPILER}/health`).then((r) => r.json()).catch(() => null);
    test.skip(!health || health.thumbnails === 'none', 'the compiler cannot render page 1 (no gs or pdftoppm)');
    // Any shipped template will do: a BasicTeX compiler cannot typeset the
    // biblatex ones, and their tiles keep the placeholder.
    const shipped = ['article', 'beamer', 'report', 'iac-paper'];
    let rendered: Template | undefined;
    await expect.poll(async () => {
      rendered = (await templates(request)).find((t) => shipped.includes(t.id) && t.preview);
      return !!rendered;
    }, { timeout: 100_000, intervals: [2_000] }).toBe(true);
    const res = await request.get(`/api/templates/preview?id=${rendered!.id}&v=${rendered!.preview!.v}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/jpeg');
    expect(res.headers()['cache-control']).toContain('max-age=31536000, immutable');

    await openChooser(page);
    const img = page.getByTestId(`template-preview-${rendered!.id}`);
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('a bottom sheet with the rail as a row and two columns of pages', async ({ page }) => {
      await openChooser(page);
      const sheet = page.getByTestId('new-project-sheet');
      await expect.poll(async () => {
        const b = (await sheet.boundingBox())!;
        return [Math.round(b.x), Math.round(b.width), Math.round(b.y + b.height)];
      }).toEqual([0, 390, 844]);
      const all = (await page.getByTestId('template-rail-all').boundingBox())!;
      const general = (await page.getByTestId('template-rail-General').boundingBox())!;
      expect(Math.abs(all.y - general.y)).toBeLessThan(2);
      const tiles = page.locator('[data-testid="template-category-General"] button.tpl');
      const a = (await tiles.nth(0).boundingBox())!;
      const b = (await tiles.nth(1).boundingBox())!;
      const c = (await tiles.nth(2).boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(2);
      expect(c.y).toBeGreaterThan(a.y + 10);
      await expect(page.getByTestId('create-project')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });
  });
});
