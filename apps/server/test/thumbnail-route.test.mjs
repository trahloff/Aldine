/**
 * GET /api/projects/:id/thumbnail and the `thumb` field of the project list
 * and the trash, with accounts on.
 *
 * - The image is authorized like an unsigned /output link: the owner, an
 *   invited collaborator and (in link mode) a signed-in link visitor get it;
 *   a stranger gets 403, nobody signed in 401, and an access token only
 *   within its scope. A trashed project's image goes to its owner alone, for
 *   the trash; every other route of a trashed project stays 404.
 * - The ETag is the version of the bytes served. A request naming that
 *   version may be cached for a year; one without it, or naming another
 *   version, must revalidate. If-None-Match answers 304.
 * - `thumb` names the branch whose image it is and falls back to main's; a
 *   root file in a subdirectory has its own. No thumbnail, a sidecar that is
 *   not the compiler's, or a file that is not a JPEG is "none" (null, 404).
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore; the compiler's files are planted on disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-thumbnail-route-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { projectThumb, thumbFiles, thumbVersion } = await import('../src/thumbnail.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAARAAwDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCtAIUAA//Z', 'base64');
/** Another valid image: bytes after the end-of-image marker change the version only. */
const OTHER_JPEG = Buffer.concat([TINY_JPEG, Buffer.from('other')]);

/** What the compiler leaves after a successful typeset of `rootFile` on `branch`. */
function plant(id, branch, rootFile, bytes, side = {}) {
  const dir = store.branchDir(id, branch);
  const f = thumbFiles(rootFile);
  fs.mkdirSync(path.dirname(path.join(dir, f.jpg)), { recursive: true });
  fs.writeFileSync(path.join(dir, f.jpg), bytes);
  fs.writeFileSync(path.join(dir, f.json), JSON.stringify({ v: thumbVersion(bytes), w: 12, h: 17, pdf: { size: 1, mtimeMs: 1 }, ...side }));
  return thumbVersion(bytes);
}

const session = async (email, name) => `aldine_session=${await auth.createSession((await auth.register(email, 'password123', name)).id)}`;
const owner = await session('owner@example.com', 'Ada Owner');
const member = await session('member@example.com', 'Grace Member');
const visitor = await session('visitor@example.com', 'Vic Visitor');
const ownerUser = await auth.userFromRequest(owner);

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const meta = await store.createProject('Paper', { 'main.tex': doc }, ownerUser.id);
meta.share = { mode: 'private', collaborators: ['member@example.com'] };
await store.writeMeta(meta);
const id = meta.id;
const other = await store.createProject('Other', { 'main.tex': doc }, ownerUser.id);
const setShare = async (mode) => { const m = await store.readMeta(id); m.share = { ...m.share, mode }; await store.writeMeta(m); };

const thumb = (headers, query = 'branch=main') => app.inject({ method: 'GET', url: `/api/projects/${id}/thumbnail?${query}`, headers });
const listRow = async (cookie) => (await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).json().find((p) => p.id === id);
const trashRows = async (cookie) => (await app.inject({ method: 'GET', url: '/api/projects/trash', headers: { cookie } })).json();

