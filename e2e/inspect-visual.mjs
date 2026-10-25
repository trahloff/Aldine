// Manual QA driver: seeds a document exercising every visual-editor feature
// and captures screenshots of each state for human (or agent) inspection.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = process.env.OUT || '/tmp/visual-qa';
const BASE = process.env.ALDINE_URL || 'http://localhost:5173';
fs.mkdirSync(OUT, { recursive: true });

const DOC = [
  '\\section{Typography and Convergence}',
  'Aldine renders \\textbf{bold}, \\emph{italic}, and \\underline{underlined} prose',
  'while equations like $e^{i\\pi} + 1 = 0$ stay live. See \\cite{knuth1984texbook}.',
  '',
  '\\subsection{A list and a table}',
  '\\begin{itemize}',
  '\\item First, the visual layer never rewrites source',
  '\\item Second, every widget is an exact-range edit',
  '\\end{itemize}',
  '',
  '\\begin{tabular}{lll}',
  'Editor & License & Byte-stable \\\\',
  'Aldine & AGPL & yes \\\\',
  'Overleaf & AGPL & no \\\\',
  '\\end{tabular}',
  '',
  '\\subsection{Display math and figures}',
  '\\[ \\int_0^1 x^2 \\, dx = \\tfrac{1}{3} \\]',
  '\\begin{figure}',
  '\\includegraphics{plot.png}',
  '\\caption{A real image preview}',
  '\\end{figure}',
  '',
  'Closing prose to park the caret in.',
  '',
].join('\n');

const BIB = '@book{knuth1984texbook,\n  author = {Knuth, Donald E.},\n  title = {The {\\TeX}book},\n  year = {1984},\n  publisher = {Addison-Wesley}\n}\n';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, colorScheme: 'dark' });
await ctx.addInitScript(() => {
  localStorage.setItem('aldine.onboarded', '1');
  localStorage.setItem('aldine.theme', 'dark');
  localStorage.setItem('aldine.editorMode', 'visual');
});

const res = await ctx.request.post(`${BASE}/api/projects`, { data: { name: 'Visual QA' } });
const { id } = await res.json();
await ctx.request.put(`${BASE}/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
await ctx.request.put(`${BASE}/api/projects/${id}/file`, { data: { branch: 'main', path: 'references.bib', content: BIB } });
// a real image for the figure preview
const png = fs.readFileSync(new URL('./shots/branches-light.png', import.meta.url));
await ctx.request.put(`${BASE}/api/projects/${id}/file`, {
  data: { branch: 'main', path: 'plot.png', content: png.toString('base64'), encoding: 'base64' },
});
// a review suggestion for the tracked-change rendering
await ctx.request.post(`${BASE}/api/projects/${id}/comments`, {
  data: {
    branch: 'main', file: 'main.tex',
    anchor: { from: DOC.indexOf('Closing prose'), to: DOC.indexOf('Closing prose') + 'Closing prose'.length, quote: 'Closing prose' },
    body: 'suggestion demo', suggestion: 'Final thoughts', author: 'Reviewer',
  },
});

const page = await ctx.newPage();
await page.goto(`${BASE}/p/${id}`);
await page.waitForSelector('.cm-content');
await page.locator('.cm-line', { hasText: 'park the caret' }).click();
await page.waitForTimeout(1500); // katex/bib/image settle
await page.screenshot({ path: `${OUT}/1-overview.png` });

// MathLive popover on the inline equation
await page.getByTestId('vis-math').first().click();
await page.waitForSelector('[data-testid="math-popover"]');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/2-mathlive.png` });
await page.keyboard.press('Escape');

// table cell editing
await page.getByTestId('vis-table').locator('td', { hasText: 'AGPL' }).first().dispatchEvent('mousedown');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/3-table-edit.png` });
await page.keyboard.press('Escape');

// cursor-reveal on bold
await page.locator('.cm-vis-b').first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/4-reveal.png` });

// source mode for contrast
await page.getByTestId('mode-source').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/5-source.png` });

await ctx.request.delete(`${BASE}/api/projects/${id}`);
await browser.close();
console.log('shots in', OUT);
