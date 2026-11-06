/**
 * Linking a Zotero library.
 *  - only the owner links and unlinks; a collaborator and a link visitor
 *    get 403 and the link stays as it was
 *  - a library that cannot be exported never becomes the link, and a failed
 *    re-link keeps the working one
 *  - the import lands on the branch the link names, and a sync on a branch
 *    without the file fetches the whole library even when Zotero reports no
 *    change since the last version
 *  - the project carries the names of the group and the collection
 *
 * Accounts on, a throwaway datastore, the real route table (Fastify
 * inject) and a mock Zotero API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-zotero-link-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL', 'REMOTE_PROVIDERS']) delete process.env[k];

const VERSION = 5;
const BIB = '@book{zot1, title={From Zotero}}\n';
const exports = [];
let revoked = false;
const zoteroMock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.pathname === '/keys/current') return json({ userID: 7, username: 'ada' });
  if (url.pathname === '/users/7/groups') return json([{ id: 42, data: { name: 'Space Lab' } }]);
  if (url.pathname === '/users/7/collections') return json([{ key: 'COLL1', data: { name: 'CRDT Research', parentCollection: false } }]);
  if (url.pathname === '/groups/999/items/top') { res.writeHead(403); return res.end('Forbidden'); }
  if (url.pathname === '/groups/998/items/top') { res.writeHead(401); return res.end('Unauthorized'); }
  if (revoked && url.pathname.startsWith('/users/7/')) { res.writeHead(403); return res.end('Forbidden'); }
  if (url.pathname.endsWith('/items/top')) {
    const since = req.headers['if-modified-since-version'];
    if (since && Number(since) >= VERSION) { res.writeHead(304); return res.end(); }
    if (url.searchParams.get('itemType')) exports.push(url.pathname);
    res.writeHead(200, { 'content-type': 'text/plain', 'Last-Modified-Version': String(VERSION), 'Total-Results': '1' });
    return res.end(BIB);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => zoteroMock.listen(0, '127.0.0.1', r));
process.env.ZOTERO_API_BASE = `http://127.0.0.1:${zoteroMock.address().port}`;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const owner = await auth.register('owner@example.com', 'password123', 'Owner');
const member = await auth.register('member@example.com', 'password123', 'Member');
await db().setEmailPending(member.id, null); // a collaborator by a confirmed address
const visitor = await auth.register('visitor@example.com', 'password123', 'Visitor');
const session = async (u) => `${auth.COOKIE}=${await auth.createSession(u.id)}`;

const created = await store.createProject('Zotero link', { 'main.tex': '\\documentclass{article}\\begin{document}hi\\end{document}\n' }, owner.id);
const id = created.id;
await store.writeMeta({ ...(await store.readMeta(id)), share: { mode: 'link', collaborators: ['member@example.com'] } });

const app = Fastify();
await registerRoutes(app);
await app.ready();
const call = async (u, method, tail, payload) => app.inject({ method, url: `/api/projects/${id}${tail}`, headers: { cookie: await session(u) }, ...(payload !== undefined ? { payload } : {}) });
const stored = async () => (await store.readMeta(id)).zotero;
const has = (branch) => store.fileExists(id, branch, 'zotero.bib');

eq((await call(owner, 'POST', '/branches', { name: 'revision', from: 'main' })).statusCode, 200, 'the owner starts a branch');

// ---- not the owner: refused ----
const asMember = await call(member, 'POST', '/zotero/link', { apiKey: 'k', libraryPrefix: 'users/7' });
eq(asMember.statusCode, 403, 'a collaborator cannot link a Zotero library');
eq(asMember.json().error, 'Only the owner can link a Zotero library', 'and is told who can');
eq((await call(visitor, 'POST', '/zotero/link', { apiKey: 'k', libraryPrefix: 'users/7' })).statusCode, 403, 'nor can a link visitor');
eq(await stored(), undefined, 'the project has no link');

// ---- a library the key cannot export never becomes the link ----
const CANT_READ = 'This Zotero key can\'t read that library. In Zotero, give the key read access to it, then link again.';
const denied = await call(owner, 'POST', '/zotero/link', { apiKey: 'k', libraryPrefix: 'groups/999', branch: 'revision' });
eq(denied.statusCode, 400, 'an export Zotero refuses fails the link');
eq(denied.json().error, CANT_READ, 'with the next step, not Zotero\'s status');
const unauthorized = await call(owner, 'POST', '/zotero/link', { apiKey: 'k', libraryPrefix: 'groups/998' });
eq([unauthorized.statusCode, unauthorized.json().error], [400, CANT_READ], 'a 401 reads the same');
eq(await stored(), undefined, 'and leaves no link behind');
eq((await call(owner, 'GET', '')).json().zotero, null, 'the project reads as unlinked');
check(!has('revision') && !has('main'), 'no file was written');

// ---- the import lands on the branch the link names ----
const linked = await call(owner, 'POST', '/zotero/link', { apiKey: 'k', libraryPrefix: 'users/7', collectionKey: 'COLL1', branch: 'revision' });
eq(linked.statusCode, 200, `the owner links the collection (${linked.body.slice(0, 200)})`);
eq([linked.json().synced, linked.json().bibFile, linked.json().itemCount], [true, 'zotero.bib', 1], 'and the import reports the file');
check(has('revision'), 'zotero.bib is on the branch linked from');
check(!has('main'), 'and not on main');
eq((await call(owner, 'GET', '')).json().zotero, {
  libraryPrefix: 'users/7', collectionKey: 'COLL1', collectionName: 'CRDT Research', bibFile: 'zotero.bib',
  lastSyncedAt: (await stored()).lastSyncedAt, username: 'ada',
}, 'the project names the collection and the account');
eq((await call(member, 'GET', '')).json().zotero.collectionName, 'CRDT Research', 'for its collaborators too');

// ---- a branch without the file gets the whole library ----
exports.length = 0;
const onMain = await call(member, 'POST', '/zotero/sync', { branch: 'main', force: false });
eq(onMain.statusCode, 200, 'a collaborator syncs main');
eq([onMain.json().synced, onMain.json().itemCount], [true, 1], 'which had no file, so the library comes in full');
check(has('main'), 'zotero.bib is now on main');
eq(exports, ['/users/7/collections/COLL1/items/top'], 'from one export of the collection');
const again = await call(member, 'POST', '/zotero/sync', { branch: 'main', force: false });
eq(again.json(), { synced: false, unchanged: true, format: 'biblatex' }, 'with the file there, an unchanged library is left alone');
eq((await call(member, 'POST', '/zotero/sync', { branch: 'no-such-branch' })).statusCode, 400, 'a branch that does not exist is refused');
revoked = true;
const lost = await call(member, 'POST', '/zotero/sync', { branch: 'main', force: true });
eq([lost.statusCode, lost.json().error], [400, 'This Zotero key can\'t read the linked library any more. In Zotero, give the key read access to it, then sync again.'], 'a key that lost access says how to sync again');
revoked = false;

// ---- unlink: owner only ----
eq((await call(member, 'DELETE', '/zotero')).statusCode, 403, 'a collaborator cannot unlink');
eq((await call(visitor, 'DELETE', '/zotero')).statusCode, 403, 'nor can a link visitor');
eq((await stored())?.collectionKey, 'COLL1', 'the link stays');

// ---- a failed re-link keeps the working link ----
eq((await call(owner, 'POST', '/zotero/link', { apiKey: 'k', libraryPrefix: 'groups/999' })).statusCode, 400, 'a re-link to a library the key cannot export fails');
eq([(await stored()).libraryPrefix, (await stored()).collectionKey], ['users/7', 'COLL1'], 'and the link it would have replaced stays');

// ---- a group library carries its name ----
eq((await call(owner, 'DELETE', '/zotero')).statusCode, 200, 'the owner unlinks');
eq(await stored(), undefined, 'and the link is gone');
const group = await call(owner, 'POST', '/zotero/link', { apiKey: 'k', libraryPrefix: 'groups/42' });
eq(group.statusCode, 200, 'the owner links a group library');
eq([(await stored()).libraryName, (await stored()).collectionName], ['Space Lab', undefined], 'named after the group');

await app.close();
zoteroMock.close();
console.log('zotero-link: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
