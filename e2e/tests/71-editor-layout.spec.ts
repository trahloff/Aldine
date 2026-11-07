import { test, expect } from '../fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { createProject, openProject, cleanup, phoneMore } from './helpers';

/**
 * Editor, both or PDF: the toolbar's layout toggle, the narrow window's
 * default, a phone's Editor/PDF switch and one-row toolbar, and the short
 * typeset status where the PDF is not on screen.
 */

const MAIN = '\\documentclass{article}\n\\begin{document}\nLayout text.\n\\end{document}\n';
/** Stops before a page: no PDF, one error. */
const BROKEN = '\\documentclass{nosuchclassatall}\n\\begin{document}\nLayout text.\n\\end{document}\n';
const PHONE = { width: 390, height: 844 };

async function seed(request: APIRequestContext, name: string, content = MAIN): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content } });
  return id;
}

const width = async (l: Locator) => (await l.boundingBox())!.width;
const palette = async (page: Page, q: string) => {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`);
  await page.getByTestId('palette-input').fill(q);
  await page.keyboard.press('Enter');
};

test.describe('layout on a desktop', () => {
  test.afterEach(async ({ page }) => { await page.evaluate(() => localStorage.removeItem('aldine.layout')).catch(() => {}); });

  test('the toggle shows the editor, both or the PDF, and the choice is remembered', async ({ page, request }) => {
    const id = await seed(request, 'Layout Toggle');
    try {
      await openProject(page, id);
      const editor = page.locator('.pane--editor');
      const preview = page.getByTestId('preview');
      await expect(page.getByTestId('layout-both')).toHaveAttribute('aria-pressed', 'true');
      await expect(preview).toBeVisible();
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });

      await page.getByTestId('layout-editor').click();
      await expect(preview).toBeHidden();
      await expect(page.getByTestId('pane-resizer')).toHaveCount(0);
      expect(await width(editor)).toBeGreaterThan(1000);
      // the typeset's state, where the preview is not
      const short = page.getByTestId('typeset-status-short');
      await expect(short).toContainText('Typeset in');

      await page.reload();
      await openProject(page, id);
      await expect(page.getByTestId('layout-editor')).toHaveAttribute('aria-pressed', 'true');
      await expect(preview).toBeHidden();

      // the short status shows the PDF for now; the choice stays the editor alone
      await expect(short).toContainText('Typeset in', { timeout: 120_000 });
      await short.click();
      await expect(preview).toBeVisible();
      await expect(page.getByTestId('layout-both')).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => localStorage.getItem('aldine.layout'))).toBe('editor');

      await palette(page, 'show the pdf only');
      await expect(editor).toBeHidden();
      await expect(preview).toBeVisible();
      expect(await width(preview)).toBeGreaterThan(1000);
      await expect(page.getByTestId('layout-pdf')).toHaveAttribute('aria-pressed', 'true');

      await page.getByTestId('layout-both').click();
      await expect(editor).toBeVisible();
      await expect(preview).toBeVisible();
      await expect(page.getByTestId('pane-resizer')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('a narrow window opens on the editor alone, and Jump to PDF shows both', async ({ page, request }) => {
    const id = await seed(request, 'Layout Narrow');
    try {
      await page.setViewportSize({ width: 760, height: 900 });
      await openProject(page, id);
      await expect(page.getByTestId('layout-editor')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('preview')).toBeHidden();
      await expect(page.getByTestId('typeset-status-short')).toContainText('Typeset in', { timeout: 120_000 });
      await page.locator('.cm-line', { hasText: 'Layout text' }).click();
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+j`);
      await expect(page.getByTestId('preview')).toBeVisible();
      await expect(page.getByTestId('layout-both')).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('the PDF alone says the typeset stopped on errors and shows them', async ({ page, request }) => {
    const id = await seed(request, 'Layout Errors', BROKEN);
    try {
      await openProject(page, id);
      await expect(page.getByTestId('errors-panel')).toBeVisible({ timeout: 120_000 });
      const empty = page.getByTestId('pdf-pane').locator('.pdf-empty');
      await expect(empty).toContainText('Fix the errors on the left');
      await page.getByTestId('layout-pdf').click();
      await expect(page.getByTestId('pdf-errors-hidden')).toHaveText('The typeset stopped on errors.');
      await expect(empty).not.toContainText('on the left');
      await page.getByTestId('pdf-show-errors').click();
      await expect(page.getByTestId('layout-both')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('errors-panel')).toBeVisible();
      await expect(empty).toContainText('Fix the errors on the left');
    } finally {
      await cleanup(request, id);
    }
  });

  test('a finished typeset whose PDF is still opening says so, not "Press ⌘S"', async ({ page, request }) => {
    const id = await seed(request, 'Pdf Opening');
    try {
      await page.route(/\/api\/projects\/[^/]+\/output\?.*\.pdf/, async (route) => {
        await new Promise((r) => setTimeout(r, 2500));
        await route.continue().catch(() => {});
      });
      await openProject(page, id);
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });
      const empty = page.getByTestId('pdf-pane').locator('.pdf-empty');
      await expect(empty).toContainText('Opening the PDF');
      await expect(empty).not.toContainText('Press');
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await cleanup(request, id);
    }
  });
});

const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

async function seedDocs(request: APIRequestContext, name: string): Promise<string> {
  const id = await seed(request, name, doc('The manuscript.'));
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'supplement.tex', content: doc('The supplement.') } });
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'chapter.tex', content: 'A chapter, input by the manuscript.\n' } });
  return id;
}

