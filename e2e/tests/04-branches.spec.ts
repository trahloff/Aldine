import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openSidebarTab } from './helpers';

test.describe('git branches', () => {
  test('create branch, edit independently, switch back, merge into main', async ({ page, request }) => {
    const id = await createProject(request, 'Branch Test');
    try {
      await openProject(page, id);

      // create branch "revision" from main
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('new-branch').click();
      await page.getByTestId('new-branch-name').fill('revision');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('branch-menu')).toContainText('revision', { timeout: 15_000 });

      // edit on the branch
      await page.locator('.cm-content').click();
      await page.keyboard.type('BRANCH-ONLY-TEXT ');
      await page.waitForTimeout(2500); // let hocuspocus store

      // switch back to main: text absent
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-main').click();
      await expect(page.getByTestId('branch-menu')).toContainText('main');
      await expect(page.locator('.cm-content')).not.toContainText('BRANCH-ONLY-TEXT', { timeout: 15_000 });

      // switch to branch again: text present (persisted per-branch)
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-revision').click();
      await expect(page.locator('.cm-content')).toContainText('BRANCH-ONLY-TEXT', { timeout: 15_000 });

      // merge revision into main
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('merge-revision').click();
      await expect(page.getByTestId('branch-menu')).toContainText('main', { timeout: 15_000 });
      await expect(page.locator('.cm-content')).toContainText('BRANCH-ONLY-TEXT', { timeout: 15_000 });
    } finally {
      await cleanup(request, id);
    }
  });

  test('history shows checkpoints', async ({ page, request }) => {
    const id = await createProject(request, 'History Test');
    try {
      await openProject(page, id);
      await page.locator('.cm-content').click();
      await page.keyboard.type('CHECKPOINT-CONTENT ');
      await page.waitForTimeout(2500);
      await openSidebarTab(page, 'history');
      await page.getByTestId('commit-message').fill('My checkpoint');
      await page.getByTestId('commit-button').click();
      await expect(page.getByTestId('history-panel')).toContainText('My checkpoint', { timeout: 10_000 });
      await expect(page.getByTestId('history-panel')).toContainText('Initial commit');
    } finally {
      await cleanup(request, id);
    }
  });
});
