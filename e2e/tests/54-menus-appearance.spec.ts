import { test, expect } from '../fixtures';
import { createPaperProject, createProject, openProject, cleanup, projectAction } from './helpers';

/**
 * The shared pieces the project list and the editor stand on: the menu
 * (keyboard, pointer, placement, focus), Appearance with "Match system",
 * dialogs as sheets on a phone, the palette as a combobox, page titles.
 */

const themeOf = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.dataset.theme);
const metaColor = (page: import('@playwright/test').Page) => page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute('content'));

test.describe('appearance', () => {
  test('Match system follows the operating system, before and after first paint', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    // nothing stored: dark, whatever the system says
    expect(await themeOf(page)).toBe('dark');

    // no accounts here: Appearance lives in the "…" menu
    const toggle = page.getByTestId('home-more');
    await expect(toggle).toHaveAttribute('aria-haspopup', 'menu');
    await toggle.click();
    await page.getByTestId('appearance').click();
    const menu = page.getByTestId('appearance-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemradio', { name: 'Match system' }).click();
    await expect(menu).toHaveCount(0);
    await expect(toggle).toBeFocused();

    await expect.poll(() => themeOf(page)).toBe('light');
    expect(await metaColor(page)).toBe('#f5f5f7');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => themeOf(page)).toBe('dark');
    expect(await metaColor(page)).toBe('#1c1c1e');

    // the choice survives a reload and is applied before the app runs
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem('aldine.theme'))).toBe('system');
    expect(await themeOf(page)).toBe('light');

    // an explicit choice stops following the system
    await page.getByTestId('home-more').click();
    await page.getByTestId('appearance').click();
    await page.getByTestId('appearance-dark').click();
    await expect.poll(() => themeOf(page)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await themeOf(page)).toBe('dark');
  });

  test('settings and the palette offer the same three choices', async ({ page, request }) => {
    const id = await createProject(request, 'Appearance Settings');
    try {
      await openProject(page, id);
      await page.getByTestId('palette-open').click();
      await page.keyboard.type('theme');
      await expect(page.getByTestId('palette-item-appearance-system')).toBeVisible();
      await expect(page.getByTestId('palette-item-appearance-dark')).toContainText('Current');
      await page.keyboard.press('Escape');

      await page.getByTestId('project-settings-open').click();
      const select = page.getByTestId('settings-theme');
      await expect(select.locator('option')).toHaveText(['Match system', 'Light', 'Dark']);
      await select.selectOption('system');
      await expect.poll(() => page.evaluate(() => localStorage.getItem('aldine.theme'))).toBe('system');
    } finally { await cleanup(request, id); }
  });
});

test.describe('menu', () => {
  test('keyboard: arrows, Home and End, typeahead, a submenu, Escape back to the button', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByTestId('home-more');
    await toggle.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu).toBeVisible();
    const item = (name: string) => menu.getByRole('menuitem', { name });
    await expect(item('Appearance')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('Connect Claude…')).toBeFocused();
    await page.keyboard.press('End');
    await expect(item('About & source')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('Appearance')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item('About & source')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item('Appearance')).toBeFocused();
    await page.keyboard.press('c');
    await expect(item('Connect Claude…')).toBeFocused();
    // opened from the keyboard: no entrance animation
    expect(await menu.evaluate((el) => el.getAnimations().length)).toBe(0);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    const sub = page.getByRole('menu', { name: 'Appearance' });
    await expect(sub.getByRole('menuitemradio', { name: 'Match system' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(sub).toHaveCount(0);
    await expect(item('Appearance')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(toggle).toBeFocused();
    expect(await themeOf(page)).toBe('dark');

    // ArrowUp on the button opens on the last item; Tab closes and moves on
    await page.keyboard.press('ArrowUp');
    await expect(item('About & source')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(toggle).not.toBeFocused();
  });

  test('a pointer opens it with nothing chosen yet, and a press outside closes it', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-more').click();
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu).toBeFocused();
    // Space with no row focused is swallowed: it must not scroll the page behind
    await page.evaluate(() => {
      window.addEventListener('keydown', (e) => {
        if (e.key === ' ') setTimeout(() => { (window as unknown as { spacePrevented: boolean }).spacePrevented = e.defaultPrevented; });
      }, { capture: true, once: true });
    });
    await page.keyboard.press(' ');
    await expect.poll(() => page.evaluate(() => (window as unknown as { spacePrevented?: boolean }).spacePrevented)).toBe(true);
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Appearance' })).toBeFocused();
    await page.mouse.click(5, 400);
    await expect(menu).toHaveCount(0);
  });

  test('the file context menu: right-click, Shift+F10, typeahead, Rename', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Context Menu Paper');
    try {
      await openProject(page, id);
      const row = page.getByTestId('file-references.bib');
      await row.click({ button: 'right' });
      const menu = page.getByTestId('file-menu');
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('role', 'menu');
      await expect(menu).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      await row.focus();
      await page.keyboard.press('Shift+F10');
      await expect(menu).toBeVisible();
      await expect(page.getByTestId('file-menu-root')).toBeFocused();
      await page.keyboard.press('d');
      await expect(page.getByTestId('file-menu-delete')).toBeFocused();
      await expect(page.getByTestId('file-menu-delete')).toHaveClass(/menu__item--danger/);
      await page.waitForTimeout(600); // a pause ends one typeahead search; the next letter starts another
      await page.keyboard.press('r');
      await expect(page.getByTestId('file-menu-rename')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveCount(0);
      await expect(page.getByTestId('dialog-message').or(page.getByRole('dialog'))).toBeVisible();
      await page.keyboard.press('Escape');
      // the main document is already the main document
      await row.click({ button: 'right' });
      await expect(page.getByTestId('file-menu-root')).not.toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Escape');
      await page.getByTestId('file-main.tex').click({ button: 'right' });
      await expect(page.getByTestId('file-menu-root')).toHaveAttribute('aria-disabled', 'true');
    } finally { await cleanup(request, id); }
  });
});

test.describe('command palette', () => {
  test('is a combobox; projects come first; "op" no longer matches every project', async ({ page, request }) => {
    const a = await createProject(request, 'Palette Optics Notes');
    const b = await createProject(request, 'Palette Thesis Draft');
    try {
      await page.goto('/');
      const trigger = page.getByTestId('palette-open');
      await trigger.click();
      const input = page.getByTestId('palette-input');
      await expect(input).toHaveAttribute('role', 'combobox');
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible();
      // the first section is the projects, with one heading for the section
      await expect(listbox.getByRole('group').first()).toHaveAccessibleName('Projects');
      const active = await input.getAttribute('aria-activedescendant');
      expect(active).toBeTruthy();
      await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('aria-selected', 'true');

      // a long project list leaves room for the commands below it
      await expect(page.getByTestId('palette-item-new-project')).toBeVisible();
      expect(await listbox.getByRole('group', { name: 'Projects' }).getByRole('option').count()).toBeLessThanOrEqual(8);
      await expect(input).toHaveAttribute('aria-expanded', 'true');

      await page.keyboard.type('op');
      await expect(page.getByTestId(`palette-item-open-${a}`)).toBeVisible();
      await expect(page.getByTestId(`palette-item-open-${b}`)).toHaveCount(0);

      await page.keyboard.type('zzqx');
      await expect(input).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Backspace');

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('command-palette')).toHaveCount(0);
      await expect(trigger).toBeFocused();

      // from the keyboard it appears without animation
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByTestId('command-palette')).toHaveClass(/modal-backdrop--instant/);
    } finally {
      await cleanup(request, a);
      await cleanup(request, b);
    }
  });
});

