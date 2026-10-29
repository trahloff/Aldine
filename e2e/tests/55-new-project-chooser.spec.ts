import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { cleanup, createProject } from './helpers';

/**
 * The New project chooser: a sheet with a category rail, a search, page-1
 * previews and the name in the footer. Geometry and keyboard are asserted
 * directly, since a sheet that hides its footer or a grid that ignores the
 * arrow keys still reports every element visible.
 */
interface Template { id: string; name: string; kit?: { host: string }; preview?: { w: number; h: number; v: string } }

async function templates(request: APIRequestContext): Promise<Template[]> {
  const res = await request.get('/api/templates');
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function openChooser(page: Page) {
  await page.goto('/');
  // a phone has the compact bar: New project is the first entry of the + sheet
  const add = page.getByTestId('home-add');
  await expect(add.or(page.getByTestId('new-project'))).toBeVisible();
  if (await add.isVisible()) {
    await add.click();
    await page.getByTestId('home-add-sheet').getByTestId('new-project').click();
  } else {
    await page.getByTestId('new-project').click();
  }
  await expect(page.getByTestId('new-project-sheet')).toBeVisible();
  await expect(page.getByTestId('template-article')).toBeVisible();
}

const pressed = (page: Page) => page.locator('[data-testid="template-grid"] [role="option"][aria-selected="true"]');

test.describe('New project chooser', () => {
  // Projects on the shelf put the blank New project tile beside the chooser's
  // trigger; the tile and the open sheet must never share a test id.
  const seeded: string[] = [];
  test.beforeAll(async ({ request }) => {
    for (const name of ['Chooser shelf one', 'Chooser shelf two']) seeded.push(await createProject(request, name));
  });
  test.afterAll(async ({ request }) => {
    for (const id of seeded) await cleanup(request, id);
  });

  test('the blank tile on a short shelf opens the same sheet', async ({ page, request }) => {
    const shelf = (await (await request.get('/api/projects')).json()) as unknown[];
    test.skip(shelf.length > 3, 'the blank tile ends only a shelf of three or fewer projects');
    await page.goto('/');
    const tile = page.getByTestId('new-project-tile');
    await expect(tile).toBeVisible();
    await expect(page.getByTestId('new-project-sheet')).toHaveCount(0);
    await tile.click();
    await expect(page.getByTestId('new-project-sheet')).toHaveCount(1);
    await expect(page.getByTestId('new-project-sheet')).toBeVisible();
    await expect(page.getByTestId('template-article')).toBeVisible();
  });

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

  test('the rail holds only tabs, and the templates are one listbox of options', async ({ page }) => {
    await openChooser(page);
    const rail = page.getByTestId('template-rail');
    await expect(rail).toHaveAttribute('role', 'tablist');
    await expect(rail).toHaveAttribute('aria-orientation', 'vertical');
    const roles = await rail.evaluate((el) => Array.from(el.children, (c) => c.getAttribute('role')));
    expect(roles.length).toBeGreaterThan(1);
    expect(new Set(roles)).toEqual(new Set(['tab']));
    // The refresh button sits beside the rail, not inside it.
    await expect(page.getByTestId('template-refresh')).toBeVisible();
    await expect(rail.getByTestId('template-refresh')).toHaveCount(0);

    const list = page.getByRole('listbox', { name: 'Templates' });
    await expect(list).toHaveCount(1);
    await expect(list.getByRole('option', { name: /^Article/ })).toHaveAttribute('aria-selected', 'true');
    await expect(list.getByRole('group').first()).toHaveAccessibleName(/.+/);
    expect(await page.locator('[data-testid="template-grid"] [aria-pressed]').count()).toBe(0);
    // Arrow moves are announced by focus; the choice line itself is not live.
    await expect(page.getByTestId('template-choice')).not.toHaveAttribute('aria-live', /.*/);
    await page.getByTestId('template-search').fill('presen');
    await expect(page.getByTestId('template-announce')).toContainText('Starting from Presentation');
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
    await expect(article).toHaveAttribute('aria-selected', 'true');
    await article.focus();
    await page.keyboard.press('ArrowRight');
    const next = pressed(page);
    await expect(next).toHaveCount(1);
    await expect(next).toBeFocused();
    await expect(article).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('ArrowLeft');
    await expect(article).toHaveAttribute('aria-selected', 'true');
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

  test('every shipped template shows page 1, rendered before release and served with a long cache', async ({ page, request }) => {
    const list = await templates(request);
    for (const id of ['article', 'beamer', 'report', 'iac-paper']) {
      const t = list.find((x) => x.id === id);
      expect(t?.preview, `${id} has a shipped preview`).toBeTruthy();
    }
    const article = list.find((t) => t.id === 'article')!;
    const res = await request.get(`/api/templates/preview?id=article&v=${article.preview!.v}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/jpeg');
    expect(res.headers()['cache-control']).toContain('max-age=31536000, immutable');
    // Venue tiles rendered in CI: whichever the catalog lists with an image is served.
    for (const t of list.filter((x) => x.id.startsWith('venue:') && x.preview)) {
      const v = await request.get(`/api/templates/preview?id=${encodeURIComponent(t.id)}&v=${t.preview!.v}`);
      expect(v.status(), `${t.id} serves the page it names`).toBe(200);
      expect(v.headers()['content-type']).toBe('image/jpeg');
    }

    await openChooser(page);
    const img = page.getByTestId('template-preview-article');
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
      const tiles = page.locator('[data-testid="template-category-General"] [role="option"]');
      const a = (await tiles.nth(0).boundingBox())!;
      const b = (await tiles.nth(1).boundingBox())!;
      const c = (await tiles.nth(2).boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(2);
      expect(c.y).toBeGreaterThan(a.y + 10);
      await expect(page.getByTestId('create-project')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await expect(page.getByTestId('template-rail')).toHaveAttribute('aria-orientation', 'horizontal');
    });

    test('opening the sheet does not raise the keyboard; tapping the name selects it', async ({ page }) => {
      await openChooser(page);
      const name = page.getByLabel('Project name');
      await expect(name).toHaveValue('Untitled project');
      await expect(name).not.toBeFocused();
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toMatch(/^(INPUT|TEXTAREA)$/);
      await name.tap();
      await expect(name).toBeFocused();
      expect(await name.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 'Untitled project'.length]);
    });
  });
});
