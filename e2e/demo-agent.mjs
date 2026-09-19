// Records the Agent API clip for the landing page and README: Claude edits a
// paragraph over MCP (presence chip, violet tint), adds a section file with
// its \input, typesets, the PDF viewer shows the result, History lists the
// commits with the violet dot, and the session-review toast opens the diff.
// Writes agent-demo.mp4 and agent-demo.gif to e2e/shots/ (OUT_DIR overrides),
// next to the collaboration clip: the Pages workflow copies the mp4 into the
// site at deploy time and the README embeds the gif from there (e2e/.gitignore
// ignores shots/, so both are committed with git add -f like the collaboration
// clip). The raw webm stays in a temp dir. KEEP_PROJECT=1 leaves the recorded project on the
// server so its repo can be inspected. Each step logs its time in the video.
//
// Needs the built app served by the server (npm run build -w apps/web &&
// npm run build:viewer -w apps/server — not vite), a compiler, and a server
// with ALDINE_MCP=1, ALDINE_MCP_TOKEN, ALDINE_PUBLIC_URL=<its origin> (the
// signed PDF link and deep link must be absolute for the viewer), e.g.
//   DATA_DIR=$PWD/.data-demo PORT=4041 node apps/compiler/server.js
//   PORT=3141 ALDINE_MCP=1 ALDINE_MCP_TOKEN=demo-rec ALDINE_PUBLIC_URL=http://localhost:3141 \
//     DATA_DIR=$PWD/.data-demo META_DIR=$PWD/.secrets-demo CACHE_DIR=$PWD/.data-demo/cache \
//     COMPILER_URL=http://localhost:4041 ALDINE_AGENT_PRESENCE_TTL_MS=90000 npx tsx apps/server/src/index.ts
//   ALDINE_URL=http://localhost:3141 ALDINE_MCP_TOKEN=demo-rec node e2e/demo-agent.mjs
// ALDINE_AGENT_PRESENCE_TTL_MS: the review toast arrives once presence
// expires and the idle stretch before it is cut from the clip, but the
// session must still be live when the editor reloads after the viewer
// segment — up to ~45 s after the last write once the preview's own typeset
// is counted — or the editor raises the "while you were away" prompt instead
// and the wait for the session-end toast times out. 90 s is short and safe.
// ffmpeg is taken from FFMPEG, else /opt/homebrew/bin/ffmpeg, else PATH.
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = process.env.OUT_DIR || path.join(ROOT, 'e2e', 'shots');
const BASE = process.env.ALDINE_URL || 'http://localhost:3141';
const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'demo-rec';
const VIEWER_HTML = path.join(ROOT, 'apps', 'server', 'assets', 'pdf-viewer.html');
const PAPER = path.join(ROOT, 'e2e', 'fixtures', 'demo-paper');
const FFMPEG = process.env.FFMPEG || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const GIF_WIDTH = Number(process.env.GIF_WIDTH || 800); // 960 lands over the 6 MB the README and site accept

if (!fs.existsSync(VIEWER_HTML)) throw new Error(`viewer not built: ${VIEWER_HTML} (npm run build:viewer -w apps/server)`);
fs.mkdirSync(OUT, { recursive: true });
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-agent-demo-'));

// The viewer on its own origin, the way a host sandbox loads it: the signed
// PDF fetch has to cross origins for the clip to show what the chat shows.
// The viewer sizes its page well from the host's containerDimensions
// (apps/server/viewer/src/main.ts); with no host it keeps the 520px default
// and leaves the lower half of the frame blank, so the served page carries an
// override sized to the 900px frame less the two bars.
const viewerServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(VIEWER_HTML, 'utf8') + '\n<style>:root{--v-canvas-h:780px}</style>\n');
});
await new Promise((r) => viewerServer.listen(0, '127.0.0.1', r));
const viewerOrigin = `http://127.0.0.1:${viewerServer.address().port}`;

