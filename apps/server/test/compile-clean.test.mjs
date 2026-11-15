/**
 * Typeset from scratch through the app server: POST …/compile with
 * clean: true asks the compiler for a clean run (never a draft), a plain
 * typeset never sends clean, and a clean run waits in the branch's chain
 * behind the typeset in progress, so it cannot delete files under it.
 *
 * Real routes on a throwaway datastore, auth off; the compiler is a mock
 * that records each request and can hold one until released.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compile-clean-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const compiles = [];
let holdNext = false;
let held = null;
const good = { ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: null, synctexFresh: false, log: 'ok', errors: [], durationMs: 5 };
const send = (res, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
};
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    compiles.push(JSON.parse(raw || '{}'));
    if (holdNext) { holdNext = false; held = res; return; }
    send(res, good);
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const p = await store.createProject('Clean', { 'main.tex': doc });
const pdfOnDisk = path.join(store.branchDir(p.id, 'main'), '.aldine-out', 'main.pdf');
fs.mkdirSync(path.dirname(pdfOnDisk), { recursive: true });
fs.writeFileSync(pdfOnDisk, '%PDF-1.5 placeholder');
const typeset = (payload) => app.inject({ method: 'POST', url: `/api/projects/${p.id}/compile`, payload: { branch: 'main', ...payload } });
const until = async (cond, what) => {
  const end = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

try {
  const plain = await typeset({});
  eq(plain.statusCode, 200, `a typeset answers (${plain.body})`);
  check(!('clean' in compiles.at(-1)), 'a plain typeset sends no clean');

  const clean = await typeset({ clean: true });
  eq(clean.statusCode, 200, `a clean typeset answers (${clean.body})`);
  eq(clean.json().ok, true, 'and reports the run');
  eq(compiles.at(-1).clean, true, 'the compiler is asked for a clean run');

  await typeset({ clean: true, mode: 'draft' });
  eq(compiles.at(-1).clean, true, 'clean wins over draft');
  check(!('draft' in compiles.at(-1)), 'a clean run is never a draft');

  await typeset({ clean: 'true' });
  check(!('clean' in compiles.at(-1)), 'only a literal true asks for a clean run');

  // ---- a clean run waits behind the typeset in progress ----
  holdNext = true;
  const running = typeset({});
  await until(() => held, 'the first typeset to reach the compiler');
  const sent = compiles.length;
  const queued = typeset({ clean: true });
  await new Promise((r) => setTimeout(r, 300));
  eq(compiles.length, sent, 'the clean run is not sent while the branch\'s typeset runs');
  send(held, good);
  held = null;
  eq((await running).statusCode, 200, 'the first typeset finishes');
  eq((await queued).statusCode, 200, 'then the clean one runs');
  eq(compiles.length, sent + 1, 'sent once');
  eq(compiles.at(-1).clean, true, 'as a clean run');

  console.log('compile-clean: OK');
} finally {
  await app.close();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
