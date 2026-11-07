import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, openSidebarTab, cleanup } from './helpers';

/** The file tree's keyboard, its Source view keeping what was just added,
 *  New file in the open file's folder, and folder uploads with progress and
 *  one question for every file that exists (UX audit, group "d-tree"). */

const listing = async (request: APIRequestContext, id: string): Promise<string[]> => {
  const { files } = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { files: { path: string; type: string }[] };
  return files.filter((f) => f.type === 'file').map((f) => f.path).sort();
};
const put = (request: APIRequestContext, id: string, p: string, content = 'x\n') =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: p, content } });
const read = async (request: APIRequestContext, id: string, p: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(p)}`)).text();
const toast = (page: Page, text: string) => page.locator('.toast').filter({ hasText: text });

type Folder = { [name: string]: string | Folder };
/** Drops a folder from the desktop onto `selector`: the drop's item hands out
 *  a directory entry, as a browser's does for a folder dragged from Finder. */
const dropFolder = (page: Page, selector: string, name: string, tree: Folder) =>
  page.evaluate(({ selector, name, tree }) => {
    type Node = string | { [k: string]: Node };
    const entry = (n: string, node: Node): unknown => (typeof node === 'string'
      ? { name: n, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(new File([node], n)) }
      : {
        name: n, isFile: false, isDirectory: true,
        createReader: () => {
          const all = Object.entries(node).map(([k, v]) => entry(k, v));
          return { readEntries: (ok: (e: unknown[]) => void) => ok(all.splice(0, 2)) };
        },
      });
    const el = document.querySelector(selector)!;
    const r = el.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.items.add(new File([''], name));
    const real = DataTransferItem.prototype.webkitGetAsEntry;
    DataTransferItem.prototype.webkitGetAsEntry = function (this: DataTransferItem) {
      return (this.getAsFile()?.name === name ? entry(name, tree) : real.call(this)) as FileSystemEntry;
    };
    try {
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + Math.min(r.height / 2, 12) };
      el.dispatchEvent(new DragEvent('dragover', opts));
      el.dispatchEvent(new DragEvent('drop', opts));
    } finally {
      DataTransferItem.prototype.webkitGetAsEntry = real;
    }
  }, { selector, name, tree });

test.describe('file tree: keyboard', () => {
  test('arrow keys, Home, End and letters move through the rows; F2 renames, Delete deletes; one Tab stop', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Keys');
    try {
      await put(request, id, 'chapters/intro.tex');
      await put(request, id, 'chapters/outro.tex');
      await put(request, id, 'zotero.bib', '@misc{a}\n');
      await openProject(page, id);
      const rows = page.getByTestId('file-tree-rows');
      await expect(rows).toHaveAttribute('role', 'tree');
      const main = page.getByTestId('file-main.tex');
      await expect(main).toHaveAttribute('role', 'treeitem');
      await expect(main).toHaveAttribute('aria-current', 'true');
      await expect(rows.locator('[role="treeitem"][tabindex="0"]'), 'the open file is the tree\'s Tab stop').toHaveCount(1);
      await expect(main).toHaveAttribute('tabindex', '0');

      await main.focus();
      await page.keyboard.press('ArrowUp');
      const chapters = page.getByTestId('dir-chapters');
      await expect(chapters).toBeFocused();
      await expect(chapters).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('ArrowRight');
      await expect(chapters).toHaveAttribute('aria-expanded', 'true');
      await expect(chapters).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('file-chapters/intro.tex')).toBeFocused();
      await expect(page.getByTestId('file-chapters/intro.tex')).toHaveAttribute('aria-level', '2');
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('file-chapters/outro.tex')).toBeFocused();
      await expect(rows.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
      await expect(page.getByTestId('file-chapters/outro.tex')).toHaveAttribute('tabindex', '0');
      await page.keyboard.press('ArrowLeft');
      await expect(chapters).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(chapters).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('file-chapters/intro.tex')).toHaveCount(0);
      await page.keyboard.press('End');
      await expect(page.getByTestId('file-zotero.bib')).toBeFocused();
      await page.keyboard.press('Home');
      await expect(chapters).toBeFocused();
      await page.keyboard.press('z');
      await expect(page.getByTestId('file-zotero.bib')).toBeFocused();
      // Enter opens the focused file
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('active-file')).toHaveText('zotero.bib');

      // F2 renames, the name selected without its extension; focus follows the new name
      await page.getByTestId('file-zotero.bib').focus();
      await page.keyboard.press('F2');
      const input = page.getByTestId('dialog-input');
      await expect(input).toHaveValue('zotero.bib');
      await page.keyboard.type('sources');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('file-sources.bib')).toBeFocused();
      await expect.poll(() => listing(request, id)).toContain('sources.bib');

      // Delete asks, then deletes; focus stays in the tree, on the row above the last one
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('dialog-title')).toHaveText('Delete sources.bib?');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('file-sources.bib')).toHaveCount(0);
      await expect(page.getByTestId('file-references.bib')).toBeFocused();
      await expect.poll(() => listing(request, id)).not.toContain('sources.bib');
      // a folder too
      await page.keyboard.press('Home');
      await page.keyboard.press('F2');
      await expect(input).toHaveValue('chapters');
      await page.keyboard.press('Escape');
      await expect(chapters).toBeFocused();

      // nothing in the tree's own region fails axe
      const r = await new AxeBuilder({ page }).include('[data-testid="file-tree"]').analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
    } finally { await cleanup(request, id); }
  });
});

test.describe('file tree: Source view and new files', () => {
  test('the open file and files just added show in the Source view, and a row says how many are hidden', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Kept Files');
    try {
      await put(request, id, 'Makefile', 'all:\n\tlatexmk # BUILDRULE\n');
      await put(request, id, 'data/raw.xlsx');
      await openProject(page, id);
      await expect(page.getByTestId('file-Makefile')).toHaveCount(0);
      await expect(page.getByTestId('tree-hidden')).toContainText('2 files hidden');

      // uploaded and created files of any kind stay listed
      await page.getByTestId('upload-input').setInputFiles({ name: 'build.sh', mimeType: 'text/plain', buffer: Buffer.from('echo hi\n') });
      await expect(page.getByTestId('file-build.sh')).toBeVisible();
      await page.getByTestId('new-file').click();
      await page.getByTestId('new-file-name').fill('notes.yaml');
      await page.getByTestId('new-file-name').press('Enter');
      await expect(page.getByTestId('active-file')).toHaveText('notes.yaml');
      await page.getByTestId('file-main.tex').click();
      await expect(page.getByTestId('file-notes.yaml')).toBeVisible();
      await expect(page.getByTestId('file-build.sh')).toBeVisible();
      await expect(page.getByTestId('tree-hidden')).toContainText('2 files hidden');

      // a file opened from elsewhere shows while it is open
      await openSidebarTab(page, 'search');
      await page.getByTestId('search-input').fill('BUILDRULE');
      await page.locator('[data-testid="search-match"][data-path="Makefile"]').first().click();
      await expect(page.getByTestId('active-file')).toHaveText('Makefile');
      await page.getByTestId('tab-files').click();
      await expect(page.getByTestId('file-Makefile')).toHaveAttribute('aria-current', 'true');
      await expect(page.getByTestId('tree-hidden')).toContainText('1 file hidden');

      // Show all is the All view
      await page.getByTestId('tree-show-all').click();
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('tree-hidden')).toHaveCount(0);
      await page.getByTestId('dir-data').click();
      await expect(page.getByTestId('file-data/raw.xlsx')).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('New file goes into the open file\'s folder, its name typed in that folder; the toolbar stays in reach', async ({ page, request }) => {
    const id = await createProject(request, 'Tree New In Folder');
    try {
      await put(request, id, 'chapters/intro.tex');
      for (let i = 1; i <= 40; i++) await put(request, id, `sections/s${i}.tex`);
      await openProject(page, id);
      await page.getByTestId('dir-chapters').click();
      await page.getByTestId('file-chapters/intro.tex').click();
      await expect(page.getByTestId('active-file')).toHaveText('chapters/intro.tex');

      await page.getByTestId('new-file').click();
      const name = page.getByTestId('new-file-name');
      await expect(name).toHaveValue('chapters/');
      await expect(name).toBeFocused();
      const group = page.locator('[role="group"]').filter({ has: page.getByTestId('file-chapters/intro.tex') });
      await expect(group.getByTestId('new-file-name'), 'the input is inside the folder').toBeVisible();
      await page.keyboard.type('methods');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('active-file')).toHaveText('chapters/methods.tex');
      await expect.poll(() => listing(request, id)).toContain('chapters/methods.tex');

      // a long open folder: the toolbar stays at the foot of the panel, at the top and the bottom of the scroll
      await page.getByTestId('dir-sections').click();
      await expect(page.getByTestId('file-sections/s40.tex')).toHaveCount(1);
      const panel = page.getByTestId('file-tree').locator('xpath=..');
      await expect.poll(() => panel.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true);
      await panel.evaluate((el) => { el.scrollTop = 0; });
      await expect(page.getByTestId('new-file')).toBeInViewport();
      await expect(page.getByTestId('file-sections/s40.tex')).not.toBeInViewport();
      await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect(page.getByTestId('new-file')).toBeInViewport();
      await expect(page.getByTestId('file-sections/s40.tex')).toBeInViewport();
    } finally { await cleanup(request, id); }
  });
});

test.describe('file tree: uploads', () => {
  test('a folder uploads by the picker and by a drop, at its paths, without dot-files', async ({ page, request }, testInfo) => {
    const id = await createProject(request, 'Tree Folder Upload');
    try {
      await put(request, id, 'chapters/one.tex');
      const dir = testInfo.outputPath('figures');
      fs.mkdirSync(path.join(dir, 'plots'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.png'), 'a');
      fs.writeFileSync(path.join(dir, 'plots', 'b.csv'), 'x,y\n');
      fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
      await openProject(page, id);

      // from the command palette, as from the toolbar's Upload a folder
      const chooser = page.waitForEvent('filechooser');
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('palette-input').fill('Upload a folder');
      await page.getByTestId('palette-item-upload-folder').click();
      await (await chooser).setFiles(dir);
      await expect(toast(page, 'Uploaded 2 files')).toBeVisible();
      await expect(page.getByTestId('dir-figures')).toBeVisible();
      await expect.poll(() => listing(request, id)).toEqual(expect.arrayContaining(['figures/a.png', 'figures/plots/b.csv']));
      expect(await listing(request, id)).not.toContain('figures/.DS_Store');

      // dropped onto a folder, it lands inside it; a .git folder in it stays behind
      await page.getByTestId('dir-chapters').click();
      await dropFolder(page, '[data-testid="dir-chapters"]', 'data', { 'r1.csv': '1', more: { 'r2.csv': '2', 'r3.csv': '3' }, '.git': { HEAD: 'ref' }, '.DS_Store': 'x' });
      await expect(toast(page, 'Uploaded 3 files')).toBeVisible();
      await expect(page.getByTestId('dir-chapters/data')).toBeVisible();
      await expect.poll(() => listing(request, id)).toEqual(expect.arrayContaining(['chapters/data/r1.csv', 'chapters/data/more/r2.csv', 'chapters/data/more/r3.csv']));
      const all = await listing(request, id);
      expect(all.filter((p) => p.includes('.git/') || p.endsWith('.DS_Store'))).toEqual([]);
      expect(await read(request, id, 'chapters/data/more/r3.csv')).toBe('3');

      // a folder with nothing in it says so
      await dropFolder(page, '[data-testid="file-tree"]', 'empty', { '.DS_Store': 'x' });
      await expect(toast(page, 'Nothing to upload in empty')).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('uploads show progress, and files that exist are asked about once, Enter keeping them', async ({ page, request }) => {
    const id = await createProject(request, 'Tree Upload Progress');
    try {
      await put(request, id, 'fig1.csv', 'old1');
      await put(request, id, 'fig2.csv', 'old2');
      await openProject(page, id);
      const files = (tag: string) => ['fig1.csv', 'fig2.csv', 'fig3.csv'].map((name) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(`${tag} ${name}`) }));

      // one question for both; Replace all is the red button, and Enter skips
      let puts = 0;
      const fileRoute = (url: URL) => url.pathname === `/api/projects/${id}/file`;
      await page.route(fileRoute, async (route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        puts += 1;
        await new Promise((r) => setTimeout(r, 900));
        return route.fallback();
      });
      await page.getByTestId('upload-input').setInputFiles(files('new'));
      await expect(page.getByTestId('dialog-title')).toHaveText('Replace 2 files?');
      await expect(page.getByTestId('dialog-message')).toContainText('fig1.csv and fig2.csv already exist');
      await expect(page.getByTestId('dialog-confirm')).toHaveText('Replace all');
      await expect(page.getByTestId('dialog-cancel')).toHaveText('Skip existing');
      await expect(page.getByTestId('dialog-confirm')).toHaveClass(/btn--danger/);
      await expect(page.getByTestId('dialog-cancel')).toBeFocused();
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('upload-progress')).toContainText(/Uploading [1-3] of 3…/);
      await expect(toast(page, 'Uploaded 3 files')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('upload-progress')).toHaveCount(0);
      await expect(page.getByTestId('app-dialog'), 'no second question').toHaveCount(0);
      expect(puts).toBe(3);
      expect(await read(request, id, 'fig1.csv')).toBe('new fig1.csv');
      expect(await read(request, id, 'fig3.csv')).toBe('new fig3.csv');
      await page.unroute(fileRoute);

      // Skip existing, Enter's answer, uploads only what is new
      await page.getByTestId('upload-input').setInputFiles([...files('again'), { name: 'fig4.csv', mimeType: 'text/csv', buffer: Buffer.from('four') }]);
      await expect(page.getByTestId('dialog-title')).toHaveText('Replace 3 files?');
      await expect(page.getByTestId('dialog-cancel')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(toast(page, 'Uploaded fig4.csv')).toBeVisible();
      expect(await read(request, id, 'fig1.csv')).toBe('new fig1.csv');
      expect(await read(request, id, 'fig4.csv')).toBe('four');

      // a file someone else added meanwhile is asked about after the rest are up
      await page.route(fileRoute, async (route) => {
        const body = route.request().postDataJSON() as { path?: string; createOnly?: boolean } | null;
        if (route.request().method() === 'PUT' && body?.path === 'late.csv' && body.createOnly) {
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'A file with that name already exists' }) });
        }
        return route.fallback();
      });
      await page.getByTestId('upload-input').setInputFiles([{ name: 'late.csv', mimeType: 'text/csv', buffer: Buffer.from('late') }, { name: 'fig5.csv', mimeType: 'text/csv', buffer: Buffer.from('five') }]);
      await expect(page.getByTestId('dialog-title')).toHaveText('Replace late.csv?');
      await expect(page.getByTestId('dialog-cancel')).toHaveText('Keep existing');
      await page.getByTestId('dialog-confirm').click();
      await expect(toast(page, 'Uploaded 2 files')).toBeVisible();
      expect(await read(request, id, 'late.csv')).toBe('late');
    } finally { await cleanup(request, id); }
  });
});
