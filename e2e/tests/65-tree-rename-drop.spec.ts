import { test, expect } from '../fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { createProject, openProject, openSidebarTab, cleanup } from './helpers';

/** The file tree's rename, drops from the desktop, Source view, row menu and
 *  sidebar tabs (UX audit, group "tree"). */

const listing = async (request: APIRequestContext, id: string): Promise<string[]> => {
  const { files } = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { files: { path: string; type: string }[] };
  return files.filter((f) => f.type === 'file').map((f) => f.path).sort();
};
const put = (request: APIRequestContext, id: string, path: string, content = 'x\n') =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
const selection = (input: Locator) => input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
const toast = (page: Page, text: string) => page.locator('.toast').filter({ hasText: text });

interface Dropped { name: string; text: string; unreadable?: boolean }
/** Drags files from outside the page onto `selector` (or the point), the way
 *  a desktop drag reaches the page: dragover, then drop. Says which of the
 *  two the page took, the browser's own handling being what a cancel stops. */
const dropFiles = (page: Page, at: string | { x: number; y: number }, files: Dropped[]) =>
  page.evaluate(({ at, files }) => {
    const el = typeof at === 'string' ? document.querySelector(at)! : document.elementFromPoint(at.x, at.y)!;
    const r = el.getBoundingClientRect();
    const point = typeof at === 'string' ? { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 12) } : at;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }));
    const unreadable = new Set(files.filter((f) => f.unreadable).map((f) => f.name));
    if (unreadable.size) {
      const read = Blob.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function (this: File) {
        return unreadable.has(this.name) ? Promise.reject(new DOMException('A requested file or directory could not be found', 'NotFoundError')) : read.call(this);
      };
    }
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: point.x, clientY: point.y };
    const overTaken = !el.dispatchEvent(new DragEvent('dragover', opts));
    const dropTaken = !el.dispatchEvent(new DragEvent('drop', opts));
    return { overTaken, dropTaken };
  }, { at, files });

