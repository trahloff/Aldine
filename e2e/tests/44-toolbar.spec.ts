import { test, expect } from '../fixtures';
import { createProject, createPaperProject, openProject, expectTypesetOk, cleanup } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * The editor's top bar keeps one control per job: the branch pill carries the
 * git controls, Share carries the downloads, settings carries the engine, and
 * the preview header holds what belongs to the PDF.
 */
test.describe('editor toolbar', () => {
  test('one branch pill; publishing lives in its menu, downloads in Share', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Toolbar Pill');
    try {
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.getByTestId('branch-menu')).toHaveCount(1);
      await expect(page.getByTestId('remote-publish-open')).toHaveCount(0);
      await expect(page.getByTestId('engine-select')).toHaveCount(0);
      await expect(page.getByTestId('download-pdf')).toHaveCount(0);

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('remote-publish-open').click();
      await expect(page.getByTestId('remote-publish')).toBeVisible();
      await page.keyboard.press('Escape');

      await page.getByTestId('share-project').click();
      await expect(page.getByTestId('download-pdf')).toHaveAttribute('href', /\/api\/projects\/.+\/output/);
      await expect(page.getByTestId('download-zip')).toHaveAttribute('href', /\/archive\?branch=main$/);
      await page.getByTestId('share-close').click();

      // the preview header holds the PDF's own controls, and no title
      const preview = page.locator('.pane--preview .pane__header');
      await expect(preview.getByTestId('jump-to-pdf')).toBeVisible();
      await expect(preview.getByTestId('word-count')).toContainText(/\d+ words/);
      await expect(preview).not.toContainText('Preview');
    } finally { await cleanup(request, id); }
  });

  test('the comment shortcut opens the composer on the selection', async ({ page, request }) => {
    const id = await createProject(request, 'Comment Shortcut');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'PLACEHOLDER needs a word.\n' } });
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('PLACEHOLDER', { timeout: 10_000 });
      await expect(page.getByTestId('add-comment')).toContainText(/⇧⌘M|Ctrl\+Shift\+M/);

      const line = await page.locator('.cm-line').first().boundingBox();
      await page.mouse.dblclick(line!.x + 30, line!.y + line!.height / 2);
      await expect.poll(async () => await page.evaluate(() => window.getSelection()?.toString())).toBe('PLACEHOLDER');
      await page.keyboard.press(`${mod}+Shift+m`);
      await expect(page.getByTestId('comment-composer')).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('plugin panels share one More tab', async ({ page, request }) => {
    const id = await createProject(request, 'More Tab');
    try {
      await openProject(page, id);
      const more = page.getByTestId('tab-more');
      await expect(more).toBeVisible({ timeout: 15_000 });
      // a ⋯ until one of its panels is open
      await expect(more).toHaveAttribute('aria-label', 'More panels');
      await more.click();
      await expect(page.getByTestId('tab-more-menu')).toBeVisible();
      await page.getByTestId('tab-plugin:zotero').click();
      await expect(page.getByTestId('tab-more-menu')).toHaveCount(0);
      await expect(page.getByTestId('zotero-panel')).toBeVisible();
      // the tab names the panel it shows, in its label and tooltip
      await expect(more).toHaveAttribute('aria-label', 'More panels: Zotero');
      await expect(more).toHaveAttribute('aria-selected', 'true');
    } finally { await cleanup(request, id); }
  });
});

test.describe('preview header', () => {
  test('stays one row in a 1024 px window, like the editor header beside it', async ({ page, request }) => {
    const id = await createProject(request, 'Narrow Preview Header');
    try {
      // two-digit page count, the widest the header gets in practice
      const pages = Array.from({ length: 25 }, (_, i) => `\\section{Part ${i + 1}}\nWords on page ${i + 1}.\n\\newpage\n`).join('');
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: `\\documentclass{article}\n\\begin{document}\n${pages}\\end{document}\n` } })).ok()).toBeTruthy();
      await page.setViewportSize({ width: 1024, height: 700 });
      await openProject(page, id);
      const header = page.locator('.pane--preview > .pane__header');
      await expect(header).toBeVisible({ timeout: 15_000 });
      // typeset: the status then carries the time and the page count
      await expectTypesetOk(page);
      const m = await header.evaluate((el) => ({
        pane: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height),
        overflow: el.scrollWidth > el.clientWidth + 1,
        kids: [...el.children].map((c) => `${c.className || c.tagName}:${Math.round(c.getBoundingClientRect().width)}:${(c.textContent || '').trim().slice(0, 30)}`),
      }));
      console.log('preview header', JSON.stringify(m));
      expect(m.height, JSON.stringify(m)).toBeLessThanOrEqual(36);
      expect(m.overflow, JSON.stringify(m)).toBe(false);
    } finally {
      await cleanup(request, id);
    }
  });

  test('the palette cuts a long path in its folders and keeps the file name whole', async ({ page, request }) => {
    const id = await createProject(request, 'Palette Paths');
    try {
      const file = 'sections/introduction_and_motivation/a_really_quite_long_descriptive_folder/file_74_final.tex';
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: file, content: 'x\n' } })).ok()).toBeTruthy();
      await page.setViewportSize({ width: 1024, height: 700 });
      await openProject(page, id);
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('palette-input').fill('file_74');
      const row = page.getByTestId(`palette-item-open-${file}`);
      await expect(row).toBeVisible();
      const m = await row.evaluate((el) => {
        const base = el.querySelector('.palette__base')!;
        const dir = el.querySelector('.palette__dir')!;
        return { base: base.textContent, baseCut: base.scrollWidth > base.clientWidth, dirCut: dir.scrollWidth > dir.clientWidth };
      });
      expect(m).toEqual({ base: 'file_74_final.tex', baseCut: false, dirCut: true });
    } finally {
      await cleanup(request, id);
    }
  });

  test('the publish nudge comes once per browser, not on every new project', async ({ page, request }) => {
    const first = await createProject(request, 'Nudge One');
    const second = await createProject(request, 'Nudge Two');
    try {
      await openProject(page, first);
      await expect(page.getByTestId('remote-nudge-publish')).toBeVisible({ timeout: 15_000 });
      await openProject(page, second);
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('remote-nudge-publish')).toHaveCount(0);
    } finally {
      await cleanup(request, first);
      await cleanup(request, second);
    }
  });
});
