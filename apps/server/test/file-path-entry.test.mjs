/**
 * The file routes and comment anchors take a path that must name a file or
 * folder inside the project. '.', './' and an absolute path name none: on
 * main the branch directory is the repository itself, .git included, so a
 * delete there would take the whole history. Git internals are no anchor
 * either: accepting a suggestion writes the anchored file. The store's own
 * write, rename and delete refuse both shapes whatever the caller checked.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore, as a signed-in link visitor who may edit but is no member.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-entry-'));
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
const gitops = await import('../src/gitops.ts');
const comments = await import('../src/comments.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const owner = await auth.register('owner@example.com', 'password123', 'Owner');
const visitor = await auth.register('visitor@example.com', 'password123', 'Visitor');
const visitorCookie = `aldine_session=${await auth.createSession(visitor.id)}`;
const ownerCookie = `aldine_session=${await auth.createSession(owner.id)}`;

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const meta = await store.createProject('Shared', { 'main.tex': doc, 'figs/a.txt': 'a' }, owner.id);
meta.share = { mode: 'link', collaborators: [] };
await store.writeMeta(meta);
await gitops.createBranch(meta.id, 'draft', 'main');
const id = meta.id;
const repo = store.repoDir(id);
const draft = store.branchDir(id, 'draft');
const gitConfig = path.join(repo, '.git', 'config');
const configBefore = fs.readFileSync(gitConfig, 'utf8');

const as = (cookie) => (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const visit = as(visitorCookie);
const intact = (label) => {
  check(fs.existsSync(path.join(repo, '.git', 'HEAD')), `${label}: the repository's .git survives`);
  check(fs.existsSync(path.join(repo, 'main.tex')), `${label}: main's files survive`);
  check(fs.existsSync(path.join(draft, 'main.tex')), `${label}: the draft worktree survives`);
  eq(fs.readFileSync(gitConfig, 'utf8'), configBefore, `${label}: .git/config is unchanged`);
};

try {
  // ---- delete: the branch directory itself is no file ----
  for (const p of ['.', './', '.%2F', '%2E', '/', './.']) {
    for (const branch of ['main', 'draft']) {
      const res = await visit('DELETE', `/api/projects/${id}/file?branch=${branch}&path=${p}`);
      eq(res.statusCode, 400, `DELETE path=${p} on ${branch} → 400`);
    }
  }
  intact('after the deletes');

  // ---- write and rename: same rule ----
  for (const p of ['.', './', '/']) {
    const res = await visit('PUT', `/api/projects/${id}/file`, { branch: 'main', path: p, content: 'x' });
    eq(res.statusCode, 400, `PUT path=${p} → 400`);
  }
  let res = await visit('POST', `/api/projects/${id}/file/rename`, { branch: 'draft', from: '.', to: 'moved' });
  eq(res.statusCode, 400, 'rename from "." → 400');
  res = await visit('POST', `/api/projects/${id}/file/rename`, { branch: 'main', from: 'main.tex', to: './' });
  eq(res.statusCode, 400, 'rename to "./" → 400');
  intact('after the writes and renames');

  // ---- comment anchors: a project file, never the directory or .git ----
  const anchor = { from: 0, to: 6, quote: '[core]' };
  res = await visit('POST', `/api/projects/${id}/comments`, { file: '.', anchor, body: 'x' });
  eq(res.statusCode, 400, 'a comment anchored to "." → 400');
  for (const file of ['.git/config', '.GIT/config', './.git/config']) {
    res = await visit('POST', `/api/projects/${id}/comments`, { file, anchor, body: 'x', suggestion: '[core]\n\tbare = true\n' });
    eq(res.statusCode, 403, `a comment anchored to ${file} → 403`);
  }
  eq((await comments.listComments(id, 'main')).length, 0, 'no comment was stored');
  // One stored before the route refused such anchors cannot be accepted.
  const planted = await comments.addComment(id, { branch: 'main', file: '.git/config', anchor, author: 'Visitor', body: 'x', suggestion: '[core]\n\tbare = true\n' });
  res = await visit('POST', `/api/projects/${id}/comments/${planted.id}/accept`, { branch: 'main' });
  eq(res.statusCode, 403, 'accepting a suggestion anchored in .git → 403');
  intact('after the comments');

  // ---- the store refuses on its own ----
  const refuses = (fn, label) => { let threw = false; try { fn(); } catch { threw = true; } check(threw, label); };
  refuses(() => store.deleteFile(id, 'main', '.'), 'store.deleteFile refuses "."');
  refuses(() => store.deleteFile(id, 'draft', './'), 'store.deleteFile refuses "./"');
  refuses(() => store.deleteFile(id, 'main', '.git'), 'store.deleteFile refuses .git');
  refuses(() => store.writeFile(id, 'main', '.git/config', 'x'), 'store.writeFile refuses .git/config');
  refuses(() => store.writeFile(id, 'main', '.', 'x'), 'store.writeFile refuses "."');
  refuses(() => store.renameFile(id, 'main', '.', 'moved'), 'store.renameFile refuses from "."');
  refuses(() => store.renameFile(id, 'main', 'main.tex', '.git/x'), 'store.renameFile refuses a target in .git');
  intact('after the store calls');

  // ---- ordinary paths still work for an editor ----
  res = await visit('PUT', `/api/projects/${id}/file`, { branch: 'main', path: './notes.txt', content: 'n' });
  eq(res.statusCode, 200, 'PUT ./notes.txt → 200');
  res = await visit('POST', `/api/projects/${id}/comments`, { file: 'main.tex', anchor: { from: 0, to: 4, quote: '\\doc' }, body: 'ok' });
  eq(res.statusCode, 200, 'a comment on main.tex → 200');
  res = await visit('DELETE', `/api/projects/${id}/file?branch=main&path=figs`);
  eq(res.statusCode, 200, 'deleting a folder → 200');
  check(!fs.existsSync(path.join(repo, 'figs')), 'the folder is gone');
  res = await visit('DELETE', `/api/projects/${id}/file?branch=draft&path=main.tex`);
  eq(res.statusCode, 200, 'deleting a file on a branch → 200');
  check(!fs.existsSync(path.join(draft, 'main.tex')), 'the file is gone from the branch');
  res = await as(ownerCookie)('GET', `/api/projects/${id}/files`);
  eq(res.statusCode, 200, "the owner's file list still loads");
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('file-path-entry: all assertions passed');
// The writes scheduled auto-commit debounce timers; exit instead of letting
// them fire against the deleted temp dir.
process.exit(0);
