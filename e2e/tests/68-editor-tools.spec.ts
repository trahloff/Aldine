import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

/**
 * The editor's everyday tools: Mod+Enter, spellcheck, the outline, the
 * completions, in-file Find from anywhere, and the dialogs' default button.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const stored = async (request: APIRequestContext, id: string, path = 'main.tex') =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();

const line = (page: Page, text: string) => page.locator('.cm-line', { hasText: text });
const list = (page: Page) => page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)');

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Intro}',
  'First alpha paragraph with \\textbf{bold} words.',
  '\\subsection{Detail}',
  'Second alpha paragraph.',
  '\\section{Results}',
  'Third alpha paragraph.',
  '\\end{document}',
  '',
].join('\n');

async function seed(request: APIRequestContext, name: string, extra: Record<string, string> = {}): Promise<string> {
  const id = await createProject(request, name);
  for (const [path, content] of Object.entries({ 'main.tex': DOC, ...extra })) {
    await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
  }
  return id;
}

test.describe('editor tools', () => {
  test('Mod+Enter typesets, from the text too, without writing a blank line', async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('aldine.autoTypeset', '0'));
    const id = await seed(request, 'Mod Enter');
    try {
      await openProject(page, id);
      await line(page, 'Third alpha').click();
      await page.keyboard.press(`${mod}+Enter`);
      await expect(page.getByTestId('pdf-status')).toContainText(/Typeset in|error|Failed/, { timeout: 120_000 });
      await expect(line(page, 'Third alpha')).toHaveCount(1);
      expect(await page.locator('.cm-line').count()).toBe(DOC.split('\n').length);
      expect(await stored(request, id)).toBe(DOC);
      await expect(page.getByTestId('typeset-button')).toHaveAttribute('title', /Typeset \((⌘S or ⌘↩|Ctrl\+S or Ctrl\+Enter)\)/);
      await page.getByTestId('project-settings-open').click();
      await expect(page.getByTestId('shortcut-hint-typeset')).toHaveText(/(⌘↩|Ctrl\+Enter) typesets too/);
    } finally {
      await cleanup(request, id);
    }
  });

  test('spellcheck is on for .tex, skips commands, and takes a language from Settings', async ({ page, request }) => {
    const id = await seed(request, 'Spellcheck');
    try {
      await openProject(page, id);
      const content = page.locator('.cm-content');
      await expect(content).toHaveAttribute('spellcheck', 'true');
      await expect(content).not.toHaveAttribute('lang', /./);
      await expect(page.locator('.cm-content [spellcheck="false"]', { hasText: '\\textbf' })).toHaveCount(1);
      await expect(page.locator('.cm-content [spellcheck="false"]', { hasText: 'paragraph' })).toHaveCount(0);

      await page.getByTestId('project-settings-open').click();
      await expect(page.getByTestId('settings-spellcheck')).toBeChecked();
      await page.getByTestId('settings-spell-lang').selectOption('de-DE');
      await expect(content).toHaveAttribute('lang', 'de-DE');
      await page.getByTestId('settings-spellcheck').uncheck();
      await expect(content).toHaveAttribute('spellcheck', 'false');
      await expect(page.getByTestId('settings-spell-lang')).toBeDisabled();
      await page.getByTestId('settings-close').click();

      await page.reload();
      await openProject(page, id);
      await expect(content).toHaveAttribute('spellcheck', 'false');
      await page.getByTestId('project-settings-open').click();
      await page.getByTestId('settings-spellcheck').check();
      await expect(content).toHaveAttribute('spellcheck', 'true');
      await expect(content).toHaveAttribute('lang', 'de-DE');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the outline lists the headings, marks the caret\'s, jumps, and stays in Visual', async ({ page, request }) => {
    const id = await seed(request, 'Outline');
    try {
      await openProject(page, id);
      const items = page.getByTestId('outline-item');
      await expect(items).toHaveText(['Intro', 'Detail', 'Results']);
      await expect(items.nth(1)).toHaveAttribute('data-level', '2');

      await line(page, 'Third alpha').click();
      await expect(items.nth(2)).toHaveAttribute('aria-current', 'location');
      await items.nth(0).click();
      await expect(items.nth(0)).toHaveAttribute('aria-current', 'location');
      await expect(page.locator('.cm-activeLine')).toContainText('Intro');

      // a heading typed in shows up
      await line(page, 'Second alpha').click();
      await page.keyboard.press('End');
      await page.keyboard.type('\n\\section{Added}');
      await expect(items).toHaveText(['Intro', 'Detail', 'Added', 'Results']);
      await expect(items.nth(2)).toHaveAttribute('aria-current', 'location');

      await page.getByTestId('mode-visual').click();
      await expect(items).toHaveText(['Intro', 'Detail', 'Added', 'Results']);
      await items.nth(3).click();
      await expect(items.nth(3)).toHaveAttribute('aria-current', 'location');

      await page.getByTestId('outline-toggle').click();
      await expect(items).toHaveCount(0);
      await page.reload();
      await openProject(page, id);
      await expect(page.getByTestId('outline-toggle')).toHaveAttribute('aria-expanded', 'false');
      await page.getByTestId('outline-toggle').click();
      await expect(items).toHaveCount(4);
    } finally {
      await page.evaluate(() => { localStorage.removeItem('aldine.outlineOpen'); localStorage.removeItem('aldine.editorMode'); }).catch(() => {});
      await cleanup(request, id);
    }
  });

  test('completes \\footnote and \\cdot, the project\'s files, and the paper\'s own macros', async ({ page, request }) => {
    const id = await seed(request, 'Completions', {
      'macros.tex': '\\newcommand{\\Rset}{\\mathbb{R}}\n\\def\\half#1{\\frac{#1}{2}}\n',
      'chapters/one.tex': 'Chapter one.\n',
    });
    // Tab falls through to indenting for CodeMirror's interactionDelay (75 ms) after the list opens
    const accept = async () => { await page.waitForTimeout(150); await page.keyboard.press('Tab'); };
    try {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'figures/plot.png', content: png, encoding: 'base64' } })).ok()).toBeTruthy();
      await openProject(page, id);
      await line(page, 'Third alpha').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' \\footn');
      await expect(list(page).locator('li[aria-selected] .cm-completionLabel')).toHaveText('\\footnote');
      await accept();
      await expect(line(page, 'Third alpha')).toHaveText('Third alpha paragraph. \\footnote{}');
      await page.keyboard.press('End');
      await page.keyboard.type(' $a\\cdo');
      await expect(list(page).locator('.cm-completionLabel', { hasText: /^\\cdot$/ })).toHaveCount(1);
      await page.keyboard.press('Escape');

      // a file name, offered as soon as the braces are in
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('\\includegr');
      await expect(list(page).locator('li[aria-selected] .cm-completionLabel')).toHaveText('\\includegraphics');
      await accept();
      await expect(list(page)).toContainText('figures/plot.png');
      await accept();
      await expect(page.locator('.cm-activeLine')).toHaveText('\\includegraphics{figures/plot.png}');
      await page.keyboard.press('Enter');
      await page.keyboard.type('\\input{ch');
      await expect(list(page)).toContainText('chapters/one.tex');
      await page.keyboard.press('Escape');

      // a macro another file defines, with where it comes from
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('\\Rse');
      const option = list(page).locator('li', { hasText: '\\Rset' });
      await expect(option).toContainText('macros.tex');
      await page.keyboard.press('Escape');
      await page.keyboard.type('x \\hal');
      await expect(list(page).locator('li', { hasText: '\\half' })).toHaveCount(1);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Find counts its matches, says No matches, and reports Replace all', async ({ page, request }) => {
    const id = await seed(request, 'Find Count');
    try {
      await openProject(page, id);
      await line(page, '\\documentclass').click();
      await page.keyboard.press(`${mod}+f`);
      const panel = page.locator('.cm-panels-top .cm-search');
      const status = panel.getByTestId('find-status');
      await page.keyboard.type('alpha');
      await expect(status).toHaveText('3 matches');
      await page.keyboard.press('Enter');
      await expect(status).toHaveText('1 of 3');
      await page.keyboard.press('Enter');
      await expect(status).toHaveText('2 of 3');
      // the panel takes a query as it is typed
      const retype = async (name: string, text: string) => {
        await panel.locator(`input[name=${name}]`).click();
        await page.keyboard.press(`${mod}+a`);
        await page.keyboard.type(text);
      };
      await retype('search', 'omega');
      await expect(status).toHaveText('No matches');
      await expect(status).toHaveClass(/cm-search-status--none/);
      await retype('search', 'alpha');
      await expect(status).toHaveText('2 of 3');
      await retype('replace', 'beta');
      await panel.getByRole('button', { name: 'Replace all' }).click();
      await expect(status).toHaveText('Replaced 3 matches');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toBe(DOC.replaceAll('alpha', 'beta'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('Mod+F opens the editor\'s Find from the file tree, the PDF\'s over the PDF, and neither over a field', async ({ page, request }) => {
    const id = await seed(request, 'Find Anywhere', { 'other.tex': 'Other alpha.\n' });
    try {
      await openProject(page, id);
      const panel = page.locator('.cm-panels-top .cm-search');
      const field = panel.locator('input[name=search]');
      await page.getByTestId('file-other.tex').click();
      await expect(page.getByTestId('active-file')).toHaveText('other.tex');
      await expect(page.getByTestId('file-other.tex')).toBeFocused();
      await page.keyboard.press(`${mod}+f`);
      await expect(field).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);

      // over the PDF it is the PDF's own Find
      await page.getByTestId('pdf-pane').focus();
      await page.keyboard.press(`${mod}+f`);
      await expect(page.getByTestId('pdf-find-input')).toBeFocused();
      await expect(panel).toHaveCount(0);
      await page.keyboard.press('Escape');

      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').focus();
      await page.keyboard.press(`${mod}+f`);
      await expect(panel).toHaveCount(0);
      await expect(page.getByTestId('search-input')).toBeFocused();
    } finally {
      await cleanup(request, id);
    }
  });

  test('Find, Replace and Go to line are in the palette, and Find is a button on the pane', async ({ page, request }) => {
    const id = await seed(request, 'Find Palette');
    try {
      await openProject(page, id);
      const panel = page.locator('.cm-panels-top .cm-search');
      const palette = async (q: string) => {
        await page.keyboard.press(`${mod}+k`);
        await page.getByTestId('palette-input').fill(q);
        await page.keyboard.press('Enter');
      };
      await line(page, 'Second alpha').click();
      await palette('find in this file');
      await expect(panel.locator('input[name=search]')).toBeFocused();
      await page.keyboard.press('Escape');
      await palette('replace in this file');
      await expect(panel.locator('input[name=replace]')).toBeFocused();
      await page.keyboard.press('Escape');
      await palette('go to line');
      const dialog = page.locator('.cm-panels-top .cm-dialog');
      await expect(dialog).toContainText('Go to line');
      await expect(dialog.locator('input[name=line]')).toBeFocused();
      await page.keyboard.press('Escape');

      await page.getByTestId('find-open').click();
      await expect(panel.locator('input[name=search]')).toBeFocused();
    } finally {
      await cleanup(request, id);
    }
  });

  test('a confirm puts Enter on its blue button; a red one keeps it on the way out', async ({ page, request }) => {
    const id = await seed(request, 'Dialog Focus');
    try {
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft', from: 'main' } })).ok()).toBeTruthy();
      expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'draft', path: 'draft.tex', content: 'Draft.\n' } })).ok()).toBeTruthy();
      expect((await (await request.post(`/api/projects/${id}/commit`, { data: { branch: 'draft', message: 'Draft' } })).json()).committed).toBe(true);
      await openProject(page, id);
      // merging a branch into main asks first, with the blue button focused
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('merge-draft').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Merge draft into main?');
      await expect(page.getByTestId('dialog-confirm')).toBeFocused();
      await expect(page.getByTestId('dialog-confirm')).toHaveClass(/btn--primary/);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-dialog')).toHaveCount(0);

      // uploading over a file replaces what may be typed in it: red, and Keep existing has the focus
      await page.getByTestId('upload-input').setInputFiles({ name: 'main.tex', mimeType: 'text/plain', buffer: Buffer.from('Replaced.\n') });
      await expect(page.getByTestId('dialog-title')).toHaveText('Replace main.tex?');
      await expect(page.getByTestId('dialog-confirm')).toHaveClass(/btn--danger/);
      await expect(page.getByTestId('dialog-cancel')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('app-dialog')).toHaveCount(0);

      // project-wide Replace all cannot be taken back by typing: red, and Cancel has the focus
      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').fill('alpha');
      await page.getByTestId('search-replace-input').fill('beta');
      await expect(page.getByTestId('search-summary')).toContainText('3');
      await page.getByTestId('search-replace-all').click();
      await expect(page.getByTestId('dialog-confirm')).toHaveClass(/btn--danger/);
      await expect(page.getByTestId('dialog-cancel')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('app-dialog')).toHaveCount(0);
      expect(await stored(request, id)).toBe(DOC);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Escape puts the toolbar name back; the name and Auto say what they are', async ({ page, request }) => {
    const id = await seed(request, 'Name Escape');
    try {
      await openProject(page, id);
      const name = page.getByRole('textbox', { name: 'Project name' });
      await expect(name).toHaveText('Name Escape');
      await name.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' draft');
      await expect(name).toHaveText('Name Escape draft');
      await page.keyboard.press('Escape');
      await expect(name).toHaveText('Name Escape');
      await expect(name).not.toBeFocused();
      await page.waitForTimeout(300);
      expect((await (await request.get(`/api/projects/${id}`)).json()).name).toBe('Name Escape');

      const autoToggle = page.getByTestId('auto-toggle');
      await expect(autoToggle).toHaveAttribute('aria-pressed', 'true');
      await autoToggle.click();
      await expect(autoToggle).toHaveAttribute('aria-pressed', 'false');
      await autoToggle.click();
    } finally {
      await cleanup(request, id);
    }
  });
});
