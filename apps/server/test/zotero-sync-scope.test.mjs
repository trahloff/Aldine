/**
 * A Zotero sync must never touch a paper's other files (#342: a sync commit
 * deleted every line of main.tex).
 *  - the sync commit holds the .bib file only; another file changed on disk,
 *    and typing not yet saved in an open doc, stay uncommitted with their text
 *  - a file that exists but cannot be read refuses the doc load instead of
 *    loading as empty over its snapshot, and a refresh that cannot read a
 *    file keeps the loaded doc rather than dropping it as deleted
 *
 * Real collab and git on a throwaway datastore, a mock Zotero API; env is set
 * before any src import. The autosave debounce is pushed past the test's
 * lifetime, so nothing but the sync commits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-zotero-scope-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'REMOTE_PROVIDERS']) delete process.env[k];

const zoteroMock = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'Last-Modified-Version': '3', 'Total-Results': '1' });
  res.end('@book{zot1, title={From Zotero}, year={2001}}\n');
});
await new Promise((r) => zoteroMock.listen(0, '127.0.0.1', r));
process.env.ZOTERO_API_BASE = `http://127.0.0.1:${zoteroMock.address().port}`;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const gitops = await import('../src/gitops.ts');
const { syncProject } = await import('../src/zotero.ts');

const body = Array.from({ length: 40 }, (_, i) => `Line ${i} of the paper.`).join('\n') + '\n';
const p = await store.createProject('Zotero scope', { 'main.tex': `\\documentclass{article}\n${body}`, 'notes.tex': 'Notes.\n' });
const id = p.id;
const dir = store.branchDir(id, 'main');
const disk = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const open = (f) => collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', f), {});
async function close(conn, f) {
  await conn.disconnect();
  for (let i = 0; i < 100 && collab.openDocContent(id, 'main', f) !== null; i++) await new Promise((r) => setTimeout(r, 20));
  check(collab.openDocContent(id, 'main', f) === null, `setup: ${f} unloaded`);
}

// ---- the sync commits the .bib and nothing else ----
await gitops.commitAll(id, 'main', 'setup');
const before = (await gitops.log(id, 'main'))[0].hash;
store.writeFile(id, 'main', 'notes.tex', 'Notes, edited and not committed.\n');
const conn = await open('main.tex');
await conn.transact((doc) => doc.getText('content').insert(doc.getText('content').length, 'Typed, not yet saved.\n'));

const link = { apiKey: 'k', userId: 7, libraryPrefix: 'users/7', bibFile: 'zotero.bib' };
const synced = await syncProject(id, 'main', true, link);
check(synced.synced === true, `the sync lands the library (got ${JSON.stringify(synced)})`);
const log = await gitops.log(id, 'main');
eq(log[0].message, 'aldine: sync Zotero library into zotero.bib', 'the newest commit is the sync');
eq(log[1].hash, before, 'and it is the only new commit');
const stat = (await gitops.commitDiff(id, log[0].hash)).stat;
check(stat.includes('zotero.bib') && !stat.includes('main.tex') && !stat.includes('notes.tex'), `the sync commit holds only zotero.bib (got ${stat})`);
const dirty = await gitops.uncommittedPaths(id, 'main');
check(dirty.includes('main.tex') && dirty.includes('notes.tex') && !dirty.includes('zotero.bib'), `the other changes stay in the working tree (got ${JSON.stringify(dirty)})`);
check(disk('main.tex').endsWith(`${body}Typed, not yet saved.\n`), 'the unsaved typing is on disk, not reset by the refresh');
eq(disk('notes.tex'), 'Notes, edited and not committed.\n', 'the other file keeps its edit');
eq(conn.document.getText('content').toString(), disk('main.tex'), 'the open doc still holds the whole paper');
await close(conn, 'main.tex');

// ---- an unreadable file is not an empty one ----
// A directory at the path reads as EISDIR for any user, root included.
const full = disk('main.tex');
const abs = path.join(dir, 'main.tex');
const aside = path.join(tmp, 'main.tex.aside');
const makeUnreadable = () => { fs.renameSync(abs, aside); fs.mkdirSync(abs); };
const restore = () => { fs.rmdirSync(abs); fs.renameSync(aside, abs); };

makeUnreadable();
const refused = await open('main.tex').then((c) => c, (err) => err);
const loadedText = refused instanceof Error ? null : refused.document.getText('content').toString();
check(loadedText === null || loadedText === full, `an unreadable file never loads as empty (got ${JSON.stringify(loadedText?.slice(0, 40))})`);
if (!(refused instanceof Error)) await refused.disconnect();
for (let i = 0; i < 100 && collab.openDocContent(id, 'main', 'main.tex') !== null; i++) await new Promise((r) => setTimeout(r, 20));
restore();
eq(disk('main.tex'), full, 'the file itself is untouched');
const back = await open('main.tex');
eq(back.document.getText('content').toString(), full, 'once readable again the doc loads the whole paper');

makeUnreadable();
const errors = [];
const orig = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
try { collab.refreshBranchDocsFromDisk(id, 'main', ['main.tex']); } finally { console.error = orig; }
check(collab.openDocContent(id, 'main', 'main.tex') === full, 'a refresh that cannot read the file keeps the doc and its text');
check(errors.some((l) => l.includes('main.tex')), `and logs the failed read (got ${JSON.stringify(errors)})`);
restore();
collab.flushBranchDocs(id, 'main');
eq(disk('main.tex'), full, 'the next flush writes nothing short');
await close(back, 'main.tex');
const reopened = await open('main.tex');
eq(reopened.document.getText('content').toString(), full, 'the snapshot survived the failed read');
await reopened.disconnect();

zoteroMock.close();
console.log('zotero-sync-scope: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
