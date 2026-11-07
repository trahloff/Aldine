import { test, expect } from '../fixtures';
import type { Locator, Page } from '@playwright/test';
import { createProject, createPaperProject, openProject, cleanup, expectTypesetOk, phoneMore } from './helpers';

/**
 * The app shell around the editor: the sidebar and the branch menu on a
 * phone, touch sizes, the dividers on a tablet, dialogs that keep what was
 * typed in them, toasts, and the keyboard in the editor's menus.
 */

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };

const put = (request: import('@playwright/test').APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });

const MAIN = '\\documentclass{article}\n\\begin{document}\nMain text.\n\\end{document}\n';

async function height(l: Locator) { return (await l.boundingBox())!.height; }
async function width(l: Locator) { return (await l.boundingBox())!.width; }

/** Is the element the one drawn at its own centre, not covered by something else? */
async function onTop(page: Page, l: Locator) {
  const b = (await l.boundingBox())!;
  const handle = await l.elementHandle();
  return page.evaluate(({ x, y, el }) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el!.contains(hit));
  }, { x: b.x + b.width / 2, y: b.y + b.height / 2, el: handle });
}

test.describe('app shell on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('the sidebar starts folded over an open file, folds when a file opens, and folds on a tap beside it', async ({ page, request }) => {
    const id = await createProject(request, 'Phone Shell');
    try {
      await put(request, id, 'main.tex', MAIN);
      await put(request, id, 'chapter2.tex', 'Chapter two.\n');
      await openProject(page, id);
      await expect(page.getByTestId('sidebar')).toBeHidden();

      await phoneMore(page, 'sidebar-toggle', 'tap');
      const sidebar = page.getByTestId('sidebar');
      await expect(sidebar).toBeVisible();
      // the overlay ends at the bottom of the screen, and the page does not scroll
      expect((await sidebar.boundingBox())!.y + await height(sidebar)).toBeLessThanOrEqual(PHONE.height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);

      // a file opened from the tree comes up with the sidebar out of the way
      await page.getByTestId('file-chapter2.tex').tap();
      await expect(sidebar).toBeHidden();
      await expect(page.getByTestId('active-file')).toHaveText('chapter2.tex');

      // a tap on the strip of editor beside the overlay folds it
      await phoneMore(page, 'sidebar-toggle', 'tap');
      await expect(sidebar).toBeVisible();
      await page.touchscreen.tap(PHONE.width - 15, PHONE.height / 2);
      await expect(sidebar).toBeHidden();
      await expect(page.getByTestId('active-file')).toHaveText('chapter2.tex');

      // and so does a file opened from the palette
      await phoneMore(page, 'sidebar-toggle', 'tap');
      await phoneMore(page, 'more-palette', 'tap');
      await page.getByTestId('palette-input').fill('main.tex');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      await expect(sidebar).toBeHidden();
    } finally { await cleanup(request, id); }
  });

  test('the branch menu fits the screen and is not covered by the sidebar', async ({ page, request }) => {
    const id = await createProject(request, 'Phone Branches');
    const branch = 'revision-with-a-long-name';
    try {
      await put(request, id, 'main.tex', MAIN);
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: branch, from: 'main' } })).ok()).toBeTruthy();
      await openProject(page, id);
      await phoneMore(page, 'sidebar-toggle', 'tap');
      await expect(page.getByTestId('sidebar')).toBeVisible();
      await page.getByTestId('branch-menu').tap();
      const menu = page.getByTestId('branch-list');
      await expect(page.getByTestId(`delete-${branch}`)).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
      const del = (await page.getByTestId(`delete-${branch}`).boundingBox())!;
      expect(del.x + del.width).toBeLessThanOrEqual(PHONE.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await onTop(page, page.getByTestId(`merge-${branch}`))).toBe(true);
      expect(await onTop(page, page.getByTestId('new-branch'))).toBe(true);
      // its rows are finger-sized, once the menu has finished opening
      await menu.evaluate((el) => Promise.all((el.closest('.branch-menu') ?? el).getAnimations({ subtree: true }).map((a) => a.finished)));
      expect(await height(page.getByTestId('branch-main'))).toBeGreaterThanOrEqual(44);
    } finally { await cleanup(request, id); }
  });

  test('tree rows, tabs and the toolbar controls are big enough to tap', async ({ page, request }) => {
    const id = await createProject(request, 'Phone Touch');
    try {
      await put(request, id, 'main.tex', MAIN);
      await openProject(page, id);
      await phoneMore(page, 'sidebar-toggle', 'tap');
      await expect(page.getByTestId('file-main.tex')).toBeVisible();
      expect(await height(page.getByTestId('file-main.tex'))).toBeGreaterThanOrEqual(40);
      for (const t of ['tab-files', 'tab-review', 'tab-more']) expect(await height(page.getByTestId(t))).toBeGreaterThanOrEqual(40);
      for (const t of ['tab-search', 'sidebar-collapse']) {
        expect(await height(page.getByTestId(t))).toBeGreaterThanOrEqual(40);
        expect(await width(page.getByTestId(t))).toBeGreaterThanOrEqual(40);
      }
      expect(await height(page.getByTestId('branch-menu'))).toBeGreaterThanOrEqual(44);
      for (const t of ['toolbar-more', 'typeset-button']) expect(await height(page.getByTestId(t))).toBeGreaterThanOrEqual(44);
    } finally { await cleanup(request, id); }
  });

  test('an error toast can be dismissed and stays clear of an open sheet\'s buttons', async ({ page, request }) => {
    const id = await createProject(request, 'Phone Toast Sheet');
    try {
      await put(request, id, 'main.tex', MAIN);
      await page.goto(`/p/${id}?file=missing.tex`);
      const toast = page.locator('.toast', { hasText: 'is not in this project' });
      await expect(toast).toBeVisible();
      await phoneMore(page, 'more-settings', 'tap');
      const close = page.getByTestId('settings-close');
      await expect(close).toBeVisible();
      await expect.poll(async () => (await toast.boundingBox())!.y).toBeLessThan(PHONE.height / 3);
      const row = (await page.locator('.modal .modal__row').boundingBox())!;
      const t = (await toast.boundingBox())!;
      expect(t.y + t.height).toBeLessThanOrEqual(row.y);
      // the sheet scrolls; its Close sits at the end
      await close.scrollIntoViewIfNeeded();
      expect(await onTop(page, close)).toBe(true);

      await toast.getByTestId('toast-dismiss').tap();
      await expect(toast).toHaveCount(0);
      await expect(page.getByTestId('project-settings')).toBeVisible();
    } finally { await cleanup(request, id); }
  });
});

