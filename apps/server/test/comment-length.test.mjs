/**
 * A long review comment is kept whole: comments, replies and suggestions up
 * to 20,000 characters are stored as written, and longer ones are refused
 * with a message, never cut short in silence.
 *
 * Real route table (Fastify inject) on a throwaway datastore, accounts off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-comment-length-')));
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const comments = await import('../src/comments.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);

const meta = await store.createProject('Long notes', { 'main.tex': '\\documentclass{article}\n' });
const id = meta.id;
const anchor = { from: 0, to: 4, quote: '\\doc' };
const post = (payload) => app.inject({ method: 'POST', url: `/api/projects/${id}/comments`, payload: { file: 'main.tex', anchor, ...payload } });
const text = (n) => 'word '.repeat(Math.ceil(n / 5)).slice(0, n);

let res = await post({ body: text(12000), suggestion: text(15000) });
eq(res.statusCode, 200, 'a 12,000-character comment is saved');
const c = res.json();
const stored = (await comments.listComments(id, 'main')).find((x) => x.id === c.id);
eq([stored.body.length, stored.suggestion.length], [12000, 15000], 'whole: the comment and its suggestion');

res = await post({ body: text(20001) });
eq(res.statusCode, 400, 'a comment past the limit is refused');
eq(res.json().error, 'Comment is too long (max 20,000 characters)', 'and the refusal says what the limit is');

res = await app.inject({ method: 'POST', url: `/api/projects/${id}/comments/${c.id}/reply`, payload: { body: text(19000) } });
eq(res.statusCode, 200, 'a 19,000-character reply is saved');
eq(res.json().replies[0].body.length, 19000, 'whole');
res = await app.inject({ method: 'POST', url: `/api/projects/${id}/comments/${c.id}/reply`, payload: { body: text(20001) } });
eq(res.statusCode, 400, 'a reply past the limit is refused, not cut');
eq((await comments.listComments(id, 'main')).find((x) => x.id === c.id).replies.length, 1, 'and nothing of it is stored');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('comment length: ok');
process.exit(0);
