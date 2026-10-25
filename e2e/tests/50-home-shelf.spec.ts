import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip, cleanup, createProject, projectAction } from './helpers';

/**
 * The project list as a shelf of first pages: the layout at every width,
 * the keyboard model, both menus, search, sort, filters in the URL, the
 * trash as a place, several ZIPs at once, and an axe pass in both themes.
 */

const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

/** Three projects with one prefix, shown alone by searching for it. */
async function trio(page: Page, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  for (const n of ['alpha', 'bravo', 'charlie']) ids.push(await createProject(page.request, `${prefix} ${n}`));
  return ids;
}

test.describe('layout', () => {
  test('no sideways scrolling from 320 to 1440 pixels', async ({ page, request }) => {
    const id = await createProject(request, 'A project with a rather long name that has to wrap onto a second line somewhere');
    try {
      for (const width of [320, 390, 768, 1024, 1180, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await expect(page.getByTestId(`project-card-${id}`)).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `at ${width}px`).toBeLessThanOrEqual(0);
        // a phone gets the compact bar and the + sheet instead of the split button
        if (width <= 390) await expect(page.getByTestId('home-add')).toBeVisible();
        else await expect(page.getByTestId('new-project')).toBeVisible();
      }
    } finally { await cleanup(request, id); }
  });

  test('landmarks, one h1, a list per section, and a meta line on each item', async ({ page, request }) => {
    const id = await createProject(request, 'Landmark Paper');
    try {
      await page.goto('/');
      await expect(page.getByRole('banner', { name: 'Projects toolbar' })).toBeVisible();
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('contentinfo')).toContainText('Source code');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects');
      const link = page.getByTestId(`open-${id}`);
      await expect(link).toHaveAttribute('href', `/p/${id}`);
      await expect(link).toHaveAccessibleDescription(/^Edited (just now|1 minute ago)/);
      await expect(page.getByTestId(`project-card-${id}`).locator('xpath=..')).toHaveAttribute('role', 'list');
      await expect(page.getByTestId(`project-menu-${id}`)).toHaveAccessibleName('Actions for Landmark Paper');
    } finally { await cleanup(request, id); }
  });

  test('a project opens on the branch it was last open on', async ({ page, request }) => {
    const id = await createProject(request, 'Branch Memory');
    try {
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'revision-2', from: 'main' } })).ok()).toBeTruthy();
      expect((await request.post(`/api/projects/${id}/opened`, { data: { branch: 'revision-2' } })).ok()).toBeTruthy();
      await page.goto('/');
      await expect(page.getByTestId(`open-${id}`)).toHaveAttribute('href', `/p/${id}?branch=revision-2`);
      await expect(page.getByTestId(`project-card-${id}`)).toContainText('revision-2');
      await page.getByTestId(`open-${id}`).click();
      await expect(page).toHaveURL(new RegExp(`/p/${id}\\?branch=revision-2`));
    } finally { await cleanup(request, id); }
  });
});

