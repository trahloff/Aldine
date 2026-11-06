/**
 * Undo without a commit (manual commits): Replace all and a delete keep
 * before-images outside the repository; Undo puts back each file that still
 * holds what the action left, skips one changed since, and an image is gone
 * once used, once a commit lands, or after a day.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-undo-images-'));
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const images = await import('../src/undoImages.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const project = await store.createProject('Undo Images', { 'a.tex': 'colour one\n', 'b.tex': 'colour two\n', 'figs/x.tex': 'figure\n' });
const id = project.id;
const meta = await store.readMeta(id);
meta.manualCommits = true;
await store.writeMeta(meta);
const dir = store.branchDir(id, 'main');
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const inject = (method, url, payload) => app.inject({ method, url: `/api/projects/${id}${url}`, ...(payload ? { payload } : {}) });
const undo = (token) => inject('POST', '/undo', { branch: 'main', token });
const undoDir = path.join(process.env.META_DIR, 'undo', id);

try {
  const commits = (await gitops.log(id, 'main')).length;
  // ---- Replace all, then Undo: both files back ----
  let r = (await inject('POST', '/replace', { branch: 'main', q: 'colour', replace: 'color', paths: ['a.tex', 'b.tex'] })).json();
  eq(r.pending, true, 'the replace waits for a commit');
  check(/^[0-9a-f]{32}$/.test(r.undo ?? ''), `the replace keeps an undo: ${JSON.stringify(r)}`);
  eq(read('a.tex'), 'color one\n', 'the replace landed');
  check(!fs.readdirSync(dir).some((f) => f.includes('undo')), 'nothing of the image is in the project');
  check(fs.existsSync(undoDir), 'the image is kept under the meta dir');
  let res = (await undo(r.undo)).json();
  eq(res.restored, ['a.tex', 'b.tex'], 'Undo restored both files');
  eq(res.skipped, [], 'and skipped none');
  eq(read('a.tex'), 'colour one\n', 'a.tex is back');
  eq((await gitops.log(id, 'main')).length, commits, 'nothing was committed');
  eq((await undo(r.undo)).statusCode, 410, 'an image is used once');

  // ---- a file changed since is left alone ----
  r = (await inject('POST', '/replace', { branch: 'main', q: 'colour', replace: 'color', paths: ['a.tex', 'b.tex'] })).json();
  fs.writeFileSync(path.join(dir, 'b.tex'), 'color two, edited after\n');
  res = (await undo(r.undo)).json();
  eq(res.restored, ['a.tex'], 'the untouched file came back');
  eq(res.skipped, ['b.tex'], 'the edited one is named as skipped');
  eq(read('b.tex'), 'color two, edited after\n', 'and keeps the later edit');

  // ---- a delete, then Undo: the folder comes back ----
  r = (await inject('DELETE', '/file?branch=main&path=figs')).json();
  eq(r.pending, true, 'the delete waits for a commit');
  check(!fs.existsSync(path.join(dir, 'figs')), 'the folder is gone');
  res = (await undo(r.undo)).json();
  eq(res.restored, ['figs/x.tex'], 'Undo restored the folder\'s file');
  eq(read('figs/x.tex'), 'figure\n', 'with its text');
  // a file made again at the path since is left alone
  r = (await inject('DELETE', '/file?branch=main&path=a.tex')).json();
  fs.writeFileSync(path.join(dir, 'a.tex'), 'a new a.tex\n');
  res = (await undo(r.undo)).json();
  eq(res.skipped, ['a.tex'], 'a file re-created since is not overwritten');
  eq(read('a.tex'), 'a new a.tex\n', 'and keeps its text');

  // ---- a commit since makes the image unusable, and drops it ----
  r = (await inject('POST', '/replace', { branch: 'main', q: 'colour', replace: 'color', paths: ['b.tex'] })).json();
  fs.writeFileSync(path.join(dir, 'b.tex'), 'colour two\n');
  await gitops.commitAll(id, 'main', 'Restore b', 'Ada');
  r = (await inject('POST', '/replace', { branch: 'main', q: 'colour', replace: 'color', paths: ['b.tex'] })).json();
  check(!!r.undo, 'a replace after the commit keeps an image');
  eq((await inject('POST', '/commit', { branch: 'main', message: 'Commit the replace', author: 'Ada' })).json().committed, true, 'the person commits');
  res = await undo(r.undo);
  eq(res.statusCode, 410, 'after a commit the undo is refused');
  check(/a commit landed since/.test(res.json().error), `and says why: ${res.body}`);
  check(!fs.existsSync(undoDir) || fs.readdirSync(undoDir).length === 0, 'the commit dropped the images');

  // ---- expiry ----
  const old = Date.now() - images.IMAGE_TTL_MS - 1000;
  const token = await images.saveImage(id, 'main', [{ path: 'b.tex', before: Buffer.from('x'), after: fs.readFileSync(path.join(dir, 'b.tex')) }], old);
  const gone = await images.restoreImage(id, 'main', token);
  eq(gone, { gone: 'expired' }, 'an image older than a day is refused');
  const stale = await images.saveImage(id, 'main', [{ path: 'b.tex', before: Buffer.from('x'), after: Buffer.from('y') }], old);
  await images.saveImage(id, 'main', [{ path: 'b.tex', before: Buffer.from('x'), after: Buffer.from('y') }]);
  check(!fs.existsSync(path.join(undoDir, `${stale}.json`)), 'a new image drops the expired ones');
  eq((await undo('not-a-token')).statusCode, 410, 'an unknown token is refused');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('undo-images: all assertions passed');
process.exit(0);
