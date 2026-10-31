import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

/** Folders that hold files (#220): rename one (an open file and the typeset
 *  root inside it follow), delete one after a dialog that names its files,
 *  and drag files and folders onto a folder or back to the top level. */

const listing = async (request: APIRequestContext, id: string): Promise<string[]> => {
  const { files } = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { files: { path: string; type: string }[] };
  return files.filter((f) => f.type === 'file').map((f) => f.path).sort();
};
const put = (request: APIRequestContext, id: string, path: string, content = 'x\n') =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
const rootOf = async (request: APIRequestContext, id: string) => ((await (await request.get(`/api/projects/${id}`)).json()) as { rootFile: string }).rootFile;

async function folderMenu(page: Page, dir: string, item: string) {
  await page.getByTestId(`dir-${dir}`).click({ button: 'right' });
  await expect(page.getByTestId('folder-menu')).toBeVisible();
  await page.getByTestId(`folder-menu-${item}`).click();
}

test.describe('moving folders and files in the file tree', () => {
  test('renaming a folder moves its files, the open one and the root with it', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Rename Folder');
    try {
      await put(request, id, 'chapters/intro.tex', 'Intro text\n');
      await put(request, id, 'chapters/thesis.tex', '\\documentclass{article}\n\\begin{document}\nT\n\\end{document}\n');
      await request.patch(`/api/projects/${id}`, { data: { rootFile: 'chapters/thesis.tex' } });
      await openProject(page, id);
      await page.getByTestId('file-chapters/intro.tex').click();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/intro.tex');

      await folderMenu(page, 'chapters', 'rename');
      await expect(page.getByTestId('dialog-title')).toHaveText('Rename chapters');
      await page.getByTestId('dialog-input').fill('parts');
      await page.getByTestId('dialog-confirm').click();

      await expect(page.getByTestId('dir-parts')).toBeVisible();
      await expect(page.getByTestId('dir-chapters')).toHaveCount(0);
      await expect(page.getByTestId('active-file'), 'the open file stays open under its new path').toHaveText('parts/intro.tex');
      await expect(page.locator('.cm-content')).toContainText('Intro text');
      await expect(page.getByTestId('file-parts/thesis.tex').locator('.tree__root-tag')).toHaveText('root');
      await expect.poll(() => rootOf(request, id)).toBe('parts/thesis.tex');
      expect((await listing(request, id)).filter((p) => p.startsWith('parts/'))).toEqual(['parts/intro.tex', 'parts/thesis.tex']);

      // moving it into a folder inside itself is refused before the request
      await folderMenu(page, 'parts', 'rename');
      await page.getByTestId('dialog-input').fill('parts/old/parts');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.locator('.toast').filter({ hasText: 'parts cannot move into a folder inside itself' })).toBeVisible();
      await expect(page.getByTestId('dir-parts')).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('deleting a folder that holds files names them first, and the root is picked again', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Delete Folder');
    try {
      await put(request, id, 'draft/notes.tex');
      await put(request, id, 'draft/figures/plot.tex');
      await put(request, id, 'draft/figures/.gitkeep', '');
      await put(request, id, 'draft/paper.tex', '\\documentclass{article}\n\\begin{document}\nP\n\\end{document}\n');
      await request.patch(`/api/projects/${id}`, { data: { rootFile: 'draft/paper.tex' } });
      await openProject(page, id);
      await page.getByTestId('file-draft/notes.tex').click();

      await folderMenu(page, 'draft', 'delete');
      await expect(page.getByTestId('dialog-title')).toHaveText('Delete draft?');
      await expect(page.getByTestId('dialog-message')).toHaveText('The 3 files in it are deleted too: figures/plot.tex, notes.tex and paper.tex.');
      await expect(page.getByTestId('dialog-confirm')).toHaveText('Delete folder and 3 files');
      await page.getByTestId('dialog-cancel').click();
      await expect(page.getByTestId('dir-draft')).toBeVisible();

      await folderMenu(page, 'draft', 'delete');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('dir-draft')).toHaveCount(0);
      await expect.poll(async () => (await listing(request, id)).filter((p) => p.startsWith('draft/'))).toEqual([]);
      await expect.poll(() => rootOf(request, id)).toBe('main.tex');
      await expect(page.getByTestId('file-main.tex').locator('.tree__root-tag')).toHaveText('root');
      await expect(page.getByTestId('active-file'), 'the deleted open file is closed').toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('a file added while the Delete was being confirmed keeps the folder', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Delete Race');
    try {
      await put(request, id, 'draft/notes.tex');
      await openProject(page, id);
      await folderMenu(page, 'draft', 'delete');
      await expect(page.getByTestId('dialog-confirm')).toHaveText('Delete folder and file');
      await put(request, id, 'draft/late.tex');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.locator('.toast').filter({ hasText: 'Files were added to draft since, so it was not deleted' })).toBeVisible();
      expect(await listing(request, id)).toEqual(expect.arrayContaining(['draft/late.tex', 'draft/notes.tex']));
    } finally { await cleanup(request, id); }
  });

  test('dragging moves a file or a folder into a folder, and back to the top level', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Drag');
    try {
      await put(request, id, 'intro.tex');
      await put(request, id, 'chapters/one.tex');
      await put(request, id, 'figures/plot.tex');
      await put(request, id, 'other/main.tex');
      await openProject(page, id);

      await page.getByTestId('file-intro.tex').dragTo(page.getByTestId('dir-chapters'));
      await expect(page.getByTestId('file-chapters/intro.tex')).toBeVisible();
      await expect(page.getByTestId('file-intro.tex')).toHaveCount(0);

      // a file's row stands for its folder
      await page.getByTestId('dir-figures').dragTo(page.getByTestId('file-chapters/one.tex'));
      await expect(page.getByTestId('dir-chapters/figures')).toBeVisible();
      await expect(page.getByTestId('file-chapters/figures/plot.tex')).toBeVisible();

      // onto the space below the rows: the top level
      await page.getByTestId('file-chapters/one.tex').dragTo(page.locator('.filetree__hint'));
      await expect(page.getByTestId('file-one.tex')).toBeVisible();

      // a folder dropped onto a folder inside itself stays put
      await page.getByTestId('dir-chapters').dragTo(page.getByTestId('dir-chapters/figures'));
      await expect(page.getByTestId('dir-chapters')).toBeVisible();

      // a name already taken in the folder: nothing is replaced
      await page.getByTestId('file-main.tex').dragTo(page.getByTestId('dir-other'));
      await expect(page.locator('.toast').filter({ hasText: '"other/main.tex" already exists' })).toBeVisible();
      await expect(page.getByTestId('file-main.tex')).toBeVisible();

      await expect.poll(() => listing(request, id)).toEqual(expect.arrayContaining([
        'chapters/figures/plot.tex', 'chapters/intro.tex', 'main.tex', 'one.tex', 'other/main.tex',
      ]));
      expect((await listing(request, id)).filter((p) => p.startsWith('figures/'))).toEqual([]);
    } finally { await cleanup(request, id); }
  });
});
