/**
 * Template previews for the New project chooser (templatepreviews.ts) and
 * GET /api/templates/preview, with accounts on.
 *
 * Shipped templates:
 * - The image in TEMPLATE_PREVIEWS_DIR is served while its sidecar's key is
 *   the template's current version; after an edit it is not served at all.
 * - The running server never typesets a shipped template.
 * - The route answers the image to a signed-in user only. Naming the current
 *   `v` may be cached for a year; no `v`, or another one, must revalidate.
 *   If-None-Match answers 304. An unknown id is 404.
 *
 * Venue tiles:
 * - An installed class's image is served under venues/ while its key is the
 *   seed the catalog row makes; a fetched kit's under kits/ while its key is
 *   its registry entry, so a new kit URL is not served the old image.
 * - A venue that is both installed and a kit shows the installed image.
 *
 * Repository templates:
 * - The first sync typesets each template once, with the fixed preview date;
 *   a sync that does not move HEAD typesets nothing new.
 * - A commit made while the compiler is down rekeys anyway: the old image is
 *   no longer served, and the next sync with the compiler up renders it.
 * - A typeset that reports errors stores nothing and is retried after the
 *   backoff, not before.
 * - A template removed from the repository loses its preview and its image
 *   is deleted.
 *
 * The compiler is a stub on a loopback port that writes what the real one
 * leaves after a typeset: a PDF, then the page-1 image and its sidecar.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-template-previews-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_TEST_HOOKS = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.TEMPLATE_PREVIEWS_DIR = path.join(tmp, 'shipped-previews');
process.env.VENUES_FILE = path.join(tmp, 'venues.json');
process.env.TEMPLATE_PREVIEW_WAIT_MS = '3000';
process.env.TEMPLATE_PREVIEW_RETRY_MS = '400';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.TEMPLATE_REPOS_FILE;
delete process.env.ALDINE_TEMPLATE_PREVIEWS;

const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAARAAwDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCtAIUAA//Z', 'base64');

// ---- shipped templates ----
const tplDir = process.env.TEMPLATES_DIR;
const writeTemplate = (name, tex) => {
  fs.mkdirSync(path.join(tplDir, name), { recursive: true });
  fs.writeFileSync(path.join(tplDir, name, 'template.json'), JSON.stringify({ name: name[0].toUpperCase() + name.slice(1), order: 1 }));
  if (tex !== null) fs.writeFileSync(path.join(tplDir, name, 'main.tex'), tex);
};
writeTemplate('paper', '\\documentclass{article}\\title{ {{PROJECT_NAME}} }\\begin{document}Hi\\end{document}\n');
writeTemplate('notex', null);
fs.writeFileSync(path.join(tplDir, 'notex', 'README.md'), 'no document here\n');
const kitEntry = (id, url) => ({
  id, name: id === 'llncs' ? 'LNCS kit' : 'Test kit', category: 'Conferences', description: 'A kit.', homepage: 'https://example.org/',
  kit: { url, host: new URL(url).host, take: ['k.sty'] }, documentClass: 'article', preamble: ['\\usepackage{k}'],
});
const writeVenues = (url) => fs.writeFileSync(process.env.VENUES_FILE, JSON.stringify({ venues: [kitEntry('testkit', url), kitEntry('llncs', 'http://127.0.0.1:9/llncs.zip')] }));
writeVenues('http://127.0.0.1:9/k.zip');

// ---- a template repository ----
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
const bare = path.join(tmp, 'lab.git');
const work = path.join(tmp, 'work');
fs.mkdirSync(bare);
git(bare, 'init', '--bare', '-q', '-b', 'main');
git(tmp, 'clone', '-q', bare, work);
git(work, 'config', 'user.email', 'test@example.com');
git(work, 'config', 'user.name', 'Test');
const commit = (files, remove = []) => {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
  }
  for (const rel of remove) fs.rmSync(path.join(work, rel), { recursive: true, force: true });
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'templates');
  git(work, 'push', '-q', 'origin', 'main');
};
commit({
  'thesis/template.json': JSON.stringify({ name: 'Thesis' }),
  'thesis/main.tex': '\\documentclass{report}\\title{ {{PROJECT_NAME}} }\\date{ {{DATE}} }\\begin{document}\\maketitle\\end{document}\n',
  'poster/template.json': JSON.stringify({ name: 'Poster' }),
  'poster/main.tex': '\\documentclass{article}\\begin{document}Poster\\end{document}\n',
});
process.env.TEMPLATE_REPOS = JSON.stringify([{ id: 'lab', label: 'Lab', url: pathToFileURL(bare).href }]);

// ---- the stub compiler ----
const compiles = [];
const stub = { up: true, errors: false };
const compiler = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      if (!stub.up) { res.statusCode = 503; return res.end('{}'); }
      return res.end(JSON.stringify({ ok: true, thumbnails: 'pdftoppm' }));
    }
    if (req.url === '/catalog') return res.end(JSON.stringify({ ok: true, classes: [{ id: 'llncs', cls: 'llncs', kind: 'class' }] }));
    if (req.url !== '/compile') { res.statusCode = 404; return res.end('{}'); }
    const { projectDir, rootFile } = JSON.parse(body);
    const dir = path.join(process.env.DATA_DIR, projectDir);
    compiles.push({ projectDir, rootFile, tex: fs.readFileSync(path.join(dir, rootFile), 'utf8') });
    const out = path.join(dir, '.aldine-out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'main.pdf'), '%PDF-1.5\n');
    const failing = stub.errors;
    res.end(JSON.stringify(failing
      ? { ok: false, pdf: '.aldine-out/main.pdf', pdfFresh: true, errors: [{ type: 'error', message: "LaTeX Error: File `x.sty' not found." }] }
      : { ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, errors: [] }));
    // The image lands after the answer, as the real compiler's background render does.
    if (failing) return;
    setTimeout(() => {
      if (!fs.existsSync(out)) return;
      const bytes = Buffer.concat([TINY_JPEG, Buffer.from(String(compiles.length))]);
      fs.writeFileSync(path.join(out, '.main.thumb.jpg'), bytes);
      fs.writeFileSync(path.join(out, '.main.thumb.json'), JSON.stringify({ v: thumbVersion(bytes), w: 12, h: 17, pdf: { size: 9, mtimeMs: 1 } }));
    }, 100);
  });
});
await new Promise((r) => compiler.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${compiler.address().port}`;

const { thumbVersion } = await import('../src/thumbnail.ts');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { listTemplates } = await import('../src/templates.ts');
const repos = await import('../src/templaterepos.ts');
const previews = await import('../src/templatepreviews.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
// registerRoutes starts the refresh timer and a first sync; the test drives every sync itself.
repos.stopTemplateRepoRefresh();

const cookie = `aldine_session=${await auth.createSession((await auth.register('ada@example.com', 'password123', 'Ada')).id)}`;
const rows = async () => (await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie } })).json();
const row = async (id) => (await rows()).find((t) => t.id === id);
const preview = (query, headers = { cookie }) => app.inject({ method: 'GET', url: `/api/templates/preview?${query}`, headers });
const sync = async () => { await repos.syncTemplateRepo(repos.templateRepo('lab')); await previews.previewsSettled(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repoImages = () => { try { return fs.readdirSync(path.join(process.env.CACHE_DIR, 'template-previews', 'lab')).filter((f) => f.endsWith('.jpg')); } catch { return []; } };
const thesisId = encodeURIComponent('repo:lab/thesis');

try {
  // ---- shipped ----
  const paper = listTemplates().find((t) => t.id === 'paper');
  const ver = previews.versionOf(paper);
  check(ver, 'paper has a version');
  const shippedBytes = Buffer.concat([TINY_JPEG, Buffer.from('shipped')]);
  const sv = thumbVersion(shippedBytes);
  previews.storePreview(process.env.TEMPLATE_PREVIEWS_DIR, 'paper', shippedBytes, { key: ver.key, w: 30, h: 40, v: sv });
  // The boot sync registerRoutes started may still be running; let it land first.
  await repos.syncTemplateRepo(repos.templateRepo('lab'));
  previews.startTemplatePreviews();

  const p = (await row('paper')).preview;
  eq(JSON.stringify(p), JSON.stringify({ w: 30, h: 40, v: sv }), 'the shipped image is served under its sidecar');
  eq((await row('blank')).preview, undefined, 'blank has no preview');
  eq((await row('notex')).preview, undefined, 'a template without a .tex has no preview');
  eq(compiles.length, 0, 'the server never typesets a shipped template');

  eq((await preview(`id=paper&v=${p.v}`, {})).statusCode, 401, 'nobody signed in: 401');
  const hit = await preview(`id=paper&v=${p.v}`);
  eq(hit.statusCode, 200, 'a signed-in user gets the image');
  eq(hit.headers['content-type'], 'image/jpeg', 'as a JPEG');
  eq(hit.headers['cache-control'], 'private, max-age=31536000, immutable', 'naming the current version: cached for a year');
  eq(hit.headers.etag, `"${p.v}"`, 'the ETag is the version');
  eq(thumbVersion(hit.rawPayload), p.v, 'the bytes are the version the row names');
  eq((await preview('id=paper')).headers['cache-control'], 'private, no-cache', 'no version: revalidate');
  eq((await preview('id=paper&v=0000000000000000')).headers['cache-control'], 'private, no-cache', 'another version: revalidate');
  eq((await preview('id=paper', { cookie, 'if-none-match': `"${p.v}"` })).statusCode, 304, 'If-None-Match: 304');
  eq((await preview('id=nope')).statusCode, 404, 'an unknown template: 404');
  eq((await preview('id=blank')).statusCode, 404, 'blank: 404');
  eq((await preview('id=../../etc/passwd')).statusCode, 404, 'a path is not an id');

  fs.writeFileSync(path.join(tplDir, 'paper', 'main.tex'), '\\documentclass{article}\\begin{document}Changed\\end{document}\n');
  previews.loadShippedPreviews();
  eq((await row('paper')).preview, undefined, 'an edited shipped template shows no image until it is rendered again');
  eq((await preview('id=paper')).statusCode, 404, 'and the old image is not served');

  // ---- venues ----
  const { venueClasses } = await import('../src/catalog.ts');
  const { venueKit } = await import('../src/venuekits.ts');
  const llncs = previews.installedVersion((await venueClasses()).find((c) => c.id === 'llncs'));
  check(llncs, 'the installed class has a version');
  const venueBytes = Buffer.concat([TINY_JPEG, Buffer.from('venue')]);
  const kitBytes = Buffer.concat([TINY_JPEG, Buffer.from('kit')]);
  const shippedDir = process.env.TEMPLATE_PREVIEWS_DIR;
  previews.storePreview(path.join(shippedDir, 'venues'), 'llncs', venueBytes, { key: llncs.key, w: 21, h: 29, v: thumbVersion(venueBytes) });
  previews.storePreview(path.join(shippedDir, 'kits'), 'llncs', kitBytes, { key: previews.kitVersionKey(venueKit('llncs')), w: 21, h: 29, v: thumbVersion(kitBytes) });
  previews.storePreview(path.join(shippedDir, 'kits'), 'testkit', kitBytes, { key: previews.kitVersionKey(venueKit('testkit')), w: 22, h: 30, v: thumbVersion(kitBytes) });
  previews.loadShippedPreviews();
  const vRow = await row('venue:llncs');
  eq(vRow.source.kind, 'venue', 'llncs is listed as the installed class');
  eq(vRow.preview?.v, thumbVersion(venueBytes), 'and shows the installed image, not the kit one');
  const vHit = await preview(`id=${encodeURIComponent('venue:llncs')}&v=${vRow.preview.v}`);
  eq(vHit.statusCode, 200, 'the route serves an installed class');
  eq(thumbVersion(vHit.rawPayload), thumbVersion(venueBytes), 'its bytes');
  const kRow = await row('venue:testkit');
  eq(JSON.stringify(kRow.preview), JSON.stringify({ w: 22, h: 30, v: thumbVersion(kitBytes) }), 'a fetched kit shows its image');
  eq((await preview(`id=${encodeURIComponent('venue:testkit')}`)).statusCode, 200, 'and the route serves it');
  eq(compiles.length, 0, 'the server never typesets a venue for its preview');
  writeVenues('http://127.0.0.1:9/k2.zip');
  const later = Date.now() + 1000;
  fs.utimesSync(process.env.VENUES_FILE, later / 1000, later / 1000);
  eq((await row('venue:testkit')).preview, undefined, 'a kit with a new URL shows no image until it is rendered again');
  eq((await preview(`id=${encodeURIComponent('venue:testkit')}`)).statusCode, 404, 'and the old image is not served');
  eq((await preview(`id=${encodeURIComponent('venue:../x')}`)).statusCode, 404, 'a path is not a venue id');

  // ---- repository: first sync in this process ----
  await sync();
  eq(compiles.length, 2, 'the first sync typesets both repository templates');
  const thesisTex = compiles.find((c) => c.tex.includes('report')).tex;
  check(thesisTex.includes('\\title{ Thesis }'), 'the placeholders are filled with the template name');
  check(thesisTex.includes('2026-01-01'), 'with the fixed preview date');
  check(!compiles.some((c) => fs.existsSync(path.join(process.env.DATA_DIR, c.projectDir))), 'the work directories are removed');
  const t1 = (await row('repo:lab/thesis')).preview;
  check(t1 && t1.w === 12 && t1.h === 17, 'the repository row carries its preview');
  eq((await preview(`id=${thesisId}&v=${t1.v}`)).statusCode, 200, 'and the route serves it');

  await sync();
  eq(compiles.length, 2, 'a sync that does not move HEAD typesets nothing');

  // ---- a commit while the compiler is down ----
  stub.up = false;
  commit({ 'thesis/main.tex': '\\documentclass{report}\\begin{document}Second edition\\end{document}\n' });
  await sync();
  eq(compiles.length, 2, 'nothing is typeset while the compiler is down');
  eq((await row('repo:lab/thesis')).preview, undefined, 'the changed template shows no image, not the old one');
  eq((await preview(`id=${thesisId}`)).statusCode, 404, 'and the old image is not served');
  eq(repoImages().length, 1, "the old version's image is deleted");

  stub.up = true;
  await sync();
  eq(compiles.length, 3, 'the next sync with the compiler up renders the new version');
  const t2 = (await row('repo:lab/thesis')).preview;
  check(t2 && t2.v !== t1.v, 'and the row names the new image');

  // ---- a typeset with errors ----
  stub.errors = true;
  commit({ 'poster/main.tex': '\\documentclass{article}\\usepackage{x}\\begin{document}Poster\\end{document}\n' });
  await sync();
  eq(compiles.length, 4, 'the changed poster is typeset');
  eq((await row('repo:lab/poster')).preview, undefined, 'a typeset with errors stores no preview');
  await sync();
  eq(compiles.length, 4, 'and is not retried before the backoff');
  stub.errors = false;
  await sleep(500);
  await sync();
  eq(compiles.length, 5, 'it is retried on a sync after the backoff');
  check((await row('repo:lab/poster')).preview, 'and its preview is stored then');

  // ---- a removed template ----
  commit({}, ['poster']);
  await sync();
  eq(await row('repo:lab/poster'), undefined, 'the removed template is not listed');
  eq((await preview(`id=${encodeURIComponent('repo:lab/poster')}`)).statusCode, 404, 'its preview is not served');
  eq(repoImages().length, 1, 'and its image is deleted');

  console.log('template-previews: ok');
} finally {
  compiler.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
