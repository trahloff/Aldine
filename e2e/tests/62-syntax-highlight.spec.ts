import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Plain words \\cite{knuth} and \\citep{lamport} \\item \\hline \\centering \\caption{c} \\textbf{bold} \\mycmd',
  '\\end{document}',
  '',
].join('\n');

/** The computed color of the first text run containing `text` on the test line. */
async function colorOf(page: Page, text: string): Promise<string> {
  return page.locator('.cm-line', { hasText: 'Plain words' }).evaluate((line, text) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent!.includes(text)) return getComputedStyle(n.parentElement!).color;
    }
    throw new Error(`${text} not found`);
  }, text);
}

for (const theme of ['dark', 'light'] as const) {
  test(`every command is colored in the ${theme} theme`, async ({ page, request }) => {
    await page.addInitScript((t) => localStorage.setItem('aldine.theme', t), theme);
    const id = await createProject(request, `Highlight ${theme}`);
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expect(page.getByTestId('mode-source')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.cm-line', { hasText: 'Plain words' })).toBeVisible();

      const plain = await colorOf(page, 'Plain words');
      const custom = await colorOf(page, '\\mycmd');
      expect(custom).not.toBe(plain);
      for (const cmd of ['\\item', '\\hline', '\\centering', '\\caption', '\\textbf']) {
        expect(await colorOf(page, cmd), cmd).toBe(custom);
      }
      const cite = await colorOf(page, '\\cite');
      expect(cite).not.toBe(plain);
      expect(await colorOf(page, '\\citep')).toBe(cite);
    } finally {
      await cleanup(request, id);
    }
  });
}
