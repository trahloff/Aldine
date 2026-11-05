/**
 * Accepting a suggestion whose stored offsets drifted (share-8): text typed
 * above the comment moves its quote, and when the quote occurs more than
 * once the occurrence nearest the stored offsets is the one edited (the one
 * the editor highlights), with the file closed (disk path) or open (live
 * doc). A quote that is gone, or truncated and off its offsets, is refused.
 *
 * Real routes and collab on a throwaway datastore, auth off; env is set
 * before any src import. The autosave debounce is pushed past the test's
 * lifetime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-comment-accept-')));
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

// ---- the locator on its own ----
const at = (content, from, quote) => collab.locateQuote(content, { from, to: from + quote.length, quote });
eq(at('a results b results', 12, 'results'), { from: 12, to: 19 }, 'offsets that still hold the quote are used as they are');
eq(at('xx a results b results', 12, 'results'), { from: 15, to: 22 }, 'drifted: the occurrence nearest the stored offset');
eq(at('results moved far away', 40, 'results'), { from: 0, to: 7 }, 'a single occurrence anywhere');
eq(at('nothing here', 0, 'results'), null, 'a quote that is gone');
eq(collab.locateQuote('xx results', { from: 0, to: 30, quote: 'results' }), null, 'a truncated quote off its offsets');

const TEXT = 'The results are new.\nOur results hold.\n';
const p = await store.createProject('Accept drift', { 'closed.tex': TEXT, 'open.tex': TEXT });
const id = p.id;
const disk = (rel) => fs.readFileSync(path.join(store.branchDir(id, 'main'), rel), 'utf8');
const suggest = async (file) => {
  const from = TEXT.lastIndexOf('results');
  const res = await app.inject({
    method: 'POST', url: `/api/projects/${id}/comments`,
    payload: { branch: 'main', file, anchor: { from, to: from + 'results'.length, quote: 'results' }, body: 'Word', suggestion: 'findings' },
  });
  check(res.statusCode === 200, `comment on ${file} (got ${res.statusCode} ${res.body})`);
  return res.json().id;
};
const accept = (cid) => app.inject({ method: 'POST', url: `/api/projects/${id}/comments/${cid}/accept`, payload: { branch: 'main' } });

// ---- no doc open: the disk copy ----
const onClosed = await suggest('closed.tex');
fs.writeFileSync(path.join(store.branchDir(id, 'main'), 'closed.tex'), `A ${TEXT}`);
let res = await accept(onClosed);
check(res.statusCode === 200, `a drifted quote that occurs twice is accepted (got ${res.statusCode} ${res.body})`);
eq(disk('closed.tex'), 'A The results are new.\nOur findings hold.\n', 'on the occurrence it was made on');

// ---- an open doc: the live text ----
const onOpen = await suggest('open.tex');
const conn = await collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', 'open.tex'), {});
await conn.transact((doc) => doc.getText('content').insert(0, 'A '));
res = await accept(onOpen);
check(res.statusCode === 200, `the same in an open document (got ${res.statusCode} ${res.body})`);
eq(conn.document.getText('content').toString(), 'A The results are new.\nOur findings hold.\n', 'the live doc is edited at the nearest occurrence');

// ---- the text is gone: refused ----
const gone = await suggest('closed.tex');
fs.writeFileSync(path.join(store.branchDir(id, 'main'), 'closed.tex'), 'Rewritten entirely.\n');
res = await accept(gone);
eq(res.statusCode, 409, 'a quote no longer in the file is refused');

await conn.disconnect();
await app.close();
console.log('comment-accept: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