const rootFile = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/projects/${id}`)).json()).rootFile;

test.describe('main document picker', () => {
  test('beside Typeset, it lists the documents and typesets the one chosen', async ({ page, request }) => {
    const id = await seedDocs(request, 'Two Documents');
    try {
      await openProject(page, id);
      const preview = page.getByTestId('preview');
      await expect(preview).toHaveAttribute('data-pdf', /main\.pdf/, { timeout: 120_000 });
      const picker = page.getByTestId('main-doc-picker');
      await expect(picker).toHaveText('main.tex');
      await picker.click();
      const menu = page.getByTestId('main-doc-menu');
      await expect(menu.getByRole('menuitemradio')).toHaveText(['main.tex', 'supplement.tex']);
      await expect(page.getByTestId('main-doc-main.tex')).toHaveAttribute('aria-checked', 'true');
      await page.getByTestId('main-doc-supplement.tex').click();
      await expect(picker).toHaveText('supplement.tex');
      await expect(preview).toHaveAttribute('data-pdf', /supplement\.pdf/, { timeout: 120_000 });
      expect(await rootFile(request, id)).toBe('supplement.tex');

      // short of room, it is in the … sheet
      await page.setViewportSize({ width: 1000, height: 800 });
      await expect(picker).toBeHidden();
      await page.getByTestId('toolbar-more').click();
      await expect(page.getByTestId('more-main-supplement.tex')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('more-main-main.tex').click();
      await expect(preview).toHaveAttribute('data-pdf', /main\.pdf/, { timeout: 120_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('layout on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('one toolbar row; the rest is in the … sheet', async ({ page, request }) => {
    const id = await seed(request, 'Phone Toolbar');
    try {
      await openProject(page, id);
      const bar = page.locator('header.toolbar');
      expect((await bar.boundingBox())!.height).toBeLessThan(60);
      for (const t of ['project-name', 'branch-menu', 'typeset-button', 'toolbar-more']) await expect(page.getByTestId(t)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Back to projects' })).toBeVisible();
      for (const t of ['share-project', 'project-settings-open', 'add-comment', 'palette-open', 'pane-layout']) await expect(page.getByTestId(t)).toBeHidden();
      const typeset = (await page.getByTestId('typeset-button').boundingBox())!;
      expect(typeset.x + typeset.width).toBeLessThanOrEqual(PHONE.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.getByTestId('toolbar-more').tap();
      const sheet = page.getByTestId('toolbar-more-sheet');
      for (const t of ['more-palette', 'sidebar-toggle', 'more-show-pdf', 'more-comment', 'more-share', 'more-settings']) await expect(sheet.getByTestId(t)).toBeVisible();
      await sheet.getByTestId('more-settings').tap();
      await expect(page.getByTestId('project-settings')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('the PDF says the typeset stopped on errors, and Show the errors goes to the editor', async ({ page, request }) => {
    const id = await seed(request, 'Phone Errors', BROKEN);
    try {
      await openProject(page, id);
      await expect(page.getByTestId('typeset-status-short')).toContainText('error', { timeout: 120_000 });
      await page.getByTestId('phone-show-pdf').tap();
      await expect(page.getByTestId('pdf-errors-hidden')).toHaveText('The typeset stopped on errors.');
      await page.getByTestId('pdf-show-errors').tap();
      await expect(page.locator('.pane--editor')).toBeVisible();
      await expect(page.getByTestId('errors-panel')).toBeVisible();
      await expect(page.getByTestId('phone-show-editor')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the main document is chosen in the … sheet, and typesets', async ({ page, request }) => {
    const id = await seedDocs(request, 'Phone Documents');
    try {
      await openProject(page, id);
      await expect(page.getByTestId('main-doc-picker')).toBeHidden();
      await page.getByTestId('toolbar-more').tap();
      const sheet = page.getByTestId('toolbar-more-sheet');
      await expect(sheet.getByTestId('more-main-main.tex')).toHaveAttribute('aria-pressed', 'true');
      await expect(sheet.getByTestId('more-main-chapter.tex')).toHaveCount(0);
      await sheet.getByTestId('more-main-supplement.tex').tap();
      await expect(page.getByTestId('preview')).toHaveAttribute('data-pdf', /supplement\.pdf/, { timeout: 120_000 });
      expect(await rootFile(request, id)).toBe('supplement.tex');
    } finally {
      await cleanup(request, id);
    }
  });

  test('Editor and PDF switch in the pane\'s header, with the typeset\'s state beside the code', async ({ page, request }) => {
    const id = await seed(request, 'Phone Switch');
    try {
      await openProject(page, id);
      const editor = page.locator('.pane--editor');
      const preview = page.getByTestId('preview');
      await expect(preview).toBeHidden();
      await expect(page.getByTestId('typeset-status-short')).toContainText('Typeset in', { timeout: 120_000 });

      await page.getByTestId('phone-show-pdf').tap();
      await expect(preview).toBeVisible();
      await expect(editor).toBeHidden();
      expect(await width(preview)).toBeGreaterThanOrEqual(PHONE.width - 2);
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 20_000 });

      await page.getByTestId('phone-show-editor').tap();
      await expect(editor).toBeVisible();
      await expect(preview).toBeHidden();

      // for this visit only: a phone opens on the editor
      await page.getByTestId('phone-show-pdf').tap();
      await page.reload();
      await openProject(page, id);
      await expect(preview).toBeHidden();
      await expect(editor).toBeVisible();

      // a file opened from the tree while the PDF shows brings the editor back
      await page.getByTestId('phone-show-pdf').tap();
      await phoneMore(page, 'sidebar-toggle', 'tap');
      await page.getByTestId('file-main.tex').tap();
      await expect(editor).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });
});