test.describe('file tree: rename, drops, view and row menu', () => {
  test('renaming a file or folder inside a folder selects only its name, so it stays there', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Rename Nested');
    try {
      await put(request, id, 'chapters/intro.tex', 'Intro text\n');
      await put(request, id, 'parts/old/a.tex');
      await openProject(page, id);
      await page.getByTestId('dir-chapters').click();
      await page.getByTestId('file-chapters/intro.tex').click({ button: 'right' });
      await page.getByTestId('file-menu-rename').click();
      const input = page.getByTestId('dialog-input');
      await expect(input).toHaveValue('chapters/intro.tex');
      await expect.poll(() => selection(input)).toEqual([9, 14]);
      await page.keyboard.type('introduction');
      await expect(input).toHaveValue('chapters/introduction.tex');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('file-chapters/introduction.tex')).toBeVisible();
      await expect.poll(() => listing(request, id)).toContain('chapters/introduction.tex');
      expect(await listing(request, id), 'not moved to the top level').not.toContain('introduction.tex');

      // the palette's rename of the open file does the same
      await page.getByTestId('file-chapters/introduction.tex').click();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/introduction.tex');
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('palette-input').fill('rename');
      await page.getByTestId('palette-item-rename-file').click();
      await expect(input).toHaveValue('chapters/introduction.tex');
      await expect.poll(() => selection(input)).toEqual([9, 21]);
      await page.keyboard.type('opening');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/opening.tex');
      await expect(page.locator('.cm-content')).toContainText('Intro text');

      // a folder: its own name, not the folders above it
      await page.getByTestId('dir-parts').click();
      await page.getByTestId('dir-parts/old').click({ button: 'right' });
      await page.getByTestId('folder-menu-rename').click();
      await expect(input).toHaveValue('parts/old');
      await expect.poll(() => selection(input)).toEqual([6, 9]);
      await page.keyboard.type('new');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('dir-parts/new')).toBeVisible();
      await expect.poll(() => listing(request, id)).toContain('parts/new/a.tex');
    } finally { await cleanup(request, id); }
  });

  test('a file dropped outside the tree never leaves the app, and dropped on the editor it uploads', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Drop');
    try {
      await openProject(page, id);
      const editor = page.locator('.cm-content');

      // onto the editor: uploaded, not pasted into the document
      const onEditor = await dropFiles(page, '.cm-content', [{ name: 'dropped.bib', text: '@misc{dropped2026, title={Dropped}}' }]);
      expect(onEditor).toEqual({ overTaken: true, dropTaken: true });
      await expect(toast(page, 'Uploaded dropped.bib')).toBeVisible();
      await expect(page.getByTestId('file-dropped.bib')).toBeVisible();
      await expect.poll(() => listing(request, id)).toContain('dropped.bib');
      await expect(editor).not.toContainText('dropped2026');

      // onto the PDF: refused, so the browser does not open the file in place of the app
      const onPdf = await dropFiles(page, '[data-testid="pdf-pane"]', [{ name: 'figure.png', text: 'png' }]);
      expect(onPdf).toEqual({ overTaken: true, dropTaken: true });

      // the tree fills the sidebar: the space at its foot takes a drop to the top level
      const box = (await page.getByTestId('sidebar').boundingBox())!;
      const foot = { x: box.x + box.width / 2, y: box.y + box.height - 12 };
      expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="file-tree"]'), foot)).toBe(true);
      await dropFiles(page, foot, [{ name: 'notes.txt', text: 'notes' }]);
      await expect(toast(page, 'Uploaded notes.txt')).toBeVisible();

      // an entry that cannot be read (a folder) says so, and the rest still uploads
      await dropFiles(page, '[data-testid="file-tree"]', [{ name: 'figures', text: '', unreadable: true }, { name: 'later.tex', text: 'later' }]);
      await expect(toast(page, 'Could not read figures: to upload a folder, drop the files in it')).toBeVisible();
      await expect(toast(page, 'Uploaded later.tex')).toBeVisible();
      expect(await listing(request, id)).not.toContain('figure.png');

      // text dragged onto the editor is still dropped as text
      await page.evaluate(() => {
        const el = document.querySelector('.cm-line')!;
        const r = el.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('text/plain', 'DRAGGEDTEXT');
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 2, clientY: r.y + r.height / 2 }));
      });
      await expect(editor).toContainText('DRAGGEDTEXT');
    } finally { await cleanup(request, id); }
  });

  test('data and notes show in the Source view; the view, drafts and the tree scroll survive another tab and a reload', async ({ page, request }) => {
    const id = await createProject(request, 'Tree View Kept');
    const other = await createProject(request, 'Tree View Other');
    try {
      await put(request, id, 'main.tex', 'A paragraph to comment on.\n');
      await put(request, id, 'data/results.csv', 'a,b\n1,2\n');
      await put(request, id, 'plot.pgf');
      await put(request, id, 'notes.txt');
      await put(request, id, 'Makefile');
      for (let i = 1; i <= 40; i++) await put(request, id, `sections/s${i}.tex`);
      await request.post(`/api/projects/${id}/comments`, { data: { branch: 'main', file: 'main.tex', anchor: { from: 2, to: 11, quote: 'paragraph' }, body: 'Shorter?' } });
      await openProject(page, id);

      await expect(page.getByTestId('file-notes.txt')).toBeVisible();
      await expect(page.getByTestId('file-plot.pgf')).toBeVisible();
      await page.getByTestId('dir-data').click();
      await expect(page.getByTestId('file-data/results.csv')).toBeVisible();
      await expect(page.getByTestId('file-Makefile')).toHaveCount(0);
      await page.getByTestId('source-only').click();
      await expect(page.getByTestId('file-Makefile')).toBeVisible();

      // numbered names in number order
      await page.getByTestId('dir-sections').click();
      const order = await page.locator('[data-testid^="file-sections/"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
      expect(order.slice(0, 3)).toEqual(['file-sections/s1.tex', 'file-sections/s2.tex', 'file-sections/s3.tex']);
      expect(order.at(-1)).toBe('file-sections/s40.tex');

      const treePanel = page.getByTestId('file-tree').locator('xpath=..');
      await treePanel.evaluate((el) => { el.scrollTop = 300; });
      const scrolled = await treePanel.evaluate((el) => el.scrollTop);
      expect(scrolled).toBeGreaterThan(100);

      await openSidebarTab(page, 'history');
      await page.getByTestId('commit-message').fill('Half a message');
      await page.getByTestId('tab-review').click();
      const reply = page.locator('[data-testid^="reply-"]').first();
      await reply.fill('Half a reply');

      await page.getByTestId('tab-files').click();
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'false');
      expect(await treePanel.evaluate((el) => el.scrollTop)).toBe(scrolled);
      await openSidebarTab(page, 'history');
      await expect(page.getByTestId('commit-message')).toHaveValue('Half a message');
      await page.getByTestId('tab-review').click();
      await expect(reply).toHaveValue('Half a reply');

      await page.reload();
      await expect(page.getByTestId('file-Makefile')).toBeVisible();
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'false');

      // kept per project: another one opens in the Source view
      await openProject(page, other);
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await cleanup(request, id);
      await cleanup(request, other);
    }
  });

  test('a new file gets .tex, rows have a menu button, a move can be undone and a failed delete says so', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Row Actions');
    try {
      await put(request, id, 'figures/plot.tex');
      await openProject(page, id);

      await page.getByTestId('new-file').click();
      const name = page.getByTestId('new-file-name');
      await name.fill('introduction');
      await name.press('Enter');
      await expect(page.getByTestId('active-file')).toHaveText('introduction.tex');
      await expect(page.getByTestId('file-introduction.tex')).toBeVisible();
      await expect.poll(() => listing(request, id)).toContain('introduction.tex');

      // the open file's row shows its menu button; another row shows it under the mouse
      await expect(page.getByTestId('row-menu-introduction.tex')).toBeVisible();
      await expect(page.getByTestId('row-menu-main.tex')).toBeHidden();
      await page.getByTestId('file-main.tex').hover();
      await page.getByTestId('row-menu-main.tex').click();
      await expect(page.getByTestId('file-menu')).toBeVisible();
      await expect(page.getByTestId('file-menu-rename')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByTestId('dir-figures').hover();
      await page.getByTestId('row-menu-figures').click();
      await expect(page.getByTestId('folder-menu-rename')).toBeVisible();
      await page.keyboard.press('Escape');

      // a drag-move says where the file went, and Undo puts it back
      await page.getByTestId('file-introduction.tex').dragTo(page.getByTestId('dir-figures'));
      await expect(toast(page, 'Moved introduction.tex to figures/')).toBeVisible();
      await expect(page.getByTestId('active-file')).toHaveText('figures/introduction.tex');
      await page.getByTestId('undo-move').click();
      await expect(page.getByTestId('file-introduction.tex')).toBeVisible();
      await expect(page.getByTestId('active-file')).toHaveText('introduction.tex');
      await expect.poll(() => listing(request, id)).toContain('introduction.tex');
      expect(await listing(request, id)).not.toContain('figures/introduction.tex');

      // a delete the server refuses is reported, and the file stays
      await page.route((url) => url.pathname === `/api/projects/${id}/file`, (route) => (route.request().method() === 'DELETE'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the disk is read-only' }) })
        : route.fallback()));
      await page.getByTestId('file-figures/plot.tex').click({ button: 'right' });
      await page.getByTestId('file-menu-delete').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(toast(page, 'Could not delete figures/plot.tex: the disk is read-only')).toBeVisible();
      await expect(page.getByTestId('file-figures/plot.tex')).toBeVisible();

      // the palette's delete of the open file too
      await page.getByTestId('file-main.tex').click();
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('palette-input').fill('delete');
      await page.getByTestId('palette-item-delete-file').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(toast(page, 'Could not delete main.tex: the disk is read-only')).toBeVisible();
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
    } finally { await cleanup(request, id); }
  });
});
