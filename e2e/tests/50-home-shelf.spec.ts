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
    try {
      await request.delete(`/api/projects/${id}`);
      await page.goto('/?show=trash');
      await expect(page.getByTestId(`trash-${id}`)).toContainText('Deleted today · gone');
      await expect(page.getByTestId('empty-trash')).toBeVisible();
      await expect(page.getByTestId('sort-menu')).toHaveCount(0);
      await page.getByTestId(`trash-open-${id}`).click();
      await expect(page.getByTestId(`restore-${id}`)).toBeVisible();
      await expect(page.getByTestId(`purge-${id}`)).toHaveText(/Delete forever…/);
      await page.keyboard.press('Escape');
    } finally { await cleanup(request, id); }
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

test.describe('importing several ZIPs', () => {
  test('each gets a placeholder, and one line sums them up', async ({ page }) => {
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
      await page.goto('/');
      await page.getByTestId('import-input').setInputFiles([...files, bad]);
      await expect(page.locator('.toast', { hasText: 'Imported 2 projects · 1 failed' })).toBeVisible({ timeout: 60_000 });
      // still on the list, with both new projects and the failure explained
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId('project-grid')).toContainText(`multi-first-${stamp}`);
      await expect(page.getByTestId('project-grid')).toContainText(`multi-second-${stamp}`);
      await expect(page.locator('.sheet--failed')).toContainText('Not imported');
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
        await page.reload();
        await expect(page.getByTestId('projects-empty')).toBeVisible();
        await expect(page.getByTestId('start-more')).toBeVisible();
        const empty = await new AxeBuilder({ page }).analyze();
        expect(empty.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
      } finally { await cleanup(request, id); }
    });
  }
});