test.describe('app shell on a tablet', () => {
  test.use({ viewport: TABLET, hasTouch: true });

  test('both dividers are there, and the preview controls are big enough to tap', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Tablet Shell');
    try {
      await openProject(page, id);
      // portrait is narrower than 800px: the editor alone until both are chosen
      await expect(page.getByTestId('layout-editor')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('layout-both').tap();
      await expectTypesetOk(page);
      for (const t of ['sidebar-resizer', 'pane-resizer']) await expect(page.getByTestId(t)).toBeVisible();
      // each one moves the editor's edge
      const editor = page.locator('.pane--editor');
      const before = await width(editor);
      await page.getByTestId('sidebar-resizer').focus();
      await page.keyboard.press('Shift+ArrowLeft');
      await expect.poll(async () => await width(editor)).toBeGreaterThan(before + 20);
      const wider = await width(editor);
      await page.getByTestId('pane-resizer').focus();
      await page.keyboard.press('Shift+ArrowLeft');
      await expect.poll(async () => await width(editor)).toBeLessThan(wider - 20);

      for (const name of ['Zoom out', 'Zoom in']) {
        const b = page.getByTestId('zoom-controls').getByRole('button', { name });
        expect(await height(b)).toBeGreaterThanOrEqual(36);
        expect(await width(b)).toBeGreaterThanOrEqual(36);
      }
      expect(await height(page.getByTestId('pdf-page-indicator'))).toBeGreaterThanOrEqual(36);

      await page.getByTestId('sidebar-collapse').tap();
      const expand = page.getByTestId('sidebar-expand');
      expect(await height(expand)).toBeGreaterThanOrEqual(40);
      expect(await width(expand)).toBeGreaterThanOrEqual(40);
    } finally {
      await page.evaluate(() => { localStorage.removeItem('aldine.sidebarHidden'); localStorage.removeItem('aldine.layout'); }).catch(() => {});
      await cleanup(request, id);
    }
  });
});

