/**
 * Template previews for the New project chooser (templatepreviews.ts) and
 * GET /api/templates/preview, with accounts on.
 *
 * - A folder template is typeset once per version: the same files never go
 *   to the compiler twice, edited files do, and the image survives a restart
 *   (it is read back from the cache directory).
 * - The list row carries `preview` { w, h, v } once the image exists; the
 *   blank template and a template without a .tex never get one.
 * - The route answers the image to a signed-in user only. Naming the current
 *   `v` may be cached for a year; no `v`, or another one, must revalidate.
 *   If-None-Match answers 304. An unknown id is 404.
 *
 * The compiler is a stub on a loopback port that writes what the real one
 * leaves after a typeset: a PDF, then the page-1 image and its sidecar.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-template-previews-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.VENUES_FILE = path.join(tmp, 'venues.json');
process.env.TEMPLATE_PREVIEW_WAIT_MS = '3000';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.TEMPLATE_REPOS;

const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAARAAwDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCtAIUAA//Z', 'base64');

const tplDir = process.env.TEMPLATES_DIR;
const writeTemplate = (name, tex) => {
  fs.mkdirSync(path.join(tplDir, name), { recursive: true });
  fs.writeFileSync(path.join(tplDir, name, 'template.json'), JSON.stringify({ name: name[0].toUpperCase() + name.slice(1), order: 1 }));
  if (tex !== null) fs.writeFileSync(path.join(tplDir, name, 'main.tex'), tex);
};
writeTemplate('paper', '\\documentclass{article}\\title{ {{PROJECT_NAME}} }\\begin{document}Hi\\end{document}\n');
writeTemplate('notex', null);
fs.writeFileSync(path.join(tplDir, 'notex', 'README.md'), 'no document here\n');
fs.writeFileSync(process.env.VENUES_FILE, JSON.stringify({ venues: [] }));

// ---- the stub compiler ----
const compiles = [];
const compiler = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, thumbnails: 'pdftoppm' }));
    if (req.url === '/catalog') return res.end(JSON.stringify({ ok: true, classes: [] }));
    if (req.url !== '/compile') { res.statusCode = 404; return res.end('{}'); }
    const { projectDir, rootFile } = JSON.parse(body);
    const dir = path.join(process.env.DATA_DIR, projectDir);
    compiles.push({ projectDir, rootFile, tex: fs.readFileSync(path.join(dir, rootFile), 'utf8') });
    const out = path.join(dir, '.aldine-out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'main.pdf'), '%PDF-1.5\n');
    res.end(JSON.stringify({ ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true }));
    // The image lands after the answer, as the real compiler's background render does.
    setTimeout(() => {
      const bytes = Buffer.concat([TINY_JPEG, Buffer.from(String(compiles.length))]);
      fs.writeFileSync(path.join(out, '.main.thumb.jpg'), bytes);
      fs.writeFileSync(path.join(out, '.main.thumb.json'), JSON.stringify({ v: thumbVersion(bytes), w: 12, h: 17, pdf: { size: 9, mtimeMs: 1 } }));
    }, 200);
  });
});
await new Promise((r) => compiler.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${compiler.address().port}`;

const { thumbVersion } = await import('../src/thumbnail.ts');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { listTemplates } = await import('../src/templates.ts');
const previews = await import('../src/templatepreviews.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);

const cookie = `aldine_session=${await auth.createSession((await auth.register('ada@example.com', 'password123', 'Ada')).id)}`;
const rows = async () => (await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie } })).json();
const row = async (id) => (await rows()).find((t) => t.id === id);
const preview = (query, headers = { cookie }) => app.inject({ method: 'GET', url: `/api/templates/preview?${query}`, headers });

try {
  eq((await row('paper')).preview, undefined, 'no preview before the first render');

  await previews.refreshPreviews(listTemplates());
  eq(compiles.length, 1, 'one typeset: the paper template, not blank and not a folder without a .tex');
  check(compiles[0].tex.includes('\\title{ Paper }'), 'the placeholders are filled with the template name');
  check(!fs.existsSync(path.join(process.env.DATA_DIR, compiles[0].projectDir)), 'the work directory is removed');

  const p = (await row('paper')).preview;
  check(p && p.w === 12 && p.h === 17 && /^[0-9a-f]{16}$/.test(p.v), 'the row carries the preview size and version');
  eq((await row('blank')).preview, undefined, 'blank has no preview');
  eq((await row('notex')).preview, undefined, 'a template without a .tex has no preview');

  await previews.refreshPreviews(listTemplates());
  eq(compiles.length, 1, 'the same version is never typeset again');

  // ---- the route ----
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

  // ---- a new version ----
  fs.writeFileSync(path.join(tplDir, 'paper', 'main.tex'), '\\documentclass{article}\\begin{document}Changed\\end{document}\n');
  await previews.refreshPreviews(listTemplates());
  eq(compiles.length, 2, 'edited files are typeset again');
  const p2 = (await row('paper')).preview;
  check(p2 && p2.v !== p.v, 'and the row names the new image');
  eq((await preview(`id=paper&v=${p.v}`)).headers['cache-control'], 'private, no-cache', 'the old version is no longer cacheable');

  // ---- kept on disk under its version ----
  const key = previews.templateVersionKey('paper', (await import('../src/templates.ts')).applyPlaceholders((await import('../src/templates.ts')).templateFiles('paper'), { projectName: 'Paper', author: 'Author name' }));
  check(fs.existsSync(path.join(process.env.CACHE_DIR, 'template-previews', `${key}.jpg`)), 'the image is kept in the cache directory under its version');
  check(fs.existsSync(path.join(process.env.CACHE_DIR, 'template-previews', `${key}.json`)), 'with its sidecar');

  console.log('template-previews: ok');
} finally {
  compiler.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