test.describe('keyboard', () => {
  test('arrows move through the shelf, Delete trashes and focus moves on, Mod+Z undoes', async ({ page }) => {
    const prefix = `Roving ${Date.now()}`;
    const ids = await trio(page, prefix);
    try {
      await page.goto('/');
      await expect(page.getByTestId('project-grid')).toBeVisible();
      await page.keyboard.press('/');
      await expect(page.getByTestId('home-search')).toBeFocused();
      await page.keyboard.type(prefix);
      await expect(page.getByTestId('search-status')).toHaveText('3 projects match');
      // newest first: charlie, bravo, alpha
      await page.keyboard.press('ArrowDown');
      expect(await focusedTestId(page)).toBe(`open-${ids[2]}`);
      await page.keyboard.press('ArrowRight');
      expect(await focusedTestId(page)).toBe(`open-${ids[1]}`);
      await page.keyboard.press('End');
      expect(await focusedTestId(page)).toBe(`open-${ids[0]}`);
      await page.keyboard.press('Home');
      expect(await focusedTestId(page)).toBe(`open-${ids[2]}`);
      // one Tab stop for the whole shelf
      await expect(page.getByTestId(`open-${ids[1]}`)).toHaveAttribute('tabindex', '-1');
      await expect(page.getByTestId(`open-${ids[2]}`)).toHaveAttribute('tabindex', '0');

      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Delete');
      await expect(page.getByTestId(`project-card-${ids[1]}`)).toHaveCount(0);
      await expect.poll(() => focusedTestId(page)).toBe(`open-${ids[0]}`);
      await expect(page.getByTestId('undo-trash')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.getByTestId(`project-card-${ids[1]}`)).toBeVisible();
      await expect(page.getByTestId('undo-trash')).toHaveCount(0);

      // Escape clears the search, then leaves the field
      await page.getByTestId('home-search').focus();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('home-search')).toHaveValue('');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('home-search')).not.toBeFocused();
      // "n" starts a project
      await page.keyboard.press('n');
      await expect(page.getByTestId('new-project-name')).toBeFocused();
      await page.keyboard.press('Escape');
    } finally { for (const id of ids) await cleanup(page.request, id); }
  });

  test('each notice keeps its own undo: Undo on the first leaves Mod+Z for the second', async ({ page }) => {
    const prefix = `Two Undos ${Date.now()}`;
    const ids = await trio(page, prefix);
    try {
      await page.goto('/');
      await page.getByTestId('home-search').fill(prefix);
      await page.getByTestId(`open-${ids[2]}`).focus();
      await page.keyboard.press('Delete');
      await expect(page.getByTestId(`project-card-${ids[2]}`)).toHaveCount(0);
      await expect.poll(() => focusedTestId(page)).toBe(`open-${ids[1]}`);
      await page.keyboard.press('Delete');
      await expect(page.getByTestId(`project-card-${ids[1]}`)).toHaveCount(0);
      // the first notice's Undo brings back the first only
      await page.locator('.toast', { hasText: `Moved ${prefix} charlie to the trash` }).getByTestId('undo-trash').click();
      await expect(page.getByTestId(`project-card-${ids[2]}`)).toBeVisible();
      await expect(page.getByTestId(`project-card-${ids[1]}`)).toHaveCount(0);
      // and Mod+Z still undoes the second, whose notice is up
      await page.getByTestId(`open-${ids[2]}`).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.getByTestId(`project-card-${ids[1]}`)).toBeVisible();
    } finally { for (const id of ids) await cleanup(page.request, id); }
  });
});

test.describe('menus', () => {
  test('the project menu opens from "…", right-click and Shift+F10, and the New project menu lists the ways in', async ({ page, request }) => {
    const id = await createProject(request, 'Menu Paper');
    try {
      await page.goto('/');
      await page.getByTestId(`project-menu-${id}`).click();
      const menu = page.getByTestId('project-menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem')).toHaveText(['Open', 'Open in new tab', 'Rename…', 'Duplicate', 'Download PDF', 'Download source (.zip)', 'Move to Trash'].map((t) => new RegExp(`^${t.replace(/[.()]/g, '\\$&')}`)));
      await expect(page.getByTestId('menu-download-pdf')).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      await page.getByTestId(`open-${id}`).click({ button: 'right' });
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');

      await page.getByTestId(`open-${id}`).focus();
      await page.keyboard.press('Shift+F10');
      await expect(page.getByTestId('menu-open')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`open-${id}`)).toBeFocused();

      await page.getByTestId('new-menu').click();
      await expect(page.getByTestId('import-zip')).toBeVisible();
      await expect(page.getByTestId('drop-hint')).toHaveText('Or drop .zip files anywhere on this page');
      await page.keyboard.press('Escape');
    } finally { await cleanup(request, id); }
  });

  test('Move to Trash from the menu moves focus to the next project, and Undo brings focus back to it', async ({ page }) => {
    const prefix = `Menu Trash ${Date.now()}`;
    const ids = await trio(page, prefix);
    try {
      await page.goto('/');
      await page.getByTestId('home-search').fill(prefix);
      // newest first: charlie, bravo, alpha
      await page.getByTestId(`open-${ids[1]}`).focus();
      await page.getByTestId(`open-${ids[1]}`).press('Shift+F10');
      await page.getByTestId('menu-trash').press('Enter');
      await expect(page.getByTestId(`project-card-${ids[1]}`)).toHaveCount(0);
      await expect.poll(() => focusedTestId(page)).toBe(`open-${ids[0]}`);
      await page.getByTestId('undo-trash').click();
      await expect(page.getByTestId(`project-card-${ids[1]}`)).toBeVisible();
      await expect.poll(() => focusedTestId(page)).toBe(`open-${ids[1]}`);
    } finally { for (const id of ids) await cleanup(page.request, id); }
  });

  test('Rename and Duplicate', async ({ page, request }) => {
    const id = await createProject(request, `Dup Source ${Date.now()}`);
    let copy: string | undefined;
    try {
      await page.goto('/');
      await projectAction(page, id, 'menu-rename');
      await page.getByTestId('dialog-input').fill('Dup Renamed');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId(`open-${id}`)).toHaveText('Dup Renamed');
      await projectAction(page, id, 'menu-duplicate');
      await expect(page.locator('.toast', { hasText: 'Duplicated Dup Renamed as “Dup Renamed copy”' })).toBeVisible();
      const item = page.locator('[data-testid^="project-card-"]', { hasText: 'Dup Renamed copy' });
      await expect(item).toBeVisible();
      copy = (await item.getAttribute('data-id')) ?? undefined;
      await expect.poll(() => focusedTestId(page)).toBe(`open-${copy}`);
    } finally {
      await cleanup(request, id);
      if (copy) await cleanup(request, copy);
    }
  });
});

