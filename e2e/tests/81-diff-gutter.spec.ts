import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { createProject, openProject, cleanup, openSidebarTab } from './helpers';

const marks = (page: Page, kind?: 'add' | 'mod' | 'del') =>
  page.getByTestId('diff-gutter-mark').and(page.locator(kind ? `[data-kind="${kind}"]` : '[data-kind]'));
const line = (page: Page, text: string) => page.locator('.cm-line', { hasText: text });

/** #289: the lines changed since the branch's last checkpoint, marked in the gutter. */
test.describe('change marks', () => {
  test('mark added and changed lines, show and revert the earlier text, clear on a checkpoint for everyone', async ({ page, browser, request }) => {
    const id = await createProject(request, 'Change Marks');
    const peerContext = await browser.newContext();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'First line.\nSecond line.\nThird line.\n' } });
      const saved = await request.post(`/api/projects/${id}/commit`, { data: { branch: 'main', message: 'Start' } });
      expect((await saved.json()).committed).toBe(true);

      await openProject(page, id);
      await expect(line(page, 'Third line.')).toBeVisible();
      await expect(marks(page)).toHaveCount(0);

      // a new line after the last one, and a change to the first
      await line(page, 'Third line.').click();
      await page.keyboard.press('End');
      await page.keyboard.type('\nA new line.');
      await line(page, 'First line.').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Edited.');
      await expect(marks(page, 'add')).toHaveCount(1);
      await expect(marks(page, 'mod')).toHaveCount(1);

      // a collaborator sees the same marks
      const peer = await peerContext.newPage();
      await openProject(peer, id);
      await expect(line(peer, 'A new line.')).toBeVisible();
      await expect(marks(peer, 'add')).toHaveCount(1);
      await expect(marks(peer, 'mod')).toHaveCount(1);

      // clicking a mark shows the line as it was, and can put it back
      await marks(page, 'mod').click();
      await expect(page.getByTestId('diff-peek-old')).toHaveText('First line.');
      await page.getByTestId('diff-peek-close').click();
      await expect(page.getByTestId('diff-peek')).toHaveCount(0);
      await marks(page, 'mod').click();
      await page.getByTestId('diff-peek-revert').click();
      await expect(line(page, 'First line.')).not.toContainText('Edited.');
      await expect(marks(page, 'mod')).toHaveCount(0);
      await expect(marks(page, 'add')).toHaveCount(1);

      // a checkpoint is the new baseline, on every open editor
      await openSidebarTab(page, 'history');
      await page.getByTestId('commit-message').fill('Add a line');
      await page.getByTestId('commit-button').click();
      await expect(page.getByTestId('history-panel')).toContainText('Add a line', { timeout: 10_000 });
      await expect(marks(page)).toHaveCount(0);
      await expect(marks(peer)).toHaveCount(0);

      // and the marks can be turned off from the command palette
      await line(page, 'Second line.').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Again.');
      await expect(marks(page, 'mod')).toHaveCount(1);
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('palette-input').fill('hide the lines changed');
      await page.keyboard.press('Enter');
      await expect(marks(page)).toHaveCount(0);
      await expect(page.locator('.cm-diff-gutter')).toHaveCount(0);
    } finally {
      await peerContext.close();
      await cleanup(request, id);
    }
  });
});