test.describe('dialogs and menus', () => {
  test('a text drag that ends outside a dialog keeps it open with what was typed', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    const sheet = page.getByTestId('new-project-sheet');
    const name = page.getByTestId('new-project-name');
    await name.fill('Kept while selecting');
    const field = (await name.boundingBox())!;
    const panel = (await sheet.boundingBox())!;
    // a point on the backdrop, beside the panel or above it
    const outside = panel.x > 20 ? { x: panel.x / 2, y: field.y + field.height / 2 } : { x: field.x + 20, y: panel.y / 2 };

    await page.mouse.move(field.x + field.width - 4, field.y + field.height / 2);
    await page.mouse.down();
    await page.mouse.move(outside.x, outside.y, { steps: 6 });
    await page.mouse.up();
    await expect(sheet).toBeVisible();
    await expect(name).toHaveValue('Kept while selecting');

    // nor does a press that starts on the backdrop and ends in the panel
    await page.mouse.move(outside.x, outside.y);
    await page.mouse.down();
    await page.mouse.move(field.x + 10, field.y + field.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(sheet).toBeVisible();

    // a click on the backdrop still closes it
    await page.mouse.click(outside.x, outside.y);
    await expect(sheet).toHaveCount(0);
  });

  test('More opens from the keyboard, moves with the arrows and gives focus back', async ({ page, request }) => {
    const id = await createProject(request, 'More Keys');
    try {
      await openProject(page, id);
      const more = page.getByTestId('tab-more');
      await expect(more).toBeVisible({ timeout: 15_000 });
      await more.focus();
      await page.keyboard.press('ArrowDown');
      const menu = page.getByTestId('tab-more-menu');
      await expect(menu).toBeVisible();
      const first = menu.getByRole('menuitemradio').first();
      await expect(first).toBeFocused();
      const title = ((await first.textContent()) ?? '').trim();
      await page.keyboard.press('ArrowDown');
      await expect(first).not.toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(more).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(first).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(more).toHaveAttribute('aria-label', `More panels: ${title}`);
      await expect(more).toHaveAttribute('aria-selected', 'true');
      await expect(more).toBeFocused();
    } finally { await cleanup(request, id); }
  });

  test('Escape in the branch menu gives focus back to the pill', async ({ page, request }) => {
    const id = await createProject(request, 'Branch Keys');
    try {
      await openProject(page, id);
      const pill = page.getByTestId('branch-menu');
      // it holds a field and switches: a disclosure, not an ARIA menu
      await expect(pill).not.toHaveAttribute('aria-haspopup', /.*/);
      await pill.click();
      await expect(pill).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('branch-main')).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('branch-main')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('branch-list')).toHaveCount(0);
      await expect(pill).toBeFocused();

      // Escape in the new-branch field cancels it, and focus stays in the menu
      await pill.click();
      await page.getByTestId('new-branch').click();
      await expect(page.getByTestId('new-branch-name')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('new-branch-name')).toHaveCount(0);
      await expect(page.getByTestId('new-branch')).toBeFocused();
      await expect(page.getByTestId('branch-list')).toBeVisible();
    } finally { await cleanup(request, id); }
  });
});
