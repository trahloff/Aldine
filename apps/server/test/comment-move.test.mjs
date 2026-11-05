/**
 * Review comments follow a rename or move of their file, or of a folder that
 * holds it, on the same branch (share-2): highlights stay on the text and
 * Accept edits the file where it is now. Comments on other branches and in a
 * sibling folder whose name shares a prefix stay put. Open editors hear of it
 * through the comments signal.
 *
 * Real routes and collab on a throwaway datastore, auth off; env is set
 * before any src import. The autosave debounce is pushed past the test's
 * lifetime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-comment-move-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const { default: Fastify } = await import('fastify');
const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const p = await store.createProject('Comment moves', {
  'chapter2.tex': 'The results hold.\n',
  'sections/a.tex': 'A\n',
  'chapters/one.tex': 'One claim.\n',
  'chaptersx/two.tex': 'Two claims.\n',
});
const id = p.id;
const disk = (rel) => fs.readFileSync(path.join(store.branchDir(id, 'main'), rel), 'utf8');
const rename = (from, to) => app.inject({ method: 'POST', url: `/api/projects/${id}/file/rename`, payload: { branch: 'main', from, to } });
const comment = async (file, quote, suggestion) => {
  const text = disk(file);
  const from = text.indexOf(quote);
  const res = await app.inject({
    method: 'POST', url: `/api/projects/${id}/comments`,
    payload: { branch: 'main', file, anchor: { from, to: from + quote.length, quote }, body: 'Look', suggestion },
  });
  check(res.statusCode === 200, `comment on ${file} (got ${res.statusCode} ${res.body})`);
  return res.json().id;
};
const fileOf = async (cid) => (await db().loadComments(id)).find((c) => c.id === cid)?.file;

const onFile = await comment('chapter2.tex', 'results', 'findings');
const inFolder = await comment('chapters/one.tex', 'claim');
const sibling = await comment('chaptersx/two.tex', 'claims');
// Another branch's thread on the same path: a rename on main is not its business.
const all = await db().loadComments(id);
all.push({ ...all.find((c) => c.id === onFile), id: 'draft-thread', branch: 'draft' });
await db().saveComments(id, all);

const signal = await collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', collab.COMMENTS_SIGNAL), {});
const stamp = () => signal.document.getMap('signal').get('v') || 0;
const before = stamp();

// ---- a file moved into a folder ----
let res = await rename('chapter2.tex', 'sections/chapter2.tex');
check(res.statusCode === 200, `the file moves (got ${res.statusCode} ${res.body})`);
eq(await fileOf(onFile), 'sections/chapter2.tex', 'its comment follows it');
eq(await fileOf('draft-thread'), 'chapter2.tex', "another branch's comment stays");
check(stamp() > before, 'open editors are told to reload comments');

res = await app.inject({ method: 'POST', url: `/api/projects/${id}/comments/${onFile}/accept`, payload: { branch: 'main' } });
check(res.statusCode === 200, `Accept edits the moved file (got ${res.statusCode} ${res.body})`);
eq(disk('sections/chapter2.tex'), 'The findings hold.\n', 'with the suggestion applied');

// ---- a folder renamed ----
const afterFile = stamp();
res = await rename('chapters', 'parts');
check(res.statusCode === 200, `the folder renames (got ${res.statusCode} ${res.body})`);
eq(await fileOf(inFolder), 'parts/one.tex', 'a comment on a file inside it follows');
eq(await fileOf(sibling), 'chaptersx/two.tex', 'a sibling folder with the same prefix is left alone');
check(stamp() > afterFile, 'and editors hear of it again');

// ---- paths as typed: the comparison is on the normalised path ----
res = await rename('./parts/one.tex', 'parts/uno.tex');
check(res.statusCode === 200, `a "./" path renames (got ${res.statusCode} ${res.body})`);
eq(await fileOf(inFolder), 'parts/uno.tex', 'and its comment still follows');

// ---- nothing to move: no signal ----
const quiet = stamp();
res = await rename('sections/a.tex', 'sections/b.tex');
check(res.statusCode === 200, `an uncommented file renames (got ${res.statusCode} ${res.body})`);
eq(stamp(), quiet, 'without a comments signal');

await signal.disconnect();
await app.close();
console.log('comment-move: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