try {
  // ---- none yet ----
  eq((await thumb({ cookie: owner })).statusCode, 404, 'no typeset yet: 404');
  eq((await listRow(owner)).thumb, null, 'and the list row says none');

  const v = plant(id, 'main', 'main.tex', TINY_JPEG);

  // ---- the owner ----
  let res = await thumb({ cookie: owner }, `branch=main&v=${v}`);
  eq(res.statusCode, 200, 'the owner gets the image');
  eq(res.headers['content-type'], 'image/jpeg', 'as a JPEG');
  check(res.rawPayload.equals(TINY_JPEG), 'the bytes the compiler wrote');
  eq(res.headers.etag, `"${v}"`, 'the ETag is the version');
  eq(res.headers['cache-control'], 'private, max-age=31536000, immutable', 'a request naming the version is cached for good');
  eq(res.headers['x-content-type-options'], 'nosniff', 'never sniffed as anything but an image');
  eq((await listRow(owner)).thumb, { branch: 'main', w: 12, h: 17, v }, 'the list row carries branch, size and version');

  res = await thumb({ cookie: owner });
  eq(res.statusCode, 200, 'without v: still the image');
  eq(res.headers['cache-control'], 'private, no-cache', 'but revalidated every time');
  res = await thumb({ cookie: owner }, 'branch=main&v=0123456789abcdef');
  eq(res.headers['cache-control'], 'private, no-cache', 'a v of other bytes is not cached as if it named these');
  eq(res.headers.etag, `"${v}"`, 'and the ETag names the bytes served');

  for (const tag of [`"${v}"`, `W/"${v}"`, `"aaaa", "${v}"`, '*']) {
    res = await thumb({ cookie: owner, 'if-none-match': tag }, `branch=main&v=${v}`);
    eq(res.statusCode, 304, `If-None-Match ${tag}: 304`);
    eq(res.rawPayload.length, 0, `${tag}: no body`);
  }
  eq((await thumb({ cookie: owner, 'if-none-match': '"0123456789abcdef"' })).statusCode, 200, 'a different ETag gets the image');

  // ---- who else ----
  eq((await thumb({ cookie: member })).statusCode, 200, 'an invited collaborator gets it');
  eq((await listRow(member)).thumb?.v, v, "and sees it in the collaborator's list");
  eq((await thumb({ cookie: visitor })).statusCode, 403, 'a stranger to a private project does not');
  eq((await thumb({})).statusCode, 401, 'nobody signed in: 401');
  await setShare('link');
  eq((await thumb({ cookie: visitor })).statusCode, 200, 'a signed-in link visitor gets it, like the PDF');
  await setShare('private');
  eq((await thumb({ cookie: visitor })).statusCode, 403, 'until the link is turned off');

  const scoped = (await auth.createAccessToken(ownerUser.id, 'this', [id], null)).token;
  const elsewhere = (await auth.createAccessToken(ownerUser.id, 'other', [other.id], null)).token;
  eq((await thumb({ authorization: `Bearer ${scoped}` })).statusCode, 200, 'an access token scoped to the project reads it');
  eq((await thumb({ authorization: `Bearer ${elsewhere}` })).statusCode, 403, 'one scoped to another project does not');

  // ---- branches ----
  eq(await projectThumb(await store.readMeta(id), 'draft'), { branch: 'main', w: 12, h: 17, v }, "a branch without one falls back to main's");
  const vDraft = plant(id, 'draft', 'main.tex', OTHER_JPEG, { w: 20, h: 30 });
  eq(await projectThumb(await store.readMeta(id), 'draft'), { branch: 'draft', w: 20, h: 30, v: vDraft }, 'a branch with one has its own');
  res = await thumb({ cookie: owner }, `branch=draft&v=${vDraft}`);
  eq(res.statusCode, 200, "the branch's image is served");
  check(res.rawPayload.equals(OTHER_JPEG), "and it is the branch's bytes");
  eq((await thumb({ cookie: owner }, 'branch=nowhere')).statusCode, 404, 'a branch with none: 404');
  eq((await thumb({ cookie: owner }, `branch=${encodeURIComponent('../draft')}`)).statusCode, 404, 'a branch name that is no branch: 404');

  // ---- a root file in a subdirectory ----
  let m = await store.readMeta(id);
  m.rootFile = 'paper/main.tex';
  await store.writeMeta(m);
  eq((await listRow(owner)).thumb, null, "the top-level root's image is not the subdirectory root's");
  const vSub = plant(id, 'main', 'paper/main.tex', OTHER_JPEG);
  eq((await listRow(owner)).thumb?.v, vSub, "the subdirectory root's image is listed");
  check((await thumb({ cookie: owner })).rawPayload.equals(OTHER_JPEG), 'and served');
  m = await store.readMeta(id);
  m.rootFile = 'main.tex';
  await store.writeMeta(m);

  // ---- not the compiler's ----
  const dir = store.branchDir(id, 'main');
  const f = thumbFiles('main.tex');
  for (const [what, side] of [['a v that is not a version', { v: '<script>' }], ['a size that is no size', { w: 0 }], ['a huge size', { h: 99999 }]]) {
    plant(id, 'main', 'main.tex', TINY_JPEG, side);
    eq((await listRow(owner)).thumb, null, `${what}: no thumb`);
  }
  plant(id, 'main', 'main.tex', TINY_JPEG);
  fs.writeFileSync(path.join(dir, f.jpg), '<html>not an image</html>');
  eq((await thumb({ cookie: owner })).statusCode, 404, 'a file that is not a JPEG is not served');
  plant(id, 'main', 'main.tex', TINY_JPEG);

  // ---- the trash ----
  eq((await app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: { cookie: owner } })).statusCode, 200, 'the owner trashes the project');
  check(!(await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: owner } })).json().some((p) => p.id === id), 'it leaves the list');
  const row = (await trashRows(owner)).find((p) => p.id === id);
  eq(row?.thumb, { branch: 'main', w: 12, h: 17, v }, 'the trash row carries the thumbnail');
  res = await thumb({ cookie: owner }, `branch=main&v=${v}`);
  eq(res.statusCode, 200, 'and its owner gets the image');
  check(res.rawPayload.equals(TINY_JPEG), 'the same bytes');
  eq((await thumb({ cookie: member })).statusCode, 404, 'a collaborator gets 404, as for every route of a trashed project');
  await setShare('link');
  eq((await thumb({ cookie: visitor })).statusCode, 404, 'so does a link visitor');
  eq((await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie: owner } })).statusCode, 404, 'the owner still gets 404 from every other route');
  eq((await trashRows(member)).length, 0, "nobody else's trash lists it");
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('thumbnail-route: all assertions passed');
process.exit(0);