const browser = await chromium.launch();
const boot = await browser.newContext();
const res = await boot.request.post(`${BASE}/api/projects`, { data: { name: 'Convergence of Replicated Documents' } });
if (!res.ok()) throw new Error(`create project: ${res.status()} ${await res.text()}`);
const { id } = await res.json();
for (const f of fs.readdirSync(PAPER)) {
  const content = fs.readFileSync(path.join(PAPER, f), 'utf8');
  await boot.request.put(`${BASE}/api/projects/${id}/file`, { data: { branch: 'main', path: f, content } });
}
// The seed lands as one named commit before recording. Left to the debounced
// autosave it would arrive during the clip: an agent write checkpoints only
// the file it touches, so the rest of the seed would surface as an anonymous
// "aldine: autosave" above Claude's commits in History.
const seeded = await boot.request.post(`${BASE}/api/projects/${id}/commit`, { data: { branch: 'main', message: 'Import the manuscript' } });
if (!seeded.ok() || !(await seeded.json()).committed) throw new Error(`seed commit: ${seeded.status()} ${await seeded.text()}`);
// Pre-warm the compile so the recording never sits through a cold build.
await boot.request.post(`${BASE}/api/projects/${id}/compile`, { data: { branch: 'main' }, timeout: 180000 });
await boot.close();

const client = new Client({ name: 'aldine-demo-recorder', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
}));
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  return { body: JSON.parse(text), structuredContent: r.structuredContent };
}

const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  recordVideo: { dir: RAW, size: { width: 1440, height: 900 } },
});
await ctx.addInitScript((pid) => {
  window.localStorage.setItem('aldine.onboarded', '1');
  window.localStorage.setItem('aldine.theme', 'light');
  window.localStorage.setItem('aldine.experimental.agentPresence', '1');
  window.localStorage.setItem(`aldine.remoteNudged.${pid}`, '1');
}, id);

const page = await ctx.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const step = (label) => console.log(`[${now().toFixed(1)}s] ${label}`);
/** Idle stretches (seconds from the start of the video) dropped from the clip. */
const cuts = [];
const dwell = (ms) => page.waitForTimeout(ms);

await page.goto(`${BASE}/p/${id}`);
await page.waitForSelector('.cm-content');
await page.waitForSelector('canvas.pdf-page', { timeout: 120000 });
const pdfShown = now();
step('editor open, PDF shown');
await dwell(1800);

// Tool calls take seconds on a loaded machine and the editor sits unchanged
// meanwhile; each such wait is cut so the change appears as it would from a
// prompt. The last frames before the cut still show the state it changes.
const idleCut = (from, to) => { if (to - from > 1.5) cuts.push([from + 0.3, to - 0.4]); };

// 1. A paragraph edit lands in the open document: the violet chip in the
//    presence strip, the inserted range tinted, one commit authored Claude.
const editAt = now();
await call('edit_file', {
  project: id, path: 'main.tex',
  edits: [{
    quote: 'We give a short, self-contained treatment of convergence for sequence CRDTs,\nsketch why commutativity of concurrent operations suffices,',
    replacement: 'We give a short, self-contained proof of convergence for sequence CRDTs,\nshow that commutativity of concurrent operations is sufficient,',
  }],
  message: 'Tighten the abstract',
});
await page.getByTestId('presence-agent').waitFor({ timeout: 10000 });
step('edit_file landed, agent present');
idleCut(editAt, now());
await dwell(3800);

// 2. A new section file plus its \input, as one commit.
const batchAt = now();
await call('batch_write', {
  project: id,
  files: [
    {
      path: 'sections/discussion.tex',
      content: [
        '\\section{Discussion}',
        '',
        'The convergence argument above says nothing about latency: a relay that',
        'delays one replica\'s updates leaves both replicas correct but momentarily',
        'divergent. In practice the interesting engineering happens in that window,',
        'where presence, cursors and history let collaborators see what is still in',
        'flight.',
        '',
      ].join('\n'),
    },
    {
      path: 'main.tex',
      edits: [{ quote: '\\section{Conclusion}', replacement: '\\input{sections/discussion}\n\n\\section{Conclusion}' }],
    },
  ],
  message: 'Add a discussion section',
});
await page.getByTestId('file-sections/discussion.tex').waitFor({ timeout: 10000 });
step('batch_write landed');
idleCut(batchAt, now());
await dwell(2800);

