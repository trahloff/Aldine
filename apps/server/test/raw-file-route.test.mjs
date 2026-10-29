/**
 * GET /api/projects/:id/file as the file tree's previews use it, with
 * accounts on.
 *
 * - Every project file is served from the app's origin, so nothing in it may
 *   run as the viewer: previewable images and PDFs under their own type (an
 *   SVG as image/svg+xml, which an <img> needs), markup that is not SVG as
 *   text or a download, never as a page; nosniff and the sandbox CSP on all
 *   of them, the CSP allowing no script and no fetch.
 * - Read access is the project's: owner, invited collaborator, link visitor
 *   (link mode) and an access token in its scope; a stranger gets 403,
 *   nobody signed in 401. Branch-aware: a file only on a branch is served
 *   from that branch alone.
 * - The listing's mtime changes when a file is replaced, so a preview's URL
 *   does.
 * - Compile output (which a document can name, \openout) is nosniff too.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-raw-file-route-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { RAW_FILE_CSP } = await import('../src/util.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const session = async (email, name) => {
  const u = await auth.register(email, 'password123', name);
  await db().setEmailPending(u.id, null);
  return `aldine_session=${await auth.createSession(u.id)}`;
};
const owner = await session('owner@example.com', 'Ada Owner');
const member = await session('member@example.com', 'Grace Member');
const visitor = await session('visitor@example.com', 'Vic Visitor');
const ownerUser = await auth.userFromRequest(owner);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="alert(1)"><script>alert(2)</script><rect width="40" height="20"/></svg>';
const files = {
  'main.tex': '\\documentclass{article}\\begin{document}Hi\\end{document}\n',
  'figs/plot.png': PNG,
  'figs/drawing.svg': SVG,
  'figs/LOUD.SVG': SVG,
  'photo.jpg': PNG,
  'anim.gif': PNG,
  'shot.webp': PNG,
  'supplement.pdf': '%PDF-1.4\n%%EOF\n',
  'page.html': '<script>alert(3)</script>',
  'page.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(4)</script></html>',
  'data.xml': '<?xml version="1.0"?><x/>',
  'archive.zip': Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
};
const meta = await store.createProject('Paper', files, ownerUser.id);
meta.share = { mode: 'private', collaborators: ['member@example.com'] };
await store.writeMeta(meta);
const id = meta.id;
const other = await store.createProject('Other', { 'main.tex': files['main.tex'] }, ownerUser.id);
const setShare = async (mode) => { const m = await store.readMeta(id); m.share = { ...m.share, mode }; await store.writeMeta(m); };

const get = (rel, headers = { cookie: owner }, branch = 'main') =>
  app.inject({ method: 'GET', url: `/api/projects/${id}/file?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(rel)}&v=1`, headers });

try {
  // ---- types and headers ----
  const types = {
    'figs/plot.png': 'image/png',
    'figs/drawing.svg': 'image/svg+xml',
    'figs/LOUD.SVG': 'image/svg+xml',
    'photo.jpg': 'image/jpeg',
    'anim.gif': 'image/gif',
    'shot.webp': 'image/webp',
    'supplement.pdf': 'application/pdf',
    'main.tex': 'text/plain; charset=utf-8',
    'data.xml': 'text/plain; charset=utf-8',
    'page.html': 'application/octet-stream',
    'page.xhtml': 'application/octet-stream',
    'archive.zip': 'application/octet-stream',
  };
  for (const [rel, type] of Object.entries(types)) {
    const res = await get(rel);
    eq(res.statusCode, 200, `${rel}: served to the owner`);
    eq(res.headers['content-type'], type, `${rel}: served as ${type}`);
    eq(res.headers['x-content-type-options'], 'nosniff', `${rel}: never sniffed into another type`);
    eq(res.headers['content-security-policy'], RAW_FILE_CSP, `${rel}: under the sandbox CSP`);
    const bytes = files[rel];
    check(res.rawPayload.equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)), `${rel}: the bytes as stored`);
  }
  const directives = RAW_FILE_CSP.split(';').map((d) => d.trim());
  check(directives.includes('sandbox'), 'the CSP sandboxes an SVG opened as a page');
  check(directives.includes("default-src 'none'"), 'and allows no script, frame or fetch by default');
  check(!/script-src|'self'|https?:/.test(RAW_FILE_CSP), 'no directive lets a script run or a request leave');

  // ---- who may read ----
  eq((await get('figs/drawing.svg', { cookie: member })).statusCode, 200, 'an invited collaborator reads it');
  eq((await get('figs/drawing.svg', { cookie: visitor })).statusCode, 403, 'a stranger to a private project does not');
  eq((await get('figs/drawing.svg', {})).statusCode, 401, 'nobody signed in: 401');
  await setShare('link');
  eq((await get('figs/drawing.svg', { cookie: visitor })).statusCode, 200, 'a signed-in link visitor reads it in link mode');
  eq((await get('figs/drawing.svg', {})).statusCode, 401, 'a link still needs an account');
  await setShare('private');
  eq((await get('figs/drawing.svg', { cookie: visitor })).statusCode, 403, 'until the link is turned off');
  const scoped = (await auth.createAccessToken(ownerUser.id, 'this', [id], null)).token;
  const elsewhere = (await auth.createAccessToken(ownerUser.id, 'other', [other.id], null)).token;
  eq((await get('figs/plot.png', { authorization: `Bearer ${scoped}` })).statusCode, 200, 'an access token scoped to the project reads it');
  eq((await get('figs/plot.png', { authorization: `Bearer ${elsewhere}` })).statusCode, 403, 'one scoped to another project does not');
  eq((await get('.git/config')).statusCode, 403, 'git internals are never served');

  // ---- branches ----
  await gitops.createBranch(id, 'draft');
  await gitops.ensureWorktree(id, 'draft');
  store.writeFile(id, 'draft', 'figs/only-draft.png', PNG);
  eq((await get('figs/only-draft.png', { cookie: owner }, 'draft')).statusCode, 200, "a branch's file is served from that branch");
  eq((await get('figs/only-draft.png', { cookie: owner }, 'main')).statusCode, 404, 'and not from main');

  // ---- the listing's mtime moves with the bytes ----
  const listed = async () => (await app.inject({ method: 'GET', url: `/api/projects/${id}/files?branch=main`, headers: { cookie: owner } })).json().files.find((f) => f.path === 'figs/plot.png');
  const abs = path.join(store.branchDir(id, 'main'), 'figs/plot.png');
  fs.utimesSync(abs, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
  const before = await listed();
  eq(before.mtime, 1_600_000_000_000, 'the listing carries the file mtime in ms');
  const put = await app.inject({ method: 'PUT', url: `/api/projects/${id}/file`, headers: { cookie: owner }, payload: { branch: 'main', path: 'figs/plot.png', content: Buffer.concat([PNG, Buffer.from('x')]).toString('base64'), encoding: 'base64' } });
  eq(put.statusCode, 200, 'the owner replaces the image');
  const after = await listed();
  check(after.mtime > before.mtime, 'a replaced file lists a newer mtime');
  eq(after.size, PNG.length + 1, 'and its new size');

  // ---- compile output ----
  const out = path.join(store.branchDir(id, 'main'), '.aldine-out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'evil.html'), '<script>alert(5)</script>');
  const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/output?branch=main&path=.aldine-out/evil.html`, headers: { cookie: owner } });
  eq(res.statusCode, 200, 'an output file the document wrote is served');
  eq(res.headers['content-type'], 'application/octet-stream', 'as a download, not a page');
  eq(res.headers['x-content-type-options'], 'nosniff', 'and never sniffed into one');

  console.log('raw-file-route: ok');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
