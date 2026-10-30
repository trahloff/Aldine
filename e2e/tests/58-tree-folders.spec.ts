import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

/** Folders in the file tree (#220): git keeps no empty directory, so a new
 *  folder is a .gitkeep inside it, hidden in the Source view. */

const listing = async (request: APIRequestContext, id: string): Promise<string[]> => {
  const { files } = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { files: { path: string; type: string }[] };
  return files.filter((f) => f.type === 'file').map((f) => f.path);
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function newFolder(page: Page, name: string) {
  await page.getByTestId('new-folder').click();
  const input = page.getByTestId('new-folder-name');
  await input.fill(name);
  await input.press('Enter');
}

async function folderMenu(page: Page, dir: string, item: string) {
  await page.getByTestId(`dir-${dir}`).click({ button: 'right' });
  await expect(page.getByTestId('folder-menu')).toBeVisible();
  await page.getByTestId(`folder-menu-${item}`).click();
}

test.describe('folders in the file tree', () => {
  test('a new folder shows in the Source view, for a collaborator too, and survives a reload', async ({ page, browser, request }) => {
    const id = await createProject(request, 'Tree Folders');
    const other = await browser.newContext();
    try {
      await openProject(page, id);
      const b = await other.newPage();
      await openProject(b, id);

      await expect(page.getByTestId('new-folder')).toHaveAttribute('aria-label', 'New folder');
      await newFolder(page, 'figures');
      await expect(page.getByTestId('dir-figures')).toBeVisible();
      await expect(page.getByTestId('dir-empty-figures')).toHaveText('Empty folder');
      // the placeholder is in git, not in the Source view
      await expect(page.getByTestId('file-figures/.gitkeep')).toHaveCount(0);
      await expect.poll(() => listing(request, id)).toContain('figures/.gitkeep');
      await expect(b.getByTestId('dir-figures'), 'the other tab lists the new folder').toBeVisible({ timeout: 10_000 });

      // All shows the .gitkeep that holds the folder
      await page.getByTestId('source-only').click();
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('file-figures/.gitkeep')).toBeVisible();
      await page.getByTestId('source-only').click();
      await expect(page.getByTestId('file-figures/.gitkeep')).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      await expect(page.getByTestId('dir-figures')).toBeVisible();
      await expect(page.getByTestId('dir-empty-figures')).toBeVisible();
    } finally {
      await other.close();
      await cleanup(request, id);
    }
  });

  test('a name the server would refuse, or one already taken, keeps the input open with the reason', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Folder Names');
    try {
      await openProject(page, id);
      await newFolder(page, '../outside');
      const input = page.getByTestId('new-folder-name');
      await expect(page.getByTestId('new-name-error')).toHaveText('Names cannot contain ".."');
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await input.fill('-x');
      await input.press('Enter');
      await expect(page.getByTestId('new-name-error')).toHaveText('Names cannot start with "-"');
      await input.press('Escape');
      await expect(input).toHaveCount(0);

      await newFolder(page, 'figures');
      await expect(page.getByTestId('dir-figures')).toBeVisible();
      await newFolder(page, 'figures/');
      await expect(page.getByTestId('new-name-error')).toHaveText('"figures" already exists');
      await page.getByTestId('new-folder-name').press('Escape');
      expect((await listing(request, id)).filter((p) => p.startsWith('figures/'))).toEqual(['figures/.gitkeep']);

      // deleting a folder's last file leaves a directory git does not hold: not taken
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'old/a.tex', content: 'x\n' } });
      await expect(page.getByTestId('file-old/a.tex')).toBeVisible({ timeout: 10_000 });
      await request.delete(`/api/projects/${id}/file?branch=main&path=old/a.tex`);
      await expect(page.getByTestId('file-old/a.tex')).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByTestId('dir-old')).toHaveCount(0);
      await newFolder(page, 'old');
      await expect(page.getByTestId('dir-old')).toBeVisible();
      await expect.poll(() => listing(request, id)).toContain('old/.gitkeep');
    } finally { await cleanup(request, id); }
  });

  test('the folder menu makes a file and a folder in it and uploads into it; Delete only while it is empty', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Folder Menu');
    try {
      await openProject(page, id);
      await newFolder(page, 'chapters');
      await expect(page.getByTestId('dir-chapters')).toBeVisible();

      await folderMenu(page, 'chapters', 'new-file');
      const fileName = page.getByTestId('new-file-name');
      await expect(fileName).toHaveValue('chapters/');
      await fileName.press('End');
      await page.keyboard.type('intro.tex');
      await fileName.press('Enter');
      await expect(page.getByTestId('file-chapters/intro.tex')).toBeVisible();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/intro.tex');
      await expect(page.getByTestId('dir-empty-chapters')).toHaveCount(0);

      // no longer empty: no Delete in its menu
      await page.getByTestId('dir-chapters').click({ button: 'right' });
      await expect(page.getByTestId('folder-menu-new-file')).toBeVisible();
      await expect(page.getByTestId('folder-menu-delete')).toHaveCount(0);
      await page.keyboard.press('Escape');

      await folderMenu(page, 'chapters', 'new-folder');
      const folderName = page.getByTestId('new-folder-name');
      await expect(folderName).toHaveValue('chapters/');
      await folderName.press('End');
      await page.keyboard.type('figures');
      await folderName.press('Enter');
      await expect(page.getByTestId('dir-chapters/figures')).toBeVisible();
      await expect.poll(() => listing(request, id)).toContain('chapters/figures/.gitkeep');

      const chooser = page.waitForEvent('filechooser');
      await folderMenu(page, 'chapters/figures', 'upload');
      await (await chooser).setFiles({ name: 'plot.png', mimeType: 'image/png', buffer: PNG });
      await expect(page.getByTestId('file-chapters/figures/plot.png')).toBeVisible();
      await expect.poll(() => listing(request, id)).toContain('chapters/figures/plot.png');
      expect(await listing(request, id), 'the upload went into the folder, not the top level').not.toContain('plot.png');

      // an empty folder, nested ones included, can be deleted
      await newFolder(page, 'tables');
      await folderMenu(page, 'tables', 'new-folder');
      await page.getByTestId('new-folder-name').press('End');
      await page.keyboard.type('drafts');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('dir-tables/drafts')).toBeVisible();
      await folderMenu(page, 'tables', 'delete');
      await expect(page.getByTestId('dialog-title')).toHaveText('Delete tables?');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('dir-tables')).toHaveCount(0);
      await expect.poll(async () => (await listing(request, id)).filter((p) => p.startsWith('tables/'))).toEqual([]);
      await page.reload();
      await expect(page.getByTestId('dir-chapters')).toBeVisible();
      await expect(page.getByTestId('dir-tables')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('a file added to the folder while its Delete was being confirmed keeps the folder', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Folder Race');
    try {
      await openProject(page, id);
      await newFolder(page, 'figures');
      await folderMenu(page, 'figures', 'delete');
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'figures/plot.tex', content: 'x\n' } });
      await page.getByTestId('dialog-confirm').click();
      await expect(page.locator('.toast').filter({ hasText: 'figures is no longer empty' })).toBeVisible();
      await expect(page.getByTestId('file-figures/plot.tex')).toBeVisible({ timeout: 10_000 });
      expect(await listing(request, id)).toContain('figures/plot.tex');
    } finally { await cleanup(request, id); }
  });
});
