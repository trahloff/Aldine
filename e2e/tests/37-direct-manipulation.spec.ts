import { test, expect } from '../fixtures';
import { createPaperProject, openProject, cleanup } from './helpers';

/**
 * The parts of the interface that answer the pointer directly: the pane
 * divider, the menus that open at it, and the notifications that leave it.
 */
test.describe('direct manipulation', () => {
  test('the pane divider follows a drag, the arrow keys and a double-click', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Divider Paper');
    try {
      await openProject(page, id);
      const divider = page.getByTestId('pane-resizer');
      const preview = page.locator('.pane--preview');
      const width = async () => Math.round((await preview.boundingBox())!.width);
      const start = await width();

      // Drag 120px to the left, leaving the divider's own strip on the way:
      // the pane tracks the pointer 1:1 and the drag state holds throughout.
      const box = (await divider.boundingBox())!;
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 60, y + 40, { steps: 4 });
      await expect(divider).toHaveClass(/resizer--drag/);
      await page.mouse.move(box.x + box.width / 2 - 120, y + 80, { steps: 4 });
      await page.mouse.up();
      await expect(divider).not.toHaveClass(/resizer--drag/);
      expect(await width()).toBe(start + 120);

      // Keyboard: the divider is a focusable separator.
      await divider.focus();
      await expect(divider).toHaveAttribute('role', 'separator');
      await page.keyboard.press('ArrowRight');
      expect(await width()).toBe(start + 104);
      await page.keyboard.press('Shift+ArrowLeft');
      expect(await width()).toBe(start + 184);

      // Double-click: back to the default share of the window.
      await divider.dblclick();
      expect(await width()).toBe(start);
    } finally { await cleanup(request, id); }
  });

  test('the file menu stays inside the window and closes on Escape', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Menu Paper');
    try {
      await page.setViewportSize({ width: 1440, height: 220 });
      await openProject(page, id);
      const row = page.getByTestId('file-main.tex');
      const box = (await row.boundingBox())!;
      // Open it as low as the row allows; the menu is taller than what is left below.
      await page.mouse.click(box.x + 20, box.y + box.height - 2, { button: 'right' });
      const menu = page.getByTestId('file-menu');
      await expect(menu).toBeVisible();
      const m = (await menu.boundingBox())!;
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y + m.height).toBeLessThanOrEqual(220);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      await page.getByTestId('branch-menu').click();
      await expect(page.getByTestId('branch-list')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('branch-list')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('a notification waits under the pointer and then leaves', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Toast Paper');
    try {
      await openProject(page, id);
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('new-branch').click();
      await page.getByTestId('new-branch-name').fill('toast-check');
      await page.keyboard.press('Enter');
      const toast = page.locator('.toast', { hasText: 'Created branch toast-check' });
      await expect(toast).toBeVisible();
      // A confirmation stays 3.4 s on its own; with the pointer on it, it is
      // still there after 4.5 s.
      await toast.hover();
      await page.waitForTimeout(4500);
      await expect(toast).toBeVisible();
      await page.mouse.move(5, 5);
      // the clock starts over once the pointer is gone
      await page.waitForTimeout(2000);
      await expect(toast).toBeVisible();
      await expect(toast).toHaveCount(0, { timeout: 4000 });
    } finally { await cleanup(request, id); }
  });
});
