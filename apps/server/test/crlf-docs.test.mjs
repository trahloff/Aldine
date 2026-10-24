/**
 * A file with CRLF line endings, open in a collab document. Editors count
 * "\r\n" as one character, so a shared text holding the CRs put every edit
 * one character to the left per line above it, and the file, the editor and
 * other people's editors stopped agreeing. The document holds LF; a file
 * that is CRLF throughout gets its CRLF back on every write, so a commit
 * changes only the lines that were edited. A file with mixed endings is not
 * rewritten on open. A snapshot written while the text still held CRs loads
 * without duplicating anything or losing edits made against it.
 *
 * Real hooks on a throwaway JSON datastore, auth off; env is set before any
 * src import. The autosave debounce is pushed past the test's lifetime so
 * only the explicit commits below exist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-crlf-docs-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const collab = await import('../src/collab.ts');
const { createMcpServer } = await import('../src/mcp/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const mcp = createMcpServer({ user: null, tokenScope: null }, '');
await mcp.connect(serverSide);
const client = new Client({ name: 'aldine-test', version: '0.0.0' });
await client.connect(clientSide);
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
};

const CRLF = '\\section{One}\r\nline two\r\nline three\r\nline four\r\nplain end\r\n';
const lf = (s) => s.replace(/\r\n/g, '\n');
const disk = (id, rel) => fs.readFileSync(path.join(store.branchDir(id, 'main'), rel), 'utf8');
const open = (id, rel) => collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', rel), {});
/** The changed lines of a commit's patch, without the file headers. */
const changedLines = async (id, hash) => (await gitops.commitDiff(id, hash)).patch.split('\n')
  .filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));

const REVIEW = 'line three\r\nline two\r\nline three\r\n';
const p = await store.createProject('Windows paper', { 'main.tex': CRLF, 'mixed.tex': 'alpha\r\nbeta\ngamma\r\n', 'old.tex': CRLF, 'moved.tex': CRLF, 'review.tex': REVIEW });
const id = p.id;

// ---- a CRLF file opens as LF text, and opening it writes nothing ----
const conn = await open(id, 'main.tex');
const ytext = conn.document.getText('content');
eq(ytext.toString(), lf(CRLF), 'the open document holds the text with LF line endings');
const versionBefore = collab.fileVersion(id, 'main', 'main.tex');
collab.flushBranchDocs(id, 'main');
eq(disk(id, 'main.tex'), CRLF, 'a flush of the unchanged document leaves the file as it was');
eq(collab.fileVersion(id, 'main', 'main.tex'), versionBefore, 'and does not count as a change of the file');

// ---- an insert at an LF offset lands there on disk, CRLF kept ----
const at = lf(CRLF).indexOf('line four') + 'line four'.length;
await conn.transact((doc) => doc.getText('content').insert(at, 'XYZ'));
collab.flushBranchDocs(id, 'main');
const typed = CRLF.replace('line four', 'line fourXYZ');
eq(disk(id, 'main.tex'), typed, 'the typed text lands at the end of "line four" and every line keeps its CRLF');
const saved = await gitops.autosave(id, 'main');
check(saved.committed, 'the edit commits');
eq(await changedLines(id, saved.hash), ['-line four\r', '+line fourXYZ\r'], 'the commit changes only the edited line');

// ---- REST write of the file into the open document ----
// PUT /file writes the disk and refreshes open documents from it.
store.writeFile(id, 'main', 'main.tex', typed.replace('plain end', 'plain end, rewritten'));
collab.refreshBranchDocsFromDisk(id, 'main', ['main.tex']);
eq(ytext.toString(), lf(typed).replace('plain end', 'plain end, rewritten'), 'a CRLF file written over the open document reaches it as LF');
collab.flushBranchDocs(id, 'main');
eq(disk(id, 'main.tex'), typed.replace('plain end', 'plain end, rewritten'), 'and the next flush leaves that file exactly as written');
await gitops.autosave(id, 'main');

// ---- MCP edit_file on the open document, quoting the file's CRLF bytes ----
const read = await call('read_file', { project: id, path: 'main.tex' });
check(read.content.includes('line three\r\nline fourXYZ'), 'read_file serves the file with its CRLF line endings');
const edited = await call('edit_file', {
  project: id,
  path: 'main.tex',
  edits: [{ quote: 'line three\r\nline fourXYZ', replacement: 'line 3\r\nline 4' }],
  message: 'Number the lines',
});
check(edited.applied === 1 && typeof edited.commit === 'string', `a CRLF quote applies to the open document (got ${JSON.stringify(edited)})`);
check(!ytext.toString().includes('\r'), 'the replacement reaches the document without CRs');
check(ytext.toString().includes('\\section{One}\nline two\nline 3\nline 4\nplain end'), `the edit lands on the quoted lines (got ${JSON.stringify(ytext.toString())})`);
const afterEdit = CRLF.replace('line three\r\nline four', 'line 3\r\nline 4').replace('plain end', 'plain end, rewritten');
eq(disk(id, 'main.tex'), afterEdit, 'the file holds the edit with CRLF line endings throughout');
eq(await changedLines(id, edited.commit), ['-line three\r', '-line fourXYZ\r', '+line 3\r', '+line 4\r'], "the agent's commit changes only the two quoted lines");
check((await gitops.log(id, 'main'))[0].author === 'Claude', 'and is the agent\'s commit');
eq(await gitops.uncommittedPaths(id, 'main'), [], 'nothing is left uncommitted');
await conn.disconnect();

