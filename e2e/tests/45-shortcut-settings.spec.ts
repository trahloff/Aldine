import { test, expect, Page } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const MOD_E = /⌘E|Ctrl\+E/;
const DEFAULT_COMMENT = /⇧⌘M|Ctrl\+Shift\+M/;

async function selectPlaceholder(page: Page) {
  const line = await page.locator('.cm-line').first().boundingBox();
  await page.mouse.dblclick(line!.x + 30, line!.y + line!.height / 2);
  await expect.poll(async () => await page.evaluate(() => window.getSelection()?.toString())).toBe('PLACEHOLDER');
}

/**
 * Keys differ per keyboard and per browser, so each browser can pick its own
 * chords in Project settings; the editor, its labels and the palette follow.
 */
test.describe('keyboard shortcut settings', () => {
  test('a new chord works at once, survives a reload, and resets', async ({ page, request }) => {
    const id = await createProject(request, 'Shortcut Settings');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'PLACEHOLDER needs a word.\n' } });
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('PLACEHOLDER', { timeout: 10_000 });

      await page.getByTestId('project-settings-open').click();
      const recorder = page.getByTestId('shortcut-comment');
      await expect(recorder).toContainText(DEFAULT_COMMENT);
      await recorder.click();
      // the editor's Bold is refused, and the dialog keeps recording
      await page.keyboard.press(`${mod}+b`);
      await expect(page.getByTestId('shortcut-hint-comment')).toContainText('Bold');
      await page.keyboard.press(`${mod}+e`);
      await expect(recorder).toContainText(MOD_E);
      await expect(page.getByTestId('shortcut-reset-comment')).toBeVisible();
      await page.getByTestId('settings-close').click();

      await expect(page.getByTestId('add-comment')).toContainText(MOD_E);
      await selectPlaceholder(page);
      await page.keyboard.press(`${mod}+Shift+m`);
      await expect(page.getByTestId('comment-composer')).toHaveCount(0);
      await page.keyboard.press(`${mod}+e`);
      await expect(page.getByTestId('comment-composer')).toBeVisible();
      await page.keyboard.press('Escape');

      await page.reload();
      await expect(page.getByTestId('add-comment')).toContainText(MOD_E, { timeout: 15_000 });

      await page.getByTestId('project-settings-open').click();
      await page.getByTestId('shortcut-reset-comment').click();
      await expect(page.getByTestId('shortcut-comment')).toContainText(DEFAULT_COMMENT);
      await expect(page.getByTestId('shortcut-reset-comment')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('Escape while recording keeps the old chord and the dialog', async ({ page, request }) => {
    const id = await createProject(request, 'Shortcut Escape');
    try {
      await openProject(page, id);
      await page.getByTestId('project-settings-open').click();
      await page.getByTestId('shortcut-typeset').click();
      await expect(page.getByTestId('shortcut-typeset')).toHaveText('Press keys…');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('project-settings')).toBeVisible();
      await expect(page.getByTestId('shortcut-typeset')).toContainText(/⌘S|Ctrl\+S/);
      // the next Escape is the dialog's again
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('project-settings')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('the palette opens the shortcuts', async ({ page, request }) => {
    const id = await createProject(request, 'Shortcut Palette');
    try {
      await openProject(page, id);
      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('keyboard shortcuts');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('settings-shortcuts')).toBeInViewport();
    } finally { await cleanup(request, id); }
  });
});
