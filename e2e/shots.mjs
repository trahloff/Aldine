import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = new URL('./shots/', import.meta.url).pathname;
const BASE = 'http://localhost:5173';
const browser = await chromium.launch();

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
    window.localStorage.setItem('aldine.onboarded', '1');
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

  await shoot(ctx, `editor-${scheme}`, async (p) => {
    await p.goto(`${BASE}/p/${id}`);
    await p.waitForSelector('.cm-content');
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
    await p.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 }).catch(() => {});
    await p.waitForSelector('canvas.pdf-page', { timeout: 120000 }).catch(() => {});
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
  await ctx.request.delete(`${BASE}/api/projects/${id}`);
  await ctx.close();
}
await browser.close();
