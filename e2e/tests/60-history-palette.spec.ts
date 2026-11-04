import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, typeAtEnd, cleanup, openSidebarTab } from './helpers';

/**
 * History, branch merges, project-wide Replace and the command palette: a
 * merge into main asks first, History follows commits made elsewhere and
 * tells a failed load from an empty one, Replace all can be undone, and the
 * palette knows the words people look for and puts the cursor where the
 * command promises.
 */

const put = (request: APIRequestContext, id: string, branch: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch, path, content } });

const fileText = async (request: APIRequestContext, id: string, path: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();

const log = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/projects/${id}/log?branch=main`)).json()) as Array<{ hash: string; message: string }>;

const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text });

async function palette(page: Page, query: string) {
  await page.getByTestId('palette-open').click();
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.getByTestId('palette-input').fill(query);
}

test.describe('history and branches', () => {
  test('merging into main asks with the count, says when there is nothing to merge, and its row shows the changes', async ({ page, request }) => {
    const id = await createProject(request, 'Merge Confirm');
    try {
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft', from: 'main' } })).ok()).toBeTruthy();
      expect((await put(request, id, 'draft', 'chapter.tex', 'DRAFT-CHAPTER-LINE\n')).ok()).toBeTruthy();
      expect((await (await request.post(`/api/projects/${id}/commit`, { data: { branch: 'draft', message: 'Draft chapter' } })).json()).committed).toBe(true);
      await openProject(page, id);

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('merge-draft').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Merge draft into main?');
      await expect(page.getByTestId('dialog-message')).toContainText('1 checkpoint from draft goes into main');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-dialog')).toHaveCount(0);
      expect((await log(request, id)).some((c) => c.message === 'Merge draft into main')).toBe(false);

      if (!(await page.getByTestId('branch-list').isVisible())) await page.getByTestId('branch-menu').click();
      await page.getByTestId('merge-draft').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(toast(page, 'Merged draft into main')).toBeVisible();

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('merge-draft').click();
      await expect(toast(page, 'Nothing to merge: main already has everything on draft')).toBeVisible();
      await expect(page.getByTestId('app-dialog')).toHaveCount(0);

      // the merge row shows what it brought in, not an empty combined diff
      await openSidebarTab(page, 'history');
      await page.getByTestId('history-panel').getByText('Merge draft into main').click();
      await expect(page.getByTestId('diff-view')).toContainText('DRAFT-CHAPTER-LINE');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('diff-dialog')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('an open History panel lists a checkpoint saved elsewhere, and a failed load offers Try again', async ({ page, request }) => {
    const id = await createProject(request, 'History Live');
    try {
      await openProject(page, id);
      await typeAtEnd(page, ' CO-AUTHOR-EDIT');
      await openSidebarTab(page, 'history');
      await expect(page.getByTestId('history-panel')).toContainText('Initial commit');

      // a co-author's checkpoint: no file-list change, no tab switch here
      await expect.poll(async () => (await (await request.post(`/api/projects/${id}/commit`, { data: { branch: 'main', message: 'Checkpoint from a co-author' } })).json()).committed, { timeout: 10_000 }).toBe(true);
      await expect(page.getByTestId('history-panel')).toContainText('Checkpoint from a co-author', { timeout: 10_000 });

      await page.route(`**/api/projects/${id}/log**`, (r) => r.abort());
      await page.getByTestId('tab-files').click();
      await openSidebarTab(page, 'history');
      await expect(page.getByTestId('history-error')).toContainText('Couldn’t load the history.');
      await expect(page.getByTestId('history-panel')).not.toContainText('No history yet');
      await page.unroute(`**/api/projects/${id}/log**`);
      await page.getByTestId('history-error-retry').click();
      await expect(page.getByTestId('history-panel')).toContainText('Checkpoint from a co-author');
      await expect(page.getByTestId('history-error')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Replace all across the project can be undone from its toast, and the search shows the matches again', async ({ page, request }) => {
    const id = await createProject(request, 'Replace Undo');
    try {
      expect((await put(request, id, 'main', 'chapters/a.tex', 'colour and colour\n')).ok()).toBeTruthy();
      await openProject(page, id);
      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').fill('colour');
      await expect(page.locator('[data-testid="search-file"][data-path="chapters/a.tex"]').getByTestId('search-file-count')).toHaveText('2');
      await page.getByTestId('search-replace-input').fill('color');
      await page.getByTestId('search-replace-all').click();
      await page.getByTestId('dialog-confirm').click();
      await expect.poll(() => fileText(request, id, 'chapters/a.tex')).toBe('color and color\n');
      await expect(page.getByTestId('search-empty')).toHaveText('No results for “colour”');

      await page.getByTestId('replace-undo').click();
      await expect(toast(page, 'Undid the replace of 2 matches')).toBeVisible();
      await expect.poll(() => fileText(request, id, 'chapters/a.tex')).toBe('colour and colour\n');
      expect((await log(request, id)).some((c) => c.message === 'Undo the project-wide replace')).toBe(true);
      // the search runs again: the matches the Undo put back are listed, without Search again
      await expect(page.locator('[data-testid="search-file"][data-path="chapters/a.tex"]').getByTestId('search-file-count')).toHaveText('2');
      await expect(page.getByTestId('search-empty')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('command palette', () => {
  test('knows compile and history, leaves out dotfiles, and puts the cursor where a command promises', async ({ page, request }) => {
    const id = await createProject(request, 'Palette Words');
    try {
      await openProject(page, id);

      await palette(page, 'compile');
      await expect(page.getByTestId('palette-item-typeset')).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('palette-input').fill('recompile');
      await expect(page.getByTestId('palette-item-typeset')).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('palette-input').fill('history');
      await expect(page.getByTestId('palette-item-show-history')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('palette-item-commit')).toBeVisible();
      await page.getByTestId('palette-input').fill('gitignore');
      await expect(page.getByTestId('palette-item-open-.gitignore')).toHaveCount(0);
      await page.getByTestId('palette-input').fill('main.tex');
      await expect(page.getByTestId('palette-item-open-main.tex')).toBeVisible();

      // "Save a checkpoint…" puts the cursor in the message field, not the paper
      await page.getByTestId('palette-input').fill('save a checkpoint');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('commit-message')).toBeFocused();
      await page.keyboard.type('Typed into the field');
      await expect(page.getByTestId('commit-message')).toHaveValue('Typed into the field');
      await expect(page.locator('.cm-content')).not.toContainText('Typed into the field');
      // a later visit to the tab leaves the focus alone
      await page.getByTestId('tab-files').click();
      await openSidebarTab(page, 'history');
      await expect(page.getByTestId('commit-message')).not.toBeFocused();

      await palette(page, 'new branch');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('new-branch-name')).toBeFocused();
      await page.keyboard.press('Escape');

      await palette(page, 'show review comments');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('review-panel')).toBeVisible();

      await palette(page, 'new folder');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('new-folder-name')).toBeFocused();
      await page.keyboard.press('Escape');

      await palette(page, 'new file');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('new-file-name')).toBeFocused();
      await page.keyboard.press('Escape');

      await palette(page, 'upload files');
      const chooser = page.waitForEvent('filechooser');
      await page.keyboard.press('Enter');
      expect((await chooser).isMultiple()).toBe(true);
    } finally {
      await cleanup(request, id);
    }
  });
});
