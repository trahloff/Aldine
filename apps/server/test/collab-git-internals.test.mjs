/**
 * A collab document names a file by the rest of its document name, and the
 * file routes' rule holds there too: git internals, compile output and the
 * branch directory itself are no document. A document over `.git/config` or
 * a hook would let anyone who may edit the project (a link visitor, an
 * agent token) set what the server's next git command runs.
 *
 * Refused three times over: onAuthenticate (connect), onLoadDocument (no
 * document is created, so nothing is read) and writeDocToDisk (nothing is
 * stored even for a document that got loaded some other way). Real hooks on
 * a throwaway JSON datastore; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-collab-internals-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const collab = await import('../src/collab.ts');

const owner = await auth.register('owner@example.com', 'password123', 'Owner');
const visitor = await auth.register('visitor@example.com', 'password123', 'Visitor');
const cookie = `aldine_session=${await auth.createSession(visitor.id)}`;

const meta = await store.createProject('Shared', { 'main.tex': '\\documentclass{article}\\begin{document}Hi\\end{document}\n' }, owner.id);
meta.share = { mode: 'link', collaborators: [] };
await store.writeMeta(meta);
const id = meta.id;
await gitops.createBranch(id, 'draft', 'main');
const repo = store.repoDir(id);
const gitConfig = path.join(repo, '.git', 'config');
const configBefore = fs.readFileSync(gitConfig, 'utf8');
const hook = path.join(repo, '.git', 'hooks', 'post-commit');
const draftGitFile = path.join(store.branchDir(id, 'draft'), '.git');
const draftGitBefore = fs.readFileSync(draftGitFile, 'utf8');
const payload = '[core]\n\tfsmonitor = "touch /tmp/aldine-pwned"\n';

const intact = (label) => {
  eq(fs.readFileSync(gitConfig, 'utf8'), configBefore, `${label}: .git/config is unchanged`);
  check(!fs.existsSync(hook), `${label}: no hook was written`);
  eq(fs.readFileSync(draftGitFile, 'utf8'), draftGitBefore, `${label}: the draft worktree's .git file is unchanged`);
};

const internal = [
  ['main', '.git/config'],
  ['main', '.GIT/config'],
  ['main', '.git./config'],
  ['main', '.git/hooks/post-commit'],
  ['main', 'figs/../.git/config'],
  ['main', '.aldine-out/main.log'],
  ['main', '.'],
  ['main', './'],
  ['draft', '.git'],
];

// ---- connect: onAuthenticate refuses the name before any project lookup ----
const authenticate = (documentName) => collab.hocuspocus.configuration.onAuthenticate({ documentName, requestHeaders: { cookie } });
eq((await authenticate(collab.docName(id, 'main', 'main.tex'))).userId, visitor.id, 'a link visitor connects to a project file');
for (const [branch, p] of internal) {
  let refused = false;
  try { await authenticate(collab.docName(id, branch, p)); } catch { refused = true; }
  check(refused, `onAuthenticate refuses ${branch}:${p}`);
}
check(!!(await authenticate(collab.docName(id, 'main', '.aldine/files-signal'))), 'the files signal document still connects');

// ---- load: no document is created, nothing is read ----
for (const [branch, p] of internal) {
  const name = collab.docName(id, branch, p);
  let refused = false;
  try { await (await collab.hocuspocus.openDirectConnection(name, {})).disconnect(); } catch { refused = true; }
  check(refused, `no document loads for ${branch}:${p}`);
  check(!collab.hocuspocus.documents.has(name), `no document stays loaded for ${branch}:${p}`);
}
intact('load');

// ---- store: a document by such a name never reaches the disk ----
for (const [branch, p] of [['main', '.git/config'], ['main', '.git/hooks/post-commit'], ['draft', '.git']]) {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, payload);
  collab.writeDocToDisk(collab.docName(id, branch, p), doc);
}
intact('store');

// ---- a project file still loads and stores ----
const conn = await collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', 'main.tex'), {});
await conn.transact((doc) => doc.getText('content').insert(0, '% edited\n'));
collab.flushBranchDocs(id, 'main');
check(fs.readFileSync(path.join(repo, 'main.tex'), 'utf8').startsWith('% edited\n'), 'an edit to a project file lands on disk');
await conn.disconnect();
intact('project file');

console.log('collab-git-internals: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
