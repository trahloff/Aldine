import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

/** Waits out the collab store debounce. */
const expectStored = (request: APIRequestContext, id: string, expected: string) =>
  expect.poll(() => stored(request, id), { timeout: 20_000 }).toBe(expected);

const line = (page: Page, text: string) => page.locator('.cm-line', { hasText: text });
const list = (page: Page) => page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)');

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\noindent See',
  '\\begin{tabular}{cc}',
  'Row',
  '\\end{tabular}',
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

async function openSource(page: Page, id: string) {
  await openProject(page, id);
  await expect(page.getByTestId('mode-source')).toHaveAttribute('aria-pressed', 'true');
}

test.describe('typing LaTeX', () => {
  test('\\\\ and Enter ends a table row, and closing quotes stay single', async ({ page, request }) => {
    const id = await seed(request, 'Row Break');
    try {
      await openSource(page, id);
      await line(page, 'Row').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' a & b \\\\');
      // longer than CodeMirror's activateOnTypingDelay: a list reopened from the second \ would be live by now
      await page.waitForTimeout(400);
      await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
      await page.keyboard.press('Enter');
      await page.keyboard.type("``quoted'' and $f''(x)$");
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toMatch(/Row a & b \\\\\n\s*``quoted'' and \$f''\(x\)\$\n\\end\{tabular\}/);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Tab takes the highlighted completion, which brings its braces', async ({ page, request }) => {
    const id = await seed(request, 'Tab Completion');
    try {
      await openSource(page, id);
      await line(page, 'Row').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' \\textb');
      await expect(list(page).locator('li[aria-selected] .cm-completionLabel')).toHaveText('\\textbf');
      // Tab falls through to indenting for CodeMirror's interactionDelay (75 ms) after the list opens
      await page.waitForTimeout(150);
      await page.keyboard.press('Tab');
      await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
      await page.keyboard.type('bold');
      await expectStored(request, id, DOC.replace('Row\n', 'Row \\textbf{bold}\n'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('Mod-I makes the selection italic', async ({ page, request }) => {
    const id = await seed(request, 'Italic Shortcut');
    try {
      await openSource(page, id);
      await line(page, 'See').click();
      await page.keyboard.press('End');
      for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press(`${mod}+i`);
      await expectStored(request, id, DOC.replace('\\noindent See', '\\noindent \\textit{See}'));
      // the selection stays on the word, inside the new \textit: a second press unwraps it
      await page.keyboard.press(`${mod}+i`);
      await expectStored(request, id, DOC);
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('in-file Find', () => {
  test('finds \\noindent and replaces it with \\textit as typed', async ({ page, request }) => {
    const id = await seed(request, 'Find Literal');
    try {
      await openSource(page, id);
      await line(page, 'Row').click();
      await page.keyboard.press(`${mod}+f`);
      const panel = page.locator('.cm-panels-top .cm-search');
      const field = panel.locator('input[name=search]');
      await expect(field).toBeFocused();
      // every keystroke commits a new query: literal has to survive all of them
      await page.keyboard.type('\\noindent');
      await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
      await expect(page.locator('.cm-searchMatch')).toHaveText('\\noindent');
      await panel.locator('input[name=replace]').click();
      await page.keyboard.type('\\textit');
      await panel.getByRole('button', { name: 'Replace all' }).click();
      await expectStored(request, id, DOC.replace('\\noindent', '\\textit'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('reads in the dark theme, in sentence case, and keeps its query for the next file', async ({ page, request }) => {
    const id = await seed(request, 'Find Look', { 'chapter.tex': 'Chapter text with \\noindent too.\n' });
    try {
      await openSource(page, id);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await line(page, 'Row').click();
      await page.keyboard.press(`${mod}+f`);
      const panel = page.locator('.cm-panels-top .cm-search');
      const field = panel.locator('input[name=search]');
      await page.keyboard.type('\\noindent');
      const look = await field.evaluate((el) => {
        const s = getComputedStyle(el), body = getComputedStyle(document.body);
        return { background: s.backgroundColor, color: s.color, bodyColor: body.color, fontSize: parseFloat(s.fontSize) };
      });
      expect(look.background).not.toBe('rgb(255, 255, 255)');
      expect(look.color).toBe(look.bodyColor);
      expect(look.fontSize).toBeGreaterThanOrEqual(13);
      for (const label of ['Match case', 'Regular expression', 'Whole word']) await expect(panel.getByText(label, { exact: true })).toBeVisible();
      for (const name of ['Next', 'Previous', 'Select all matches', 'Replace', 'Replace all']) await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
      await expect(panel.locator('input[name=replace]')).toHaveAttribute('placeholder', 'Replace with');

      await panel.getByText('Match case', { exact: true }).click();
      await page.getByTestId('file-chapter.tex').click();
      await expect(page.locator('.cm-content')).toContainText('Chapter text');
      await line(page, 'Chapter text').click();
      await page.keyboard.press(`${mod}+f`);
      await expect(field).toHaveValue('\\noindent');
      await expect(panel.locator('input[name=case]')).toBeChecked();
      await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
    } finally {
      await cleanup(request, id);
    }
  });
});