// ---- a file with mixed line endings is left as it is on open ----
const mixed = await open(id, 'mixed.tex');
eq(mixed.document.getText('content').toString(), 'alpha\nbeta\ngamma\n', 'a mixed-ending file opens as LF text');
const mixedVersion = collab.fileVersion(id, 'main', 'mixed.tex');
collab.flushBranchDocs(id, 'main');
eq(disk(id, 'mixed.tex'), 'alpha\r\nbeta\ngamma\r\n', 'opening it does not rewrite the file');
eq(collab.fileVersion(id, 'main', 'mixed.tex'), mixedVersion, 'nor count as a change of it');
await mixed.transact((doc) => doc.getText('content').insert(0, '% note\n'));
collab.flushBranchDocs(id, 'main');
eq(disk(id, 'mixed.tex'), '% note\nalpha\nbeta\ngamma\n', 'its first edit saves it with LF line endings');
await mixed.disconnect();

// ---- a snapshot written while the shared text held the CRs ----
const snapFile = (rel) => path.join(process.env.META_DIR, 'yjs', crypto.createHash('sha1').update(collab.docName(id, 'main', rel)).digest('hex') + '.ybin');
const oldDoc = new Y.Doc();
oldDoc.getText('content').insert(0, CRLF);
const oldState = Y.encodeStateAsUpdate(oldDoc);
fs.mkdirSync(path.dirname(snapFile('old.tex')), { recursive: true });
fs.writeFileSync(snapFile('old.tex'), oldState);
// a browser tab that had the file open across the upgrade, with an edit the
// server has not seen yet: "!" after "line two", in the older text
const tab = new Y.Doc();
Y.applyUpdate(tab, oldState);
tab.getText('content').insert(CRLF.indexOf('line two') + 'line two'.length, '!');

const old = await open(id, 'old.tex');
const oldText = old.document.getText('content');
eq(oldText.toString(), lf(CRLF), 'the old snapshot loads as the file\'s text with LF line endings');
collab.flushBranchDocs(id, 'main');
eq(disk(id, 'old.tex'), CRLF, 'loading it does not rewrite the file');
const migrated = new Y.Doc();
Y.applyUpdate(migrated, fs.readFileSync(snapFile('old.tex')));
eq(migrated.getText('content').toString(), lf(CRLF), 'the snapshot is rewritten without the CRs');

const toServer = Y.encodeStateAsUpdate(tab, Y.encodeStateVector(old.document));
const toTab = Y.encodeStateAsUpdate(old.document, Y.encodeStateVector(tab));
await old.transact((doc) => Y.applyUpdate(doc, toServer));
Y.applyUpdate(tab, toTab);
const merged = lf(CRLF).replace('line two', 'line two!');
eq(oldText.toString(), merged, 'the tab\'s pending edit merges where it was typed, nothing duplicated');
eq(tab.getText('content').toString(), merged, 'and the tab ends up with the same text');
collab.flushBranchDocs(id, 'main');
eq(disk(id, 'old.tex'), CRLF.replace('line two', 'line two!'), 'the file gets the edit with its CRLF line endings');
await old.disconnect();

// an old snapshot of a file that changed on disk since: the file wins
const stale = new Y.Doc();
stale.getText('content').insert(0, 'text from before the pull\r\n');
fs.writeFileSync(snapFile('moved.tex'), Y.encodeStateAsUpdate(stale));
const moved = await open(id, 'moved.tex');
eq(moved.document.getText('content').toString(), lf(CRLF), 'an old snapshot of a file changed on disk since gives way to the file');
collab.flushBranchDocs(id, 'main');
eq(disk(id, 'moved.tex'), CRLF, 'which stays as it is on disk');
await moved.disconnect();

// ---- a suggestion accepted while nobody has the file open ----
// Its anchor counts in the editor's LF text; the quote is there twice, so
// only the offsets can place it.
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify();
await registerRoutes(app);
const from = lf(REVIEW).lastIndexOf('line three');
const made = await app.inject({
  method: 'POST',
  url: `/api/projects/${id}/comments`,
  payload: { branch: 'main', file: 'review.tex', anchor: { from, to: from + 'line three'.length, quote: 'line three' }, body: 'Split it', suggestion: 'line 3\nand more' },
});
check(made.statusCode === 200, `the suggestion is recorded (got ${made.statusCode} ${made.body})`);
check(collab.openDocContent(id, 'main', 'review.tex') === null, 'setup: review.tex is not open');
const accepted = await app.inject({ method: 'POST', url: `/api/projects/${id}/comments/${made.json().id}/accept`, payload: { branch: 'main' } });
check(accepted.statusCode === 200, `the suggestion applies at its anchor (got ${accepted.statusCode} ${accepted.body})`);
eq(disk(id, 'review.tex'), 'line three\r\nline two\r\nline 3\r\nand more\r\n', 'it replaces the anchored line and the file keeps CRLF throughout');
await app.close();

console.log('crlf-docs: all assertions passed');
await client.close();
await mcp.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