// 3. Claude typesets; the open preview adopts that run.
const compileStart = now();
const compiled = await call('compile', { project: id });
if (!compiled.body.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.body.errors?.slice(0, 3))}`);
await page.getByTestId('pdf-status').getByText(/Typeset in/).waitFor({ timeout: 120000 });
step('compile adopted by the preview');
await dwell(2200);
if (now() - compileStart > 5) cuts.push([compileStart + 1.5, now() - 3]);

// 4. The PDF as the chat shows it: the viewer, hydrated from the real result.
//    Half zoom, so a whole page is on screen; page 2 carries the new section.
const payload = Buffer.from(JSON.stringify(compiled.structuredContent)).toString('base64url');
const viewerAt = now();
await page.goto(`${viewerOrigin}/pdf-viewer.html?payload=${payload}`);
await page.locator('[data-testid="viewer-page"].rendered').first().waitFor({ timeout: 30000 });
step('viewer rendered');
idleCut(viewerAt, now());
await dwell(1400);
await page.getByTestId('viewer-zoom-out').click();
await dwell(500);
const zoomAt = now();
await page.getByTestId('viewer-zoom-out').click();
await page.locator('[data-testid="viewer-page"].rendered').first().waitFor({ timeout: 30000 });
idleCut(zoomAt, now());
await dwell(2200);
if ((compiled.body.pages ?? 1) > 1) {
  const nextAt = now();
  await page.getByTestId('viewer-next').click();
  await page.locator('[data-testid="viewer-page"].rendered').nth(1).waitFor({ timeout: 30000 });
  idleCut(nextAt, now());
  await dwell(1200);
  await page.mouse.move(720, 500);
  await page.mouse.wheel(0, 320);
  await dwell(2400);
}

// 5. Back in the editor: History carries the two commits with the violet dot.
const reloadAt = now();
await page.goto(`${BASE}/p/${id}`);
await page.waitForSelector('.cm-content');
await page.getByTestId('tab-history').click();
await page.getByTestId('history-panel').getByText('Add a discussion section').waitFor({ timeout: 15000 });
await page.getByTestId('agent-commit-dot').first().waitFor();
await page.waitForSelector('canvas.pdf-page', { timeout: 120000 });
const historyShown = now();
step('history shown');
// On a loaded machine the reload sits on an empty preview for seconds; the
// clip picks up once History and the preview are both on screen.
if (historyShown - reloadAt > 2) cuts.push([reloadAt + 0.4, historyShown - 0.2]);
await dwell(2500);

// 6. The session ends (presence TTL) and the sticky toast offers the diff.
await page.getByTestId('agent-session-review').waitFor({ timeout: 120000 });
const toastAt = now();
step('review toast');
if (toastAt - historyShown > 3.5) cuts.push([historyShown + 2.5, toastAt - 0.6]);
await dwell(1600);
await page.getByTestId('agent-session-review').click();
await page.getByTestId('agent-review-modal').waitFor();
step('review dialog open');
await dwell(4000);
const end = now();

await client.close().catch(() => {});
const video = page.video();
await ctx.close();
const webm = path.join(RAW, 'agent-demo.webm');
fs.renameSync(await video.path(), webm);
// The repo of a kept project is <DATA_DIR>/projects/<id> (main) or
// <DATA_DIR>/worktrees/<id>/<branch>.
if (process.env.KEEP_PROJECT) console.log(`kept project ${id}`);
else await browser.newContext().then(async (c) => { await c.request.delete(`${BASE}/api/projects/${id}?permanent=1`); await c.close(); });
await browser.close();
await new Promise((r) => viewerServer.close(() => r()));

// The kept stretches, as one ffmpeg select expression; the clip ends with
// the review dialog, not with the browser closing.
const keep = [];
let cursor = pdfShown + 0.3; // the clip opens on the typeset paper, not on the spinner before it
for (const [a, b] of cuts) { keep.push([cursor, a]); cursor = b; }
keep.push([cursor, end]);
const select = keep.map(([a, b]) => `between(t\\,${a.toFixed(2)}\\,${b.toFixed(2)})`).join('+');
const trimmed = `select='${select}',setpts=N/FRAME_RATE/TB`;
const kept = keep.reduce((s, [a, b]) => s + (b - a), 0);
console.log(`recorded ${end.toFixed(1)}s, cuts ${JSON.stringify(cuts.map((c) => c.map((x) => +x.toFixed(1))))}, clip ${kept.toFixed(1)}s`);

const mp4 = path.join(OUT, 'agent-demo.mp4');
const gif = path.join(OUT, 'agent-demo.gif');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', webm, '-vf', `${trimmed},fps=30`, '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4], { stdio: 'inherit' });
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', webm, '-vf',
  `${trimmed},fps=12,scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  gif], { stdio: 'inherit' });
for (const f of [webm, mp4, gif]) console.log(`${f}: ${(fs.statSync(f).size / 1024 / 1024).toFixed(2)} MB`);