test.describe('search, sort and filters', () => {
  test('search filters in place; the sort is remembered; filters live in the URL', async ({ page }) => {
    const prefix = `Sortable ${Date.now()}`;
    const ids = await trio(page, prefix);
    try {
      await page.goto('/');
      await page.getByTestId('home-search').fill(`${prefix} bravo`);
      await expect(page.getByTestId('search-status')).toHaveText('1 project matches');
      await expect(page.locator('[data-testid^="project-card-"]')).toHaveCount(1);
      await page.getByTestId('home-search').fill(`${prefix} zz`);
      await expect(page.getByTestId('search-empty')).toBeVisible();
      await page.getByTestId('search-clear').click();

      await page.getByTestId('home-search').fill(prefix);
      const names = () => page.locator('.sheet__link .sheet__name').allTextContents();
      await expect.poll(names).toEqual([`${prefix} charlie`, `${prefix} bravo`, `${prefix} alpha`]);
      await page.getByTestId('sort-menu').click();
      await page.getByTestId('sort-name').click();
      await expect.poll(names).toEqual([`${prefix} alpha`, `${prefix} bravo`, `${prefix} charlie`]);
      await expect(page.getByTestId('sort-menu')).toContainText('Name');
      await page.reload();
      await expect(page.getByTestId('sort-menu')).toContainText('Name');
      await page.getByTestId('sort-menu').click();
      await page.getByTestId('sort-edited').click();

      await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-current', 'page');
      await page.getByTestId('open-trash').click();
      await expect(page).toHaveURL(/\?show=trash$/);
      await expect(page.getByTestId('open-trash')).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('filter-all')).not.toHaveAttribute('aria-current', 'page');
      await page.goBack();
      await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-current', 'page');
      // no accounts on this server: no Shared with me
      await expect(page.getByTestId('filter-shared')).toHaveCount(0);
    } finally { for (const id of ids) await cleanup(page.request, id); }
  });

  test('the trash says when each project goes for good and offers to empty it', async ({ page, request }) => {
    const id = await createProject(request, 'Trash Place Paper');
    const other = await createProject(request, 'Trash Place Other');
    try {
      // whatever earlier tests left there goes first, so this one knows what Empty trash leaves
      for (const t of (await (await request.get('/api/projects/trash')).json()) as { id: string }[]) await request.delete(`/api/projects/${t.id}?permanent=1`);
      await request.delete(`/api/projects/${id}`);
      await request.delete(`/api/projects/${other}`);
      await page.goto('/?show=trash');
      await expect(page.getByTestId(`trash-${id}`)).toContainText('Deleted today · gone');
      await expect(page.getByTestId('empty-trash')).toBeVisible();
      await expect(page.getByTestId('sort-menu')).toHaveCount(0);
      // the item itself opens its menu and says so
      const item = page.getByTestId(`trash-open-${id}`);
      await expect(item).toHaveAttribute('aria-expanded', 'false');
      await item.focus();
      await page.keyboard.press('Enter');
      await expect(item).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId(`restore-${id}`)).toBeFocused();
      await expect(page.getByTestId(`purge-${id}`)).toHaveText(/Delete forever…/);
      await page.keyboard.press('Escape');
      await expect(item).toBeFocused();
      // the trash lists the last one moved there first
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId(`trash-open-${other}`)).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(item).toBeFocused();

      // Restore takes it off the trash and focus moves on, not to the page
      await page.keyboard.press('Enter');
      await page.getByTestId(`restore-${id}`).press('Enter');
      await expect(page.getByTestId(`trash-${id}`)).toHaveCount(0);
      await expect.poll(() => focusedTestId(page)).toBe(`trash-open-${other}`);

      // Empty trash takes its own button away: focus goes to the title
      await page.getByTestId('empty-trash').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('trash-empty')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    } finally { await cleanup(request, id); await cleanup(request, other); }
  });
});

