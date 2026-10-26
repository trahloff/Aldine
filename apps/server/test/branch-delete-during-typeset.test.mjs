/**
 * Deleting a branch while a typeset on it is still writing its output: the
 * delete waits for the run, refuses typesets that arrive meanwhile, and
 * removes the worktree even though the thumbnail renderer drops a file into
 * .aldine-out after the typeset answered. The compiler is a mock that keeps
 * writing into the worktree until it answers, then writes one more file the
 * way the renderer does (never recreating the directory).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-branch-delete-typeset-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

let started;
const typesetStarted = new Promise((r) => { started = r; });
let thumbWritten;
const thumbDone = new Promise((r) => { thumbWritten = r; });
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', async () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, classes: [] }));
      return;
    }
    const out = path.join(process.env.DATA_DIR, JSON.parse(raw).projectDir, '.aldine-out');
    started();
    const until = Date.now() + 400;
    for (let i = 0; Date.now() < until; i++) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, `main.${i % 40}.aux`), 'x');
      await new Promise((r) => setImmediate(r));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, pdf: null, log: 'mock', errors: [], durationMs: 400 }));
    const thumbUntil = Date.now() + 150;
    for (let i = 0; Date.now() < thumbUntil; i++) {
      try { fs.writeFileSync(path.join(out, `.thumb.${i % 20}.jpg`), 'x'); } catch { /* directory removed */ }
      await new Promise((r) => setImmediate(r));
    }
    thumbWritten();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: Fastify } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');

await initDb();
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

try {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Branchy' } });
  eq(res.statusCode, 200, `created: ${res.body}`);
  const { id } = res.json();
  const made = await app.inject({ method: 'POST', url: `/api/projects/${id}/branches`, payload: { name: 'draft' } });
  eq(made.statusCode, 200, `branch created: ${made.body}`);
  const dir = store.branchDir(id, 'draft');
  eq(fs.existsSync(dir), true, 'the branch has a worktree');

  const typeset = app.inject({ method: 'POST', url: `/api/projects/${id}/compile`, payload: { branch: 'draft' } });
  await typesetStarted;
  const delP = app.inject({ method: 'DELETE', url: `/api/projects/${id}/branches?name=draft` });
  await new Promise((r) => setTimeout(r, 20));
  const late = await app.inject({ method: 'POST', url: `/api/projects/${id}/compile`, payload: { branch: 'draft' } });
  eq(late.statusCode, 400, `a typeset asked for during the delete is refused: ${late.body}`);
  eq(late.json().error, 'This branch is being deleted', 'and says why');
  const del = await delP;
  eq(del.statusCode, 200, `delete during a typeset succeeds: ${del.body}`);
  eq(del.json(), { ok: true }, 'and reports plain success');
  eq((await typeset).statusCode, 200, 'the typeset itself still answered');
  await thumbDone;
  eq(fs.existsSync(dir), false, 'the worktree is gone, output included');
  const branches = (await app.inject({ method: 'GET', url: `/api/projects/${id}/branches` })).json();
  eq(branches.some((b) => b.name === 'draft'), false, 'and so is the branch');

  const again = await app.inject({ method: 'POST', url: `/api/projects/${id}/branches`, payload: { name: 'draft' } });
  eq(again.statusCode, 200, `the name can be reused: ${again.body}`);
  eq(fs.existsSync(path.join(store.branchDir(id, 'draft'), '.aldine-out')), false, 'without the old output');

  console.log('branch-delete-during-typeset: all assertions passed');
} finally {
  await app.close();
  await closeDb();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
