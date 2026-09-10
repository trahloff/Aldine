// Records the README demo clip: two collaborators on one document — live
// CRDT sync, a fast recompile, and a SyncTeX jump. Produces demo.webm in
// e2e/shots/; convert with e.g.
//   ffmpeg -i e2e/shots/demo.webm -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" e2e/shots/demo.gif
// Needs the dev stack (vite :5173 + server + compiler), like shots.mjs.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = new URL('./shots/', import.meta.url).pathname;
const BASE = process.env.ALDINE_URL || 'http://localhost:5173';
const browser = await chromium.launch();

const PAPER = new URL('./fixtures/demo-paper/', import.meta.url).pathname;
const boot = await browser.newContext();
const res = await boot.request.post(`${BASE}/api/projects`, { data: { name: 'Convergence of Replicated Documents' } });
const { id } = await res.json();
for (const f of fs.readdirSync(PAPER)) {
  const content = fs.readFileSync(PAPER + f, 'utf8');
  await boot.request.put(`${BASE}/api/projects/${id}/file`, { data: { branch: 'main', path: f, content } });
}
// Pre-warm the compile so the recording doesn't sit through a cold build.
await boot.request.post(`${BASE}/api/projects/${id}/compile`, { data: { branch: 'main' }, timeout: 180000 });
await boot.close();

const mkCtx = (record) => browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2, // crisp text in the recording
  colorScheme: 'light',
  ...(record ? { recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } } : {}),
});

// A records; B is the "other author" typing.
const ctxA = await mkCtx(true);
const ctxB = await mkCtx(false);
for (const c of [ctxA, ctxB]) await c.addInitScript((pid) => {
  window.localStorage.setItem('aldine.onboarded', '1');
  window.localStorage.setItem('aldine.theme', 'dark');
  window.localStorage.setItem(`aldine.remoteNudged.${pid}`, '1'); // keep the publish nudge out of the recording
}, id);

const a = await ctxA.newPage();
await a.goto(`${BASE}/p/${id}`);
await a.waitForSelector('.cm-content');
await a.waitForSelector('canvas.pdf-page', { timeout: 120000 });
await a.waitForTimeout(1500); // settle frames

const b = await ctxB.newPage();
await b.goto(`${BASE}/p/${id}`);
await b.waitForSelector('.cm-content');

// B places the cursor at the end of an abstract line that is VISIBLE in A's
// initial viewport, so A's recording shows the characters arriving live.
await b.locator('.cm-line', { hasText: 'without loss of intent' }).first().click();
await b.keyboard.press('End');
await b.keyboard.type(' Your co-authors watch every keystroke arrive live.', { delay: 55 });
await a.waitForTimeout(1200);

// A recompiles (⌘S) and the PDF refreshes in ~2s.
await a.locator('.cm-content').click({ position: { x: 5, y: 5 } });
await a.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
await a.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 });
await a.waitForTimeout(1200);

// SyncTeX: double-click a PDF line to jump the editor to the source.
const pdf = await a.locator('canvas.pdf-page').first().boundingBox();
await a.mouse.dblclick(pdf.x + pdf.width / 2, pdf.y + pdf.height * 0.45);
await a.waitForTimeout(2000);

await ctxB.close();
const video = a.video();
await ctxA.close();
const path = await video.path();
fs.renameSync(path, OUT + 'demo.webm');
await new Promise((r) => setTimeout(r, 200));
await browser.newContext().then(async (c) => { await c.request.delete(`${BASE}/api/projects/${id}`); await c.close(); });
await browser.close();
console.log('recorded:', OUT + 'demo.webm');
