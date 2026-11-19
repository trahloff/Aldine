import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

/** A wrapped indented line continues under its indentation (#332). */

const LONG = 'This is a longer paragraph that keeps going well past the width of the editor pane so that it has to wrap onto further rows, and then it keeps going some more to be sure of that.';
const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\begin{itemize}',
  `    \\item ${LONG}`,
  '  \\begin{itemize}',
  `\t\\item Nested ${LONG}`,
  '  \\end{itemize}',
  '\\end{itemize}',
  '\\end{document}',
  '',
].join('\n');

/** Left edge of each visual row of the line's text after its leading whitespace. */
async function rowStarts(page: Page, needle: string): Promise<number[]> {
  return page.evaluate((needle) => {
    const line = [...document.querySelectorAll('.cm-content .cm-line')].find((l) => l.textContent!.includes(needle))!;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let started = false;
    let last: Text | null = null;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      last = n;
      if (started) continue;
      const i = n.data.search(/\S/);
      if (i >= 0) { range.setStart(n, i); started = true; }
    }
    range.setEnd(last!, last!.data.length);
    const rows = new Map<number, number>();
    for (const r of range.getClientRects()) {
      if (!r.width) continue;
      const top = Math.round(r.top);
      rows.set(top, Math.min(rows.get(top) ?? Infinity, r.left));
    }
    return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, left]) => left);
  }, needle);
}

test('wrapped rows of an indented line start under its indentation', async ({ page, request }) => {
  const id = await createProject(request, 'Wrap Indent');
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
  try {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openProject(page, id);
    await expect(page.locator('.cm-content')).toContainText('Nested This is a longer');
    const unindented = await page.evaluate(() => {
      const l = [...document.querySelectorAll('.cm-content .cm-line')].find((x) => x.textContent === '\\begin{itemize}')!;
      const r = document.createRange();
      r.selectNodeContents(l);
      return r.getClientRects()[0].left;
    });

    for (const needle of ['    \\item This is', '\\item Nested']) {
      const rows = await rowStarts(page, needle);
      expect(rows.length, needle).toBeGreaterThan(1);
      expect(rows[0], needle).toBeGreaterThan(unindented + 10);
      for (const left of rows.slice(1)) expect(Math.abs(left - rows[0]), needle).toBeLessThan(1.5);
    }

    // presentation only: the source keeps its whitespace
    const lines = await page.locator('.cm-content .cm-line').allTextContents();
    expect(lines).toContain(`    \\item ${LONG}`);
    expect(lines).toContain(`\t\\item Nested ${LONG}`);
  } finally {
    await cleanup(request, id);
  }
});
