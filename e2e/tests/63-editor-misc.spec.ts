import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, moreAction, openSidebarTab } from './helpers';

const DOC = '\\documentclass{article}\n\\begin{document}\nShowcase text.\n\\end{document}\n';

const readFile = async (request: import('@playwright/test').APIRequestContext, id: string, path: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();

/** Drops a file from outside the page onto `selector`: true when the page took
 *  both the dragover and the drop, so the browser does not open the file. */
const dropFile = (page: import('@playwright/test').Page, selector: string, name: string) =>
  page.evaluate(({ selector, name }) => {
    const el = document.querySelector(selector)!;
    const r = el.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped'], name, { type: 'text/plain' }));
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + Math.min(r.height / 2, 12) };
    return !el.dispatchEvent(new DragEvent('dragover', opts)) && !el.dispatchEvent(new DragEvent('drop', opts));
  }, { selector, name });

test.describe('the editor remembers, refuses and stays out of the way', () => {
  test('a reload opens the file that was open, per branch, and the main document once it is gone', async ({ page, request }) => {
    const id = await createProject(request, 'Reopen Last File');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'chapter.tex', content: 'The chapter being written.\n' } });
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft' } })).ok()).toBe(true);

      await openProject(page, id);
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      await page.getByTestId('file-chapter.tex').click();
      await expect(page.getByTestId('active-file')).toHaveText('chapter.tex');

      await page.reload();
      await expect(page.getByTestId('active-file')).toHaveText('chapter.tex');
      await expect(page.locator('.cm-content')).toContainText('The chapter being written.');

      // another branch keeps its own
      await openProject(page, id, 'draft');
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      await openProject(page, id);
      await expect(page.getByTestId('active-file')).toHaveText('chapter.tex');

      await page.goto('/');
      expect((await request.delete(`/api/projects/${id}/file?branch=main&path=chapter.tex`)).ok()).toBe(true);
      await openProject(page, id);
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
    } finally { await cleanup(request, id); }
  });

  test('a read-only showcase takes no typing, says so, and makes a copy that does', async ({ page, request }) => {
    const id = await createProject(request, 'Read-only Showcase');
    let copy = '';
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'chapters/one.tex', content: 'One.\n' } });
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft' } })).ok()).toBe(true);
      expect((await request.post(`/api/test/showcase/${id}`)).ok()).toBe(true);
      expect((await (await request.get(`/api/projects/${id}`)).json()).readOnly).toBe(true);

      await openProject(page, id);
      await expect(page.getByTestId('showcase-note')).toContainText('This showcase project is read-only');
      const content = page.locator('.cm-content');
      await expect(content).toContainText('Showcase text.');
      await expect(content).toHaveAttribute('aria-readonly', 'true');

      // the file tree opens files and folders and changes its view, and nothing else
      for (const control of ['new-file', 'new-folder', 'upload-file', 'row-menu-main.tex', 'row-menu-chapters']) {
        await expect(page.getByTestId(control), control).toHaveCount(0);
      }
      await expect(page.locator('.filetree__hint')).toHaveCount(0);
      await page.getByTestId('source-only').click();
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'false');
      await page.getByTestId('source-only').click();
      await page.getByTestId('dir-chapters').click();
      await expect(page.getByTestId('file-chapters/one.tex')).toBeVisible();
      for (const row of ['file-main.tex', 'dir-chapters']) {
        await expect(page.getByTestId(row), row).not.toHaveAttribute('draggable', 'true');
        await page.getByTestId(row).click({ button: 'right' });
        await expect(page.getByTestId('file-menu'), row).toHaveCount(0);
        await expect(page.getByTestId('folder-menu'), row).toHaveCount(0);
      }
      // a file from the desktop is not uploaded, and does not open in place of the app
      for (const target of ['[data-testid="file-tree"]', '[data-testid="dir-chapters"]', '.cm-content']) {
        expect(await dropFile(page, target, 'dropped.tex'), target).toBe(true);
      }

      // what would only be refused is not offered: comments, the project's settings
      await expect(page.getByTestId('add-comment')).toHaveCount(0);
      await page.locator('.cm-line', { hasText: 'Showcase text.' }).dblclick();
      await page.keyboard.press('ControlOrMeta+Shift+m');
      await page.getByTestId('tab-review').click();
      await expect(page.getByTestId('review-empty')).toHaveText('Comments are off on this read-only showcase.');
      await expect(page.getByTestId('comment-composer')).toHaveCount(0);
      await page.getByTestId('project-settings-open').click();
      await expect(page.getByTestId('settings-read-only')).toBeVisible();
      for (const field of ['settings-name', 'settings-root-file', 'settings-engine', 'settings-stop-on-error', 'settings-commit-mode']) {
        await expect(page.getByTestId(field), field).toBeDisabled();
      }
      await expect(page.getByTestId('settings-auto-typeset'), 'this browser\'s settings stay').toBeEnabled();
      await page.getByTestId('settings-close').click();
      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('Typeset');
      await expect(page.getByTestId('palette-item-typeset')).toBeVisible();
      await expect(page.getByTestId('palette-item-engine-lualatex')).toHaveCount(0);
      await page.getByTestId('palette-input').fill('New');
      await expect(page.getByTestId('palette-item-new-file')).toHaveCount(0);
      await expect(page.getByTestId('palette-item-new-folder')).toHaveCount(0);
      await page.getByTestId('palette-input').fill('Upload files');
      await expect(page.getByTestId('palette-item-upload-files')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('command-palette')).toHaveCount(0);

      await page.locator('.cm-line', { hasText: 'Showcase text.' }).click();
      await page.keyboard.type('Typed by a visitor');
      await page.keyboard.press('Enter');
      // a programmatic insert is refused as well
      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('Insert figure');
      await page.keyboard.press('Enter');
      await expect(content).not.toContainText('Typed by a visitor');
      await expect(content).not.toContainText('begin{figure}');

      // past the collab debounce: nothing reached the server's document
      await page.waitForTimeout(3000);
      expect(await readFile(request, id, 'main.tex')).toBe(DOC);
      expect((await request.get(`/api/projects/${id}/file?branch=main&path=dropped.tex`)).status(), 'no drop was uploaded').toBe(404);
      await expect(page.locator('.toast', { hasText: 'dropped.tex' })).toHaveCount(0);
      await page.reload();
      await expect(page.locator('.cm-content')).toContainText('Showcase text.');
      await expect(page.locator('.cm-content')).not.toContainText('Typed by a visitor');

      // files are not renamed or deleted from the palette, history takes no commit
      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('main.tex');
      await expect(page.getByTestId('palette-item-open-main.tex')).toBeVisible();
      await expect(page.getByTestId('palette-item-rename-file')).toHaveCount(0);
      await expect(page.getByTestId('palette-item-delete-file')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await openSidebarTab(page, 'history');
      await expect(page.getByTestId('history-panel')).toBeVisible();
      await expect(page.getByTestId('commit-button')).toHaveCount(0);
      await expect(page.getByTestId('commit-message')).toHaveCount(0);
      // branches open, and are not created, merged or deleted
      await page.getByTestId('branch-menu').click();
      await expect(page.getByTestId('branch-draft')).toBeVisible();
      await expect(page.getByTestId('merge-draft')).toHaveCount(0);
      await expect(page.getByTestId('delete-draft')).toHaveCount(0);
      await expect(page.getByTestId('new-branch')).toHaveCount(0);
      await expect(page.getByTestId('remote-publish-open')).toHaveCount(0);
      await page.getByTestId('branch-draft').click();
      await expect(page).toHaveURL(/branch=draft/);
      await expect(page.locator('.cm-content')).toContainText('Showcase text.');
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-main').click();
      await expect(page).not.toHaveURL(/branch=draft/);

      await page.getByTestId('showcase-copy').click();
      await expect(page).not.toHaveURL(new RegExp(`/p/${id}`));
      copy = new URL(page.url()).pathname.split('/').pop()!;
      await expect(page.getByTestId('showcase-note')).toHaveCount(0);
      await expect(page.getByTestId('add-comment')).toBeVisible();
      await expect(page.getByTestId('new-file')).toBeVisible();
      await expect(page.getByTestId('row-menu-main.tex')).toHaveCount(1);
      await openSidebarTab(page, 'history');
      await expect(page.getByTestId('commit-button')).toBeVisible();
      await expect(page.locator('.cm-content')).not.toHaveAttribute('aria-readonly', 'true');
      await page.locator('.cm-line', { hasText: 'Showcase text.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Mine now.');
      await expect(page.locator('.cm-content')).toContainText('Showcase text. Mine now.');
      await expect.poll(() => readFile(request, copy, 'main.tex'), { timeout: 15_000 }).toContain('Mine now.');
      expect(await readFile(request, id, 'main.tex')).toBe(DOC);
      await expect(page.getByText('read-only showcase project — create your own'), 'no write was refused on the way').toHaveCount(0);
    } finally {
      await request.delete(`/api/test/showcase/${id}`).catch(() => {});
      await cleanup(request, id);
      if (copy) await cleanup(request, copy);
    }
  });

  test('a showcase with no files says it is read-only instead of offering New file', async ({ page, request }) => {
    const res = await request.post('/api/projects', { data: { name: 'Empty Showcase', template: 'blank' } });
    expect(res.ok()).toBe(true);
    const id = (await res.json()).id as string;
    try {
      expect((await request.post(`/api/test/showcase/${id}`)).ok()).toBe(true);
      await page.goto(`/p/${id}`);
      await expect(page.getByTestId('empty-project')).toBeVisible();
      await expect(page.getByTestId('empty-showcase')).toHaveText('This showcase project is read-only. Make a copy to edit it.');
      await expect(page.getByTestId('empty-new-file')).toHaveCount(0);
      await expect(page.getByTestId('new-file')).toHaveCount(0);
    } finally {
      await request.delete(`/api/test/showcase/${id}`).catch(() => {});
      await cleanup(request, id);
    }
  });

  test('an Asymptote figure opens as text, not as a download', async ({ page, request }) => {
    const id = await createProject(request, 'Asymptote Figure');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'figure.asy', content: 'size(100);\ndraw(unitcircle);\n' } });
      await openProject(page, id);
      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('figure.asy');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('active-file')).toHaveText('figure.asy');
      await expect(page.locator('.cm-content')).toContainText('draw(unitcircle);');
      await expect(page.getByTestId('file-preview')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('the palette keys open nothing over a dialog, so Escape closes the dialog', async ({ page, request }) => {
    const id = await createProject(request, 'Keys Over Dialogs');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await page.getByTestId('project-settings-open').click();
      await expect(page.getByTestId('project-settings')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByTestId('command-palette')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('project-settings')).toHaveCount(0);
      await expect(page.getByTestId('command-palette'), 'no palette was left behind the dialog').toHaveCount(0);

      // with no dialog open the keys still open and close it
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByTestId('command-palette')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByTestId('command-palette')).toHaveCount(0);

      if (process.platform === 'darwin') {
        // a Mac's Ctrl+K is the editor's delete-to-end-of-line, not the palette
        await page.locator('.cm-line', { hasText: 'Showcase text.' }).click();
        await page.keyboard.press('Home');
        await page.keyboard.press('Control+k');
        await expect(page.locator('.cm-content')).not.toContainText('Showcase text.');
        await expect(page.getByTestId('command-palette')).toHaveCount(0);
      }
    } finally { await cleanup(request, id); }
  });

  test('the project list\'s palette keys open nothing over a dialog either', async ({ page }) => {
    await page.goto('/');
    await moreAction(page, 'open-about');
    await expect(page.getByTestId('about-modal')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('about-modal')).toHaveCount(0);
    await expect(page.getByTestId('command-palette'), 'no palette was left behind the dialog').toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
  });
});
