import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openSidebarTab } from './helpers';

test.describe('Manual commits', () => {
  test('edits wait in History for a commit with my own message', async ({ page, request }) => {
    test.setTimeout(120_000);
    const id = await createProject(request, 'Manual Commits');
    try {
      await openProject(page, id);
      await page.getByTestId('project-settings-open').click();
      await page.getByTestId('settings-commit-mode').selectOption('manual');
      await expect(page.getByTestId('settings-commit-mode')).toHaveValue('manual');
      await page.getByTestId('settings-close').click();
      expect((await (await request.get(`/api/projects/${id}`)).json()).manualCommits).toBe(true);
      const before = (await (await request.get(`/api/projects/${id}/log?branch=main`)).json()).length;

      await page.locator('.cm-content').click();
      await page.keyboard.type(' MANUAL-COMMIT-LINE ');
      await openSidebarTab(page, 'history');
      await expect(page.getByTestId('uncommitted-changes')).toContainText('1 file not committed yet', { timeout: 15_000 });
      await expect(page.getByTestId('commit-message')).toHaveAttribute('placeholder', 'Commit message');

      // past the 20 s autosave debounce: nothing was committed behind my back
      await page.waitForTimeout(23_000);
      const log = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      expect(log.length).toBe(before);

      // a commit needs a message
      await page.getByTestId('commit-button').click();
      await expect(page.getByText('Write a commit message first')).toBeVisible();

      await page.getByTestId('commit-message').fill('Add the manual line');
      await page.getByTestId('commit-button').click();
      await expect(page.getByTestId('history-panel')).toContainText('Add the manual line', { timeout: 10_000 });
      await expect(page.getByTestId('uncommitted-changes')).toContainText('No uncommitted changes');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the palette switches the mode', async ({ page, request }) => {
    const id = await createProject(request, 'Manual Commits Palette');
    try {
      await openProject(page, id);
      await page.getByTestId('palette-open').click();
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.type('Commit changes');
      await page.getByTestId('palette-item-manual-commits').click();
      await expect(page.getByText('Edits now wait for your commit in History')).toBeVisible();
      expect((await (await request.get(`/api/projects/${id}`)).json()).manualCommits).toBe(true);
    } finally {
      await cleanup(request, id);
    }
  });
});
