/**
 * A document that is still loading (#342). Hocuspocus registers a document
 * before its load hook has run, so for the length of that hook an empty
 * document stands under the file's name. A flush in that window (a typeset,
 * a Zotero sync, a file save: opening a project starts all three next to
 * the editor's socket) must not store it: the file and its snapshot would
 * both be replaced by nothing, and the load would then read that back.
 *
 * Real hooks on a throwaway JSON datastore, auth off; env is set before any
 * src import. The autosave debounce is pushed past the test's lifetime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-flush-loading-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');

const PAPER = '\\documentclass{article}\n\\begin{document}\nThe whole paper.\n\\end{document}\n';
const p = await store.createProject('Loading', { 'main.tex': PAPER, 'refs.bib': '@book{a, title={A}}\n' });
const id = p.id;
const name = collab.docName(id, 'main', 'main.tex');
const file = path.join(store.branchDir(id, 'main'), 'main.tex');
const snapFile = path.join(process.env.META_DIR, 'yjs', crypto.createHash('sha1').update(name).digest('hex') + '.ybin');
const disk = () => fs.readFileSync(file, 'utf8');
const textOf = (bytes) => { const d = new Y.Doc(); Y.applyUpdate(d, bytes); return d.getText('content').toString(); };
const open = () => collab.hocuspocus.openDirectConnection(name, {});

async function close(conn) {
  await conn.disconnect();
  for (let i = 0; i < 100 && collab.hocuspocus.documents.has(name); i++) await new Promise((r) => setTimeout(r, 20));
  check(!collab.hocuspocus.documents.has(name), 'setup: the document unloaded');
}

/** Start a load and run `during` at the first moment the document is
 *  registered and still loading; resolves with the loaded connection. */
async function openAnd(during) {
  const opening = open();
  let ran = false;
  for (let i = 0; i < 10_000 && !ran; i++) {
    const doc = collab.hocuspocus.documents.get(name);
    if (doc?.isLoading) { during(doc); ran = true; break; }
    if (doc) break;
    await Promise.resolve();
  }
  check(ran, 'setup: caught the document while it was loading');
  return opening;
}

// a snapshot from an earlier session, as every file has that was open once
let conn = await open();
await conn.transact((doc) => doc.getText('content').insert(doc.getText('content').length, '% a note\n'));
collab.flushBranchDocs(id, 'main');
await close(conn);
const content = PAPER + '% a note\n';
eq(disk(), content, 'setup: the file holds the paper');
eq(textOf(fs.readFileSync(snapFile)), content, 'setup: so does its snapshot');

// 1. a flush while the document loads (typeset, commit, Zotero sync, file save)
conn = await openAnd(() => { collab.flushBranchDocs(id, 'main'); });
eq(disk(), content, 'a flush while the document loads leaves the file as it was');
eq(textOf(fs.readFileSync(snapFile)), content, 'and its snapshot');
eq(conn.document.getText('content').toString(), content, 'the document loads with the paper');
await close(conn);
eq(disk(), content, 'and the file still holds it after the document unloads');

// 2. the shutdown flush
conn = await openAnd(() => { collab.flushAllDocs(); });
eq(disk(), content, 'the shutdown flush while the document loads leaves the file as it was');
eq(conn.document.getText('content').toString(), content, 'the document loads with the paper');
await close(conn);

// 3. a refresh from disk while the document loads (another file was written)
conn = await openAnd(() => { collab.refreshBranchDocsFromDisk(id, 'main', ['refs.bib']); });
eq(conn.document.getText('content').toString(), content, 'a refresh while the document loads: it loads once, from its snapshot');
// a tab from the earlier session reconnects: same operations, nothing doubled
const tab = new Y.Doc();
Y.applyUpdate(tab, fs.readFileSync(snapFile));
await conn.transact((doc) => Y.applyUpdate(doc, Y.encodeStateAsUpdate(tab, Y.encodeStateVector(doc))));
eq(conn.document.getText('content').toString(), content, 'and a tab from the earlier session merges without doubling the text');
await close(conn);

// 4. what a reader of open documents is told while one loads
let seen;
conn = await openAnd(() => { seen = collab.openDocContent(id, 'main', 'main.tex'); });
eq(seen, null, 'a document that is still loading is not reported as open (its text is not the file\'s yet)');
eq(collab.openDocContent(id, 'main', 'main.tex'), content, 'and is once it has loaded');
await close(conn);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('collab-flush-while-loading: ok');
process.exit(0);
