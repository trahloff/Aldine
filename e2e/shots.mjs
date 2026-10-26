import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = new URL('./shots/', import.meta.url).pathname;
const BASE = process.env.ALDINE_URL || 'http://localhost:5173';
const browser = await chromium.launch();

// The rest of the Home shelf: one-file projects, typeset once so each shows its first page.
// Home lists every project on the server, so point this at a stack with an empty data dir.
const SHELF_DIR = new URL('./fixtures/home-shelf/', import.meta.url).pathname;
const SHELF = [
  ['abstract', 'Soil moisture abstract'],
  ['reading-notes', 'Reading group notes'],
  ['problem-set', 'Problem set 4'],
  ['workshop-paper', 'Undo without coordination'],
  ['letter', 'Cover letter for the revision'],
  ['proposal', 'Tidal flat sensors proposal'],
  ['slides', 'Group meeting, week 43'],
  ['lecture-notes', 'Linear Algebra II notes'],
  ['thesis', 'Doctoral thesis'],
];
const boot = await browser.newContext();
const shelf = [];
for (const [dir, name] of SHELF) {
  const res = await boot.request.post(`${BASE}/api/projects`, { data: { name } });
  const { id } = await res.json();
  await boot.request.put(`${BASE}/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: fs.readFileSync(SHELF_DIR + dir + '/main.tex', 'utf8') } });
  await boot.request.post(`${BASE}/api/projects/${id}/compile`, { data: { branch: 'main' }, timeout: 180000 });
  shelf.push(id);
}

const shoot = async (ctx, name, fn) => {
  const page = await ctx.newPage();
  await fn(page);
  await page.screenshot({ path: OUT + name + '.png', fullPage: false });
  await page.close();
  console.log('shot:', name);
};

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  await ctx.addInitScript((t) => {
    window.localStorage.setItem('aldine.theme', t);
  }, scheme);

  // seed a paper project from the in-repo demo fixture
  const PAPER = new URL('./fixtures/demo-paper/', import.meta.url).pathname;
  const res = await ctx.request.post(`${BASE}/api/projects`, { data: { name: 'Convergence of Replicated Documents' } });
  const { id } = await res.json();
  for (const f of fs.readdirSync(PAPER)) {
    const content = fs.readFileSync(PAPER + f, 'utf8');
    await ctx.request.put(`${BASE}/api/projects/${id}/file`, { data: { branch: 'main', path: f, content } });
  }
  // keep the publish-to-a-git-host nudge out of the shots
  await ctx.addInitScript((pid) => window.localStorage.setItem(`aldine.remoteNudged.${pid}`, '1'), id);

  await shoot(ctx, `editor-${scheme}`, async (p) => {
    await p.goto(`${BASE}/p/${id}`);
    await p.waitForSelector('.cm-content');
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 }).catch(() => {});
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.waitForTimeout(600);
  });
  await shoot(ctx, `home-${scheme}`, async (p) => {
    await p.goto(`${BASE}/`);
    await p.getByTestId('wordmark').first().waitFor();
    await p.waitForFunction((n) => {
      const imgs = [...document.querySelectorAll('img')];
      return imgs.length >= n && imgs.every((i) => i.complete && i.naturalWidth > 0);
    }, SHELF.length + 1, { timeout: 30000 });
    await p.waitForTimeout(600);
  });
  await shoot(ctx, `visual-${scheme}`, async (p) => {
    // load straight into visual mode
    await p.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
    await p.goto(`${BASE}/p/${id}`);
    await p.waitForSelector('.cm-content');
    await p.waitForSelector('.katex', { timeout: 30000 });
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 }).catch(() => {});
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    // jump to §2 so the shot shows rendered headings + display math, not the preamble
    await p.getByTestId('outline-dropdown').focus();
    await p.getByTestId('outline-dropdown').selectOption({ label: 'Convergence' }).catch(() => {});
    await p.waitForTimeout(600);
  });
  await shoot(ctx, `review-${scheme}`, async (p) => {
    await p.goto(`${BASE}/p/${id}`);
    await p.waitForSelector('.cm-content');
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 }).catch(() => {});
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    // select a word and leave a review comment with a suggested edit
    const line = await p.locator('.cm-line', { hasText: 'uncoordinated edits' }).first().boundingBox();
    await p.mouse.dblclick(line.x + 30, line.y + line.height / 2);
    await p.getByTestId('add-comment').click();
    await p.getByTestId('comment-body').fill('Can we cite the SSS 2011 paper for this claim?');
    await p.getByTestId('comment-suggest-toggle').click();
    await p.getByTestId('comment-suggestion').fill('Collaborative editing (in the CRDT sense)');
    await p.getByTestId('comment-submit').click();
    await p.waitForSelector('[data-testid="review-panel"]');
    await p.waitForTimeout(400);
  });
  await shoot(ctx, `branches-${scheme}`, async (p) => {
    await p.goto(`${BASE}/p/${id}`);
    await p.waitForSelector('.cm-content');
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 }).catch(() => {});
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('branch-menu').click();
    await p.waitForTimeout(300);
  });
  await shoot(ctx, `zotero-${scheme}`, async (p) => {
    await p.goto(`${BASE}/p/${id}`);
    await p.waitForSelector('.cm-content');
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 }).catch(() => {});
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('tab-more').click();
    await p.getByTestId('tab-plugin:zotero').click();
    await p.waitForTimeout(400);
  });
  await shoot(ctx, `history-${scheme}`, async (p) => {
    await p.goto(`${BASE}/p/${id}`);
    await p.waitForSelector('.cm-content');
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 }).catch(() => {});
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('tab-more').click();
    await p.getByTestId('tab-history').click();
    await p.waitForTimeout(400);
  });
  await ctx.request.delete(`${BASE}/api/projects/${id}?permanent=1`);
  await ctx.close();
}
for (const id of shelf) await boot.request.delete(`${BASE}/api/projects/${id}?permanent=1`);
await boot.close();
await browser.close();
