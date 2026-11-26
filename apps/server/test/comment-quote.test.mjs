/**
 * A comment always carries the text it quotes. A client that sends an anchor
 * without a quote gets the anchored text filled in, and a comment stored
 * without one (before this was checked) reads back with an empty quote:
 * the Review panel slices it, and an undefined quote took the editor down.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-comment-quote-')));
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const comments = await import('../src/comments.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);

try {
  const meta = await store.createProject('Quotes', { 'main.tex': '\\documentclass{article}\n' });
  const id = meta.id;
  let res = await app.inject({ method: 'POST', url: `/api/projects/${id}/comments`, payload: { file: 'main.tex', anchor: { from: 1, to: 9 }, body: 'no quote sent' } });
  eq(res.statusCode, 200, 'an anchor without a quote is accepted');
  eq(res.json().anchor.quote, 'document', 'and the quote is the anchored text');

  res = await app.inject({ method: 'POST', url: `/api/projects/${id}/comments`, payload: { file: 'main.tex', anchor: { from: 1, to: 9, quote: 'as sent' }, body: 'quote sent' } });
  eq(res.json().anchor.quote, 'as sent', 'a quote the client sends is kept');

  const stored = await db().loadComments(id);
  delete stored[0].anchor.quote;
  await db().saveComments(id, stored);
  const listed = await comments.listComments(id, 'main');
  eq(listed.map((c) => c.anchor.quote), ['', 'as sent'], 'a stored comment without a quote reads back with an empty one');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('comment-quote: ok');
process.exit(0);