test.describe('dialogs and notifications', () => {
  test('notifications are a labelled region; moving to the trash is not a success', async ({ page, request }) => {
    const id = await createProject(request, 'Neutral Trash');
    try {
      await page.goto('/');
      await projectAction(page, id, 'menu-trash');
      const region = page.getByRole('region', { name: 'Notifications' });
      const toast = region.locator('.toast', { hasText: 'Moved Neutral Trash to the trash' });
      await expect(toast).toBeVisible();
      await expect(toast.locator('.dot')).toHaveCount(0);
      await page.getByTestId('undo-trash').click();
    } finally { await cleanup(request, id); }
  });

  test('New project: a labelled name, Enter in the template search creates, the default name is "Untitled project"', async ({ page, request }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await expect(page.getByLabel('Project name')).toBeFocused();
    await expect(page.getByTestId('template-search')).toBeVisible();
    await page.getByTestId('template-search').fill('article');
    await page.getByTestId('template-search').press('Enter');
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('project-name')).toHaveText('Untitled project');
    await cleanup(request, page.url().split('/p/')[1].split('?')[0]);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('a dialog is a sheet from the bottom edge, and the page behind it does not scroll', async ({ page }) => {
      await page.goto('/');
      await page.getByTestId('home-add').click();
      await page.getByTestId('home-add-sheet').getByTestId('new-project').click();
      const sheet = page.getByRole('dialog', { name: 'New project' });
      await expect(sheet).toBeVisible();
      await expect.poll(async () => {
        const b = (await sheet.boundingBox())!;
        return [Math.round(b.x), Math.round(b.width), Math.round(b.y + b.height)];
      }).toEqual([0, 390, 844]);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
      await expect(page.getByTestId('create-project')).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('visible');
    });

    test('a long press on a file opens its menu', async ({ page, request }) => {
      const id = await createPaperProject(request, 'Long Press Paper');
      try {
        await openProject(page, id);
        const row = page.getByTestId('file-references.bib');
        await expect(row).toBeVisible();
        const box = (await row.boundingBox())!;
        const x = box.x + 30;
        const y = box.y + box.height / 2;
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForTimeout(700);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(page.getByTestId('file-menu')).toBeVisible();
        // the press did not also open the file
        await expect(page.getByTestId('active-file')).not.toHaveText('references.bib');
        await expect(page.getByTestId('file-menu-rename')).toHaveCSS('min-height', '44px');
      } finally { await cleanup(request, id); }
    });
  });
});

test.describe('app shell', () => {
  test('the project list loads without the editor, and a failed download offers Reload', async ({ page, request }) => {
    const id = await createProject(request, 'Shell Paper');
    try {
      const blocked = /\/assets\/Editor-[^/]*\.js$/;
      await page.route(blocked, (route) => route.abort());
      await page.goto('/');
      await expect(page.getByTestId('new-project')).toBeVisible();
      await expect(page).toHaveTitle('Projects – Aldine');

      await page.goto(`/p/${id}`);
      const error = page.getByTestId('app-error');
      await expect(error).toBeVisible();
      await expect(error).toHaveAttribute('role', 'alert');
      await page.unroute(blocked);
      await page.getByTestId('app-error-reload').click();
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      await expect(page).toHaveTitle('Shell Paper – Aldine');
      await expect(page.getByRole('main', { name: 'Editor' })).toBeVisible();
      await expect(page.getByRole('banner', { name: 'Project toolbar' })).toBeVisible();
    } finally { await cleanup(request, id); }
  });
});