test.describe('loading', () => {
  test('a failed load says why, offers Try again, and the list comes back', async ({ page, request }) => {
    const id = await createProject(request, 'Back Again Paper');
    try {
      let fail = true;
      await page.route(/\/api\/projects$/, (route) => (fail ? route.fulfill({ status: 503, json: { error: 'down for maintenance' } }) : route.continue()));
      await page.goto('/');
      const alert = page.getByTestId('projects-error');
      await expect(alert).toHaveAttribute('role', 'alert');
      await expect(alert).toContainText('down for maintenance');
      fail = false;
      await page.getByTestId('projects-retry').click();
      await expect(page.getByTestId(`project-card-${id}`)).toBeVisible();
      await expect(alert).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a long press opens the project menu as a sheet from the bottom, without key hints', async ({ page, request }) => {
    const id = await createProject(request, 'Long Press Paper');
    try {
      await page.goto('/');
      const link = page.getByTestId(`open-${id}`);
      await link.scrollIntoViewIfNeeded();
      const box = (await link.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const at = [{ x: box.x + 20, y: box.y + box.height / 2 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const sheet = page.getByTestId('project-menu');
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute('role', 'dialog');
      await expect(page.getByTestId('project-menu-title')).toHaveText('Long Press Paper');
      // opened by touch: the sheet holds focus, not its first row, so no ring marks "Open"
      await expect(sheet).toBeFocused();
      await expect(page.getByTestId('menu-trash')).toHaveText('Move to Trash');
      await expect(page.locator('.menu__hint')).toHaveCount(0);
      // the press did not open the project
      await expect(page).toHaveURL(/\/$/);
      await page.getByTestId('project-menu-cancel').click();
      await expect(sheet).toHaveCount(0);

      // the + sheet: every label starts at the same place
      await page.getByTestId('home-add').click();
      const xs = await page.getByTestId('home-add-sheet').locator('.action-sheet__item:not(.action-sheet__cancel) .action-sheet__icon').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
      expect(new Set(xs).size).toBe(1);
    } finally { await cleanup(request, id); }
  });
});

test.describe('importing several ZIPs', () => {
  test('each gets a placeholder with Cancel, and one line sums them up', async ({ page }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-multi-'));
    const stamp = Date.now();
    const files = ['first', 'second'].map((n) => {
      const f = path.join(dir, `multi-${n}-${stamp}.zip`);
      fs.writeFileSync(f, buildZip({ 'main.tex': doc(n) }));
      return f;
    });
    const bad = path.join(dir, `multi-broken-${stamp}.zip`);
    fs.writeFileSync(bad, 'not a zip at all');
    try {
      // started from the trash: the placeholders are drawn in the list of all projects, so it goes there
      await page.goto('/?show=trash');
      // The first upload is held before it reaches the server, so Cancel still calls it off.
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let first = true;
      await page.route('**/api/projects/import', async (route) => {
        // the page has called it off by then: it never reaches the server
        if (first) { first = false; await held; await route.abort().catch(() => {}); return; }
        await route.continue();
      });
      await page.getByTestId('import-input').setInputFiles([...files, bad]);
      await expect(page).toHaveURL(/\/$/);
      const sheet = page.locator('.sheet--import', { hasText: `multi-first-${stamp}` });
      await expect(sheet).toContainText('Uploading');
      await sheet.getByRole('button', { name: `Cancel import of multi-first-${stamp}` }).click();
      await expect(sheet).toHaveCount(0);
      release();
      await expect(page.locator('.toast', { hasText: 'Imported 1 project · 1 failed' })).toBeVisible({ timeout: 60_000 });
      // still on the list, with the new project and the failure explained; the cancelled one was never made
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId('project-grid')).toContainText(`multi-second-${stamp}`);
      await expect(page.getByTestId('project-grid')).not.toContainText(`multi-first-${stamp}`);
      await expect(page.locator('.sheet--failed')).toContainText('Not imported');
      const names = ((await (await page.request.get('/api/projects')).json()) as { name: string }[]).map((p) => p.name);
      expect(names).not.toContain(`multi-first-${stamp}`);
    } finally {
      const list = (await (await page.request.get('/api/projects')).json()) as { id: string; name: string }[];
      for (const p of list.filter((x) => x.name.includes(String(stamp)))) await cleanup(page.request, p.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('accessibility', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`axe finds nothing on the shelf and the empty list, ${theme}`, async ({ page, request }) => {
      const id = await createProject(request, `Axe Paper ${theme}`);
      try {
        await page.addInitScript((t) => localStorage.setItem('aldine.theme', t), theme);
        await page.goto('/');
        await expect(page.getByTestId(`project-card-${id}`)).toBeVisible();
        const many = await new AxeBuilder({ page }).analyze();
        expect(many.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);

        await page.route(/\/api\/projects$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
        // the list kept for the tab would otherwise be what axe sees first
        await page.evaluate(() => sessionStorage.clear());
        await page.reload();
        await expect(page.getByTestId('projects-empty')).toBeVisible();
        await expect(page.getByTestId('start-more')).toBeVisible();
        const empty = await new AxeBuilder({ page }).analyze();
        expect(empty.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
        // the starting points are one Tab stop with arrows
        await expect(page.getByTestId('start-blank')).toHaveAttribute('tabindex', '0');
        await expect(page.getByTestId('start-more')).toHaveAttribute('tabindex', '-1');
        await page.getByTestId('start-blank').focus();
        await page.keyboard.press('End');
        await expect(page.getByTestId('start-more')).toBeFocused();
        await expect(page.getByTestId('start-more')).toHaveAttribute('tabindex', '0');
        await page.keyboard.press('Home');
        await expect(page.getByTestId('start-blank')).toBeFocused();
      } finally { await cleanup(request, id); }
    });
  }

  test('axe finds nothing in the trash or at phone width', async ({ page, request }) => {
    const id = await createProject(request, 'Axe Trash Paper');
    try {
      await request.delete(`/api/projects/${id}`);
      await page.goto('/?show=trash');
      await expect(page.getByTestId(`trash-${id}`)).toBeVisible();
      await expect(page.getByTestId('trash-note')).toHaveText(/^Projects in the trash are deleted \d+ days? after you move them there\.$/);
      const trash = await new AxeBuilder({ page }).analyze();
      expect(trash.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
      await request.post(`/api/projects/${id}/restore`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      await expect(page.getByTestId(`project-card-${id}`)).toBeVisible();
      const phone = await new AxeBuilder({ page }).analyze();
      expect(phone.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
    } finally { await cleanup(request, id); }
  });

  test('in forced colors the current filter is still marked', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/');
    await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-current', 'page');
    const fill = (id: string) => page.getByTestId(id).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await fill('filter-all')).not.toBe(await fill('open-trash'));
  });
});

test.describe('the list kept for the tab', () => {
  test('a return draws the list before the server answers, and keeps no addresses', async ({ page, request }) => {
    const id = await createProject(request, `Cached Paper ${Date.now()}`);
    try {
      await page.goto('/');
      await expect(page.getByTestId(`project-card-${id}`)).toBeVisible();
      await page.getByTestId(`open-${id}`).click();
      await expect(page).toHaveURL(new RegExp(`/p/${id}`));
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      await page.route(/\/api\/projects$/, async (route) => { if (route.request().method() === 'GET') await held; await route.continue(); });
      await page.goBack();
      // drawn from the cache while the list request is still held
      await expect(page.getByTestId(`project-card-${id}`)).toBeVisible();
      const kept = await page.evaluate(() => sessionStorage.getItem('aldine.home.list:local'));
      expect(kept).not.toContain('@');
      const rows = JSON.parse(kept!) as { zotero: unknown; remote?: { fullName: string } | null }[];
      expect(rows.every((r) => r.zotero === null && (!r.remote || r.remote.fullName === ''))).toBe(true);
      release();
    } finally { await cleanup(request, id); }
  });
});
