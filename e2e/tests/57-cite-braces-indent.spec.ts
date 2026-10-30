import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

/** Waits out the collab store debounce. */
const expectStored = (request: APIRequestContext, id: string, expected: string) =>
  expect.poll(() => stored(request, id), { timeout: 20_000 }).toBe(expected);

const line = (page: Page, text: string) => page.locator('.cm-line', { hasText: text });
const list = (page: Page) => page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)');

const DOC = '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nSee\n\\end{document}\n';
const BIB = '@article{smith2020,\n  author = {Smith, Jane},\n  title = {A Notable Paper},\n  year = {2020},\n}\n'
  + '@book{knuth1984,\n  author = {Knuth, Donald},\n  title = {The TeXbook},\n  year = {1984},\n}\n';

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'references.bib', content: BIB } });
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}

test.describe('cite braces and Enter indentation', () => {
  test('accepting \\cite from the list inserts its braces and lists the bib keys (#223)', async ({ page, request }) => {
    const id = await seed(request, 'Cite Braces');
    try {
      await openProject(page, id);
      await expect(page.getByTestId('mode-source')).toHaveAttribute('aria-pressed', 'true');
      await line(page, 'See').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' \\ci');
      await expect(list(page).locator('li[aria-selected] .cm-completionLabel')).toHaveText('\\cite');
      // Enter falls through to a newline for CodeMirror's interactionDelay (75 ms) after the list opens
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      await expect(line(page, 'See')).toHaveText('See \\cite{}');
      await expect(list(page)).toContainText('smith2020', { timeout: 10_000 });
      await expect(list(page)).toContainText('knuth1984');
      // a { typed out of habit changes nothing, and typing goes between the braces
      await page.keyboard.type('{');
      await expect(line(page, 'See')).toHaveText('See \\cite{}');
      await page.keyboard.type('knu');
      await expect(line(page, 'See')).toHaveText('See \\cite{knu}');
      await expect(list(page).locator('li[aria-selected]')).toContainText('knuth1984');
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      // the accepted key hops over the closing brace
      await page.keyboard.type(' shows it.');
      await expectStored(request, id, DOC.replace('See\n', 'See \\cite{knuth1984} shows it.\n'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('Enter after a closing brace keeps the line\'s column in the document body (#222)', async ({ page, request }) => {
    const id = await seed(request, 'Brace Enter');
    try {
      await openProject(page, id);
      await expect(page.getByTestId('mode-source')).toHaveAttribute('aria-pressed', 'true');
      await line(page, '\\section{Intro}').click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Body');
      // an unclosed brace still indents, and its closing line goes back to column 0
      await line(page, 'See').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' \\footnote{');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Note');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('After');
      await expectStored(request, id, DOC
        .replace('\\section{Intro}\n', '\\section{Intro}\nBody\n')
        .replace('See\n', 'See \\footnote{\n  Note\n}\nAfter\n'));
    } finally {
      await cleanup(request, id);
    }
  });
});
