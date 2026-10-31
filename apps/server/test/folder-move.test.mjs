/**
 * Renaming or deleting a folder through the file routes (#220): every doc
 * under it is evicted like a single file's, open or closed, so a late store
 * from an editor still on the old path writes nothing back and a closed
 * doc's snapshot cannot seed a file re-created there. A typeset root inside
 * a renamed folder moves with it; one inside a deleted folder is re-derived.
 * A folder cannot move into a folder inside itself.
 *
 * Real routes and collab on a throwaway JSON datastore, auth off; env is set
 * before any src import. The autosave debounce is pushed past the test's
 * lifetime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-folder-move-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const DOC = '\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n';
const p = await store.createProject('Folders', {
  'chapters/main.tex': DOC, 'chapters/intro.tex': 'intro\n', 'chapters/closed.tex': 'closed\n', 'other.tex': DOC,
});
const id = p.id;
const meta = await store.readMeta(id);
meta.rootFile = 'chapters/main.tex';
await store.writeMeta(meta);

const name = (rel) => collab.docName(id, 'main', rel);
const exists = (rel) => fs.existsSync(path.join(store.branchDir(id, 'main'), rel));
const disk = (rel) => fs.readFileSync(path.join(store.branchDir(id, 'main'), rel), 'utf8');
const snapFile = (rel) => path.join(process.env.META_DIR, 'yjs', crypto.createHash('sha1').update(name(rel)).digest('hex') + '.ybin');
const rename = (from, to) => app.inject({ method: 'POST', url: `/api/projects/${id}/file/rename`, payload: { branch: 'main', from, to } });
const del = (rel) => app.inject({ method: 'DELETE', url: `/api/projects/${id}/file?branch=main&path=${encodeURIComponent(rel)}` });
/** What the doc's next store would do once an editor still on it typed again. */
const lateStore = (doc, rel) => {
  doc.getText('content').insert(0, 'late ');
  collab.writeDocToDisk(name(rel), doc);
};

// ---- rename: an open child, a closed child's snapshot, the root ----
const conn = await collab.hocuspocus.openDirectConnection(name('chapters/intro.tex'), {});
await conn.transact((doc) => doc.getText('content').insert(0, 'typed '));
const openDoc = conn.document;
const closed = new Y.Doc();
closed.getText('content').insert(0, 'closed\n');
fs.mkdirSync(path.dirname(snapFile('chapters/closed.tex')), { recursive: true });
fs.writeFileSync(snapFile('chapters/closed.tex'), Y.encodeStateAsUpdate(closed));

let res = await rename('chapters', 'parts');
check(res.statusCode === 200, `the folder renames (got ${res.statusCode} ${res.body})`);
eq(res.json().newRoot, 'parts/main.tex', 'the root inside it moves with it');
eq((await store.readMeta(id)).rootFile, 'parts/main.tex', 'and is stored');
eq(disk('parts/intro.tex'), 'typed intro\n', 'typing in the open child was flushed before the move');
check(!collab.hocuspocus.documents.has(name('chapters/intro.tex')), 'the open child doc is evicted');
check(!fs.existsSync(snapFile('chapters/closed.tex')), "the closed child's snapshot is gone");
lateStore(openDoc, 'chapters/intro.tex');
check(!exists('chapters'), 'a late store from the old path writes nothing back');

// ---- a folder cannot move into itself ----
res = await rename('parts', 'parts/sub/parts');
eq(res.statusCode, 400, 'moving a folder into a folder inside itself is refused');
check(exists('parts/main.tex') && !exists('parts/sub'), 'and changes nothing');
res = await rename('parts', 'partsx');
check(res.statusCode === 200, `a sibling whose name starts with the same letters is fine (got ${res.statusCode} ${res.body})`);
eq((await store.readMeta(id)).rootFile, 'partsx/main.tex', 'the root follows again');

// ---- delete: an open child, the root re-derived ----
const conn2 = await collab.hocuspocus.openDirectConnection(name('partsx/intro.tex'), {});
const openDoc2 = conn2.document;
res = await del('partsx');
check(res.statusCode === 200, `the folder deletes with everything in it (got ${res.statusCode} ${res.body})`);
eq(res.json().newRoot, 'other.tex', 'a root inside it is re-derived from what is left');
eq((await store.readMeta(id)).rootFile, 'other.tex', 'and is stored');
check(!collab.hocuspocus.documents.has(name('partsx/intro.tex')), 'the open child doc is evicted');
lateStore(openDoc2, 'partsx/intro.tex');
check(!exists('partsx'), 'a late store writes nothing back');
check(exists('other.tex'), 'files outside the folder stay');

await app.close();
console.log('folder-move: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
