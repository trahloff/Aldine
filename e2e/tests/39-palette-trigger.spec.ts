import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/** The command palette has a visible door, in the editor and on the project list. */
test.describe('palette trigger', () => {
  test('the editor toolbar field opens the palette and runs a file switch', async ({ page, request }) => {
    const id = await createProject(request, 'Palette Door');
    try {
      await openProject(page, id);
      const trigger = page.getByTestId('palette-open');
      await expect(trigger).toBeVisible();
      await expect(trigger).toContainText('Search files and commands');
      await trigger.click();
      await expect(page.getByTestId('command-palette')).toBeVisible();
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.type('references.bib');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('command-palette')).toHaveCount(0);
      await expect(page.locator('.cm-content')).toContainText('@');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the project list has a palette too, by field and by shortcut', async ({ page, request }) => {
    const id = await createProject(request, 'Palette Destination');
    try {
      await page.goto('/');
      await page.getByTestId('palette-open').click();
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('command-palette')).toHaveCount(0);

      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.type('Palette Destination');
      await expect(page.getByTestId(`palette-item-open-${id}`)).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/p/${id}`));
      await expect(page.getByTestId('editor-shell')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('on a phone the field shrinks to its icon', async ({ page, request }) => {
    const id = await createProject(request, 'Palette Phone');
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await openProject(page, id);
      const trigger = page.getByTestId('palette-open');
      await expect(trigger).toBeVisible();
      await expect(trigger.locator('.palette-trigger__label')).toBeHidden();
      expect((await trigger.boundingBox())!.width).toBeLessThan(44);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await cleanup(request, id);
    }
  });
});
