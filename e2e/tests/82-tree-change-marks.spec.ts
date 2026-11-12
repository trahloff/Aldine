import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { createProject, openProject, cleanup, openSidebarTab } from './helpers';

const line = (page: Page, text: string) => page.locator('.cm-line', { hasText: text });
const fileMark = (page: Page, path: string, kind: 'added' | 'modified') =>
  page.getByTestId(`file-${path}`).getByTestId(`tree-change-${kind}`);
const anyMark = (page: Page) => page.getByTestId(/^tree-change-/);

/** #289: the files changed since the branch's last checkpoint, marked in the file tree. */
test.describe('file tree change marks', () => {
  test('mark changed and added files and closed folders, clear on a checkpoint, hide from the palette', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Change Marks');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'First line.\nSecond line.\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'chapters/intro.tex', content: 'Intro.\n' } });
      const saved = await request.post(`/api/projects/${id}/commit`, { data: { branch: 'main', message: 'Start' } });
      expect((await saved.json()).committed).toBe(true);

      await openProject(page, id);
      await expect(line(page, 'Second line.')).toBeVisible();
      await expect(page.getByTestId('file-main.tex')).toBeVisible();
      await expect(anyMark(page)).toHaveCount(0);

      // typing marks the open file before any autosave
      await line(page, 'First line.').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Edited.');
      const changed = fileMark(page, 'main.tex', 'modified');
      await expect(changed).toHaveText('M');
      await expect(changed).toHaveAttribute('aria-label', 'Changed since the last checkpoint');

      // a new file is added, and its closed folder carries a dot
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'chapters/extra.tex', content: 'Extra.\n' } });
      const dir = page.getByTestId('dir-chapters');
      await expect(dir).toBeVisible();
      if ((await dir.getAttribute('aria-expanded')) === 'true') await dir.click();
      await expect(dir).toHaveAttribute('aria-expanded', 'false');
      await expect(dir.getByTestId('tree-change-folder')).toHaveAttribute('aria-label', 'Holds files changed since the last checkpoint');
      await dir.click();
      await expect(dir.getByTestId('tree-change-folder')).toHaveCount(0);
      await expect(fileMark(page, 'chapters/extra.tex', 'added')).toHaveText('A');
      await expect(page.getByTestId('file-chapters/intro.tex').getByTestId(/^tree-change-/)).toHaveCount(0);

      // a checkpoint is the new baseline
      await openSidebarTab(page, 'history');
      await page.getByTestId('commit-message').fill('Edit and extend');
      await page.getByTestId('commit-button').click();
      await expect(page.getByTestId('history-panel')).toContainText('Edit and extend', { timeout: 10_000 });
      await openSidebarTab(page, 'files');
      await expect(page.getByTestId('file-main.tex')).toBeVisible();
      await expect(anyMark(page)).toHaveCount(0);

      // the palette toggle that hides the gutter's marks hides these too
      await line(page, 'Second line.').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Again.');
      await expect(fileMark(page, 'main.tex', 'modified')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('palette-input').fill('hide the lines and files changed');
      await page.keyboard.press('Enter');
      await expect(anyMark(page)).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('palette-input').fill('show the lines and files changed');
      await page.keyboard.press('Enter');
      await expect(fileMark(page, 'main.tex', 'modified')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });
});
