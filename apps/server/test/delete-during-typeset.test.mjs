/**
 * Deleting a project forever while a typeset is still writing its output:
 * opening the editor starts one, so "delete" right after "open" lands while
 * the compiler fills .aldine-out. The delete waits for the run and then
 * removes everything, instead of failing with ENOTEMPTY halfway (project
 * trashed, repository half gone, metadata left). The compiler is a mock that
 * keeps writing into the project directory until it answers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-delete-typeset-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

let started;
const typesetStarted = new Promise((r) => { started = r; });
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
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Doomed' } });
  eq(res.statusCode, 200, `created: ${res.body}`);
  const { id } = res.json();
  const repo = store.branchDir(id, 'main');

  const typeset = app.inject({ method: 'POST', url: `/api/projects/${id}/compile`, payload: { branch: 'main' } });
  await typesetStarted;
  const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}?permanent=1` });
  eq(del.statusCode, 200, `delete forever during a typeset succeeds: ${del.body}`);
  eq(del.json(), { ok: true }, 'and reports plain success');
  eq((await typeset).statusCode, 200, 'the typeset itself still answered');
  eq(fs.existsSync(repo), false, 'the project directory is gone, output included');
  eq((await store.listProjects()).some((m) => m.id === id), false, 'and so is its metadata');

  console.log('delete-during-typeset: all assertions passed');
} finally {
  await app.close();
  await closeDb();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
