import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openSidebarTab } from './helpers';

test.describe('git diff view', () => {
  test('click a commit to see its diff', async ({ page, request }) => {
    const id = await createProject(request, 'Diff Test');
    try {
      await openProject(page, id);
      // make a change and commit it via the History panel
      await page.locator('.cm-content').click();
      await page.keyboard.type(' UNIQUE-DIFF-LINE ');
      await page.waitForTimeout(2500); // let it flush to disk
      await openSidebarTab(page, 'history');
      await page.getByTestId('commit-message').fill('Add unique line');
      await page.getByTestId('commit-button').click();
      await expect(page.getByTestId('history-panel')).toContainText('Add unique line', { timeout: 10_000 });

      // click that commit → diff modal shows the added line
      await page.getByText('Add unique line').click();
      await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('diff-view')).toContainText('UNIQUE-DIFF-LINE');
      // the added line renders as an addition
      await expect(page.locator('.diff__add')).toContainText('UNIQUE-DIFF-LINE');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the initial commit diff shows the seeded files', async ({ page, request }) => {
    const id = await createProject(request, 'Diff Initial');
    try {
      await openProject(page, id);
      await openSidebarTab(page, 'history');
      await page.getByText('Initial commit').click();
      await expect(page.getByTestId('diff-view')).toContainText('main.tex', { timeout: 10_000 });
      await expect(page.getByTestId('diff-view')).toContainText('documentclass');
    } finally {
      await cleanup(request, id);
    }
  });
});
