/**
 * A link visitor who is not a member may delete only review comments they
 * wrote, and "wrote" is the account id stored with the comment, never the
 * display name: names are free text and not unique, so a visitor who signs up
 * under a collaborator's name is not that collaborator. A comment stored
 * without an author id belongs to nobody a visitor can prove to be; the
 * owner and collaborators may still delete it.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-comment-author-'));
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
const comments = await import('../src/comments.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const session = async (email, name) => `aldine_session=${await auth.createSession((await auth.register(email, 'password123', name)).id)}`;
const owner = await session('owner@example.com', 'Ada Owner');
const visitor = await session('visitor@example.com', 'Mallory');
const twin = await session('twin@example.com', 'Ada Owner');

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const ownerUser = await auth.userFromRequest(owner);
const meta = await store.createProject('Shared', { 'main.tex': doc }, ownerUser.id);
meta.share = { mode: 'link', collaborators: [] };
await store.writeMeta(meta);
const id = meta.id;

const post = (cookie, body) => app.inject({ method: 'POST', url: `/api/projects/${id}/comments`, headers: { cookie }, payload: { file: 'main.tex', anchor: { from: 0, to: 4, quote: '\\doc' }, body } });
const del = (cookie, cid) => app.inject({ method: 'DELETE', url: `/api/projects/${id}/comments/${cid}`, headers: { cookie } });
const exists = async (cid) => (await comments.listComments(id, 'main')).some((c) => c.id === cid);

try {
  let res = await post(owner, "the owner's note");
  eq(res.statusCode, 200, 'the owner comments');
  const ownersComment = res.json();
  eq(ownersComment.author, 'Ada Owner', 'the display name is shown');
  eq(ownersComment.authorId, ownerUser.id, 'the account id is stored with the comment');

  res = await del(visitor, ownersComment.id);
  eq(res.statusCode, 403, "a visitor cannot delete the owner's comment");
  res = await del(twin, ownersComment.id);
  eq(res.statusCode, 403, "a visitor named like the owner cannot delete the owner's comment");
  check(await exists(ownersComment.id), "the owner's comment survives");

  res = await post(twin, "the twin's note");
  const twinsComment = res.json();
  res = await del(visitor, twinsComment.id);
  eq(res.statusCode, 403, "a visitor cannot delete another visitor's comment");
  res = await del(twin, twinsComment.id);
  eq(res.statusCode, 200, 'a visitor deletes their own comment');
  check(!(await exists(twinsComment.id)), 'and it is gone');

  // Replies carry the account id as well.
  res = await app.inject({ method: 'POST', url: `/api/projects/${id}/comments/${ownersComment.id}/reply`, headers: { cookie: visitor }, payload: { body: 'reply' } });
  eq(res.statusCode, 200, 'a visitor replies');
  eq(res.json().replies[0].authorId, (await auth.userFromRequest(visitor)).id, 'the reply stores the account id');

  // A comment stored with a name only.
  const legacy = await comments.addComment(id, { branch: 'main', file: 'main.tex', anchor: { from: 0, to: 4, quote: '\\doc' }, author: 'Mallory', body: 'old' });
  res = await del(visitor, legacy.id);
  eq(res.statusCode, 403, 'a visitor cannot delete a comment that carries no author id');
  res = await del(owner, legacy.id);
  eq(res.statusCode, 200, 'the owner deletes it');

  res = await del(owner, ownersComment.id);
  eq(res.statusCode, 200, 'the owner deletes their own comment');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('comment-delete-author: all assertions passed');
process.exit(0);
