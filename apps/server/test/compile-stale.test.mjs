/**
 * Stale-preview honesty: a failed compile must not mint a fresh pdfUrl for
 * the old PDF the compiler still finds on disk. The client keeps the URL it
 * already shows and learns it is stale; a later success mints a new one.
 * The compiler is a mock that answers whatever the test queues next.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compile-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const queue = [];
const requests = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    requests.push(JSON.parse(raw));
    const body = queue.shift() ?? { ok: false, error: 'mock queue empty' };
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${mock.address().port}`;

const { initDb, closeDb } = await import('../src/db/index.ts');
const store = await import('../src/store.ts');
const { compileProject, forgetPdfUrls } = await import('../src/compile.ts');
const gitops = await import('../src/gitops.ts');

await initDb();
const meta = await store.createProject('Stale test');
const good = { ok: true, pdf: '.aldine-out/main.pdf', synctex: '.aldine-out/main.synctex.gz', log: 'ok', errors: [], durationMs: 5 };
const bad = { ok: false, exitCode: 12, pdf: '.aldine-out/main.pdf', synctex: '.aldine-out/main.synctex.gz', log: '! Undefined control sequence.', errors: [{ type: 'error', line: 3, message: 'Undefined control sequence' }], durationMs: 5 };

try {
  queue.push({ ...bad });
  let r = await compileProject(meta.id, 'main');
  eq(r.ok, false, 'first run fails');
  eq(r.pdfUrl, null, 'no previous success → no URL to show, even though the compiler found a PDF');
  eq(r.pdfStale, false, 'nothing stale when nothing is shown');
  eq(r.pdf, '.aldine-out/main.pdf', 'the on-disk path is still reported');

  queue.push({ ...good });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, true, 'success');
  check(typeof r.pdfUrl === 'string' && /[?&]t=\d+/.test(r.pdfUrl), `success mints a cache-busted URL: ${r.pdfUrl}`);
  eq(r.pdfStale, undefined, 'a fresh result is not stale');
  eq(r.synctex, '.aldine-out/main.synctex.gz', 'synctex path forwarded');
  const fresh = r.pdfUrl;

  await new Promise((res) => setTimeout(res, 5)); // a re-minted URL would differ in t=
  queue.push({ ...bad });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, false, 'failure after a success');
  eq(r.pdfUrl, fresh, 'pdfUrl is the last successful one, byte-identical');
  eq(r.pdfStale, true, 'flagged stale');
  eq(r.errors.length, 1, 'errors pass through');
  eq(r.synctex, '.aldine-out/main.synctex.gz', 'synctex still reported (informational)');

  queue.push({ ...bad });
  r = await compileProject(meta.id, 'main');
  eq(r.pdfUrl, fresh, 'repeated failures keep the same URL');
  eq(r.pdfStale, true, 'still stale');

  await new Promise((res) => setTimeout(res, 5));
  queue.push({ ...good });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, true, 'recovered');
  check(r.pdfUrl !== fresh, 'a new success mints a new URL');
  eq(r.pdfStale, undefined, 'no longer stale');

  // a 4xx bare error from the compiler (e.g. missing root) is a failure too
  queue.push({ ok: false, error: 'root file not found: main.tex' });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, false, 'bare error → not ok');
  check(typeof r.pdfUrl === 'string', 'keeps the last good URL');
  eq(r.pdfStale, true, 'and marks it stale');
  eq(r.log, 'Compiler error: root file not found: main.tex', 'error becomes the log');
  eq(r.synctex, null, 'no synctex from a bare error');

  // a deleted branch takes its worktree (and PDF) with it: the recreated
  // branch must not inherit the URL
  await gitops.createBranch(meta.id, 'draft', 'main');
  queue.push({ ...good });
  r = await compileProject(meta.id, 'draft');
  check(typeof r.pdfUrl === 'string', 'draft succeeds and is remembered');
  forgetPdfUrls(meta.id, 'draft');
  queue.push({ ...bad });
  r = await compileProject(meta.id, 'draft');
  eq(r.pdfUrl, null, 'after the branch is forgotten a failure shows no URL');
  eq(r.pdfStale, false, 'and nothing is stale');
  queue.push({ ...bad });
  r = await compileProject(meta.id, 'main');
  check(typeof r.pdfUrl === 'string', 'forgetting one branch leaves the others alone');

  forgetPdfUrls(meta.id);
  queue.push({ ...bad });
  r = await compileProject(meta.id, 'main');
  eq(r.pdfUrl, null, 'forgetting the project drops every branch');

  eq(requests[0].engine, 'pdf', 'engine forwarded to the compiler');
  console.log('compile stale: all checks passed');
} finally {
  await closeDb();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
