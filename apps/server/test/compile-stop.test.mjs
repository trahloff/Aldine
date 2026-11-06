/**
 * Stopping a typeset, and the other ways a run ends without a PDF to show.
 *
 * - POST /api/projects/:id/compile/stop asks the compiler to stop the named
 *   branch's directory only, and ends the branch's typesets still queued on
 *   this node without sending them; one asked for afterwards runs.
 * - A stopped or timed-out run was killed wherever it was: its PDF is not
 *   shown, the previous one stays with pdfStale.
 * - A compiler that does not answer is a 503 with a sentence, not "fetch
 *   failed".
 * - Every finished run is announced on the branch's signal document: an
 *   agent's as `td`, anyone else's as `r`.
 *
 * Real routes and collab on a throwaway datastore, auth off; the compiler is
 * a mock that answers what the test queues, or holds a typeset until a stop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compile-stop-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const queue = [];
const compiles = [];
const stops = [];
let holdNext = false;
let held = null;
let answer = 'json';
const send = (res, code, body) => {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', 'content-length': buf.length });
  res.end(buf);
};
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (answer === 'proxy-error') return send(res, 502, '<html>Bad gateway</html>');
    if (req.url === '/stop') {
      stops.push(body);
      const was = held;
      held = null;
      if (was) send(was.res, 200, { ok: false, stopped: true, exitCode: -1, pdf: '.aldine-out/main.pdf', pdfFresh: true, log: '', errors: [], durationMs: 3 });
      return send(res, 200, { ok: true, stopped: was ? 1 : 0 });
    }
    compiles.push(body);
    if (holdNext) { holdNext = false; held = { res, body }; return; }
    send(res, 200, queue.shift() ?? { ok: false, error: 'mock queue empty' });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { compileProject, stopTypeset, CompilerUnavailableError } = await import('../src/compile.ts');

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const p = await store.createProject('Stop', { 'main.tex': doc });
const other = await store.createProject('Other', { 'main.tex': doc });
// The previous PDF is offered only while its file is on disk.
const pdfOnDisk = path.join(store.branchDir(p.id, 'main'), '.aldine-out', 'main.pdf');
fs.mkdirSync(path.dirname(pdfOnDisk), { recursive: true });
fs.writeFileSync(pdfOnDisk, '%PDF-1.5 placeholder');
const good = { ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: null, synctexFresh: false, log: 'ok', errors: [], durationMs: 5 };
const until = async (cond, what) => {
  const end = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const signal = await collab.hocuspocus.openDirectConnection(collab.docName(p.id, 'main', collab.FILES_SIGNAL), {});
const stamp = (k) => signal.document.getMap('signal').get(k) || 0;

try {
  queue.push({ ...good });
  const first = await compileProject(p.id, 'main');
  eq(first.ok, true, 'a first PDF to fall back on');
  check(stamp('r') > 0, 'a finished run is announced to the branch');
  const rAfterFirst = stamp('r');

  // ---- stop the running typeset, and the one queued behind it ----
  holdNext = true;
  const running = compileProject(p.id, 'main');
  const queued = compileProject(p.id, 'main');
  await until(() => held, 'the typeset to reach the compiler');
  const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/compile/stop`, payload: { branch: 'main' } });
  eq(res.statusCode, 200, `the stop route answers (${res.body})`);
  eq(res.json(), { ok: true }, 'with ok');
  eq(stops.map((s) => s.projectDir), [path.relative(process.env.DATA_DIR, store.branchDir(p.id, 'main'))], 'the compiler is asked to stop this branch\'s directory only');
  const stopped = await running;
  eq(stopped.stopped, true, 'the running typeset reports it was stopped');
  eq(stopped.pdfUrl, first.pdfUrl, 'the torso it left is not shown: the previous PDF stays');
  eq(stopped.pdfStale, true, 'flagged as the last successful one');
  eq(stopped.pdfTruncated, true, 'and the file behind it is marked as cut short');
  const callsBefore = compiles.length;
  const skipped = await queued;
  eq(skipped.stopped, true, 'the typeset queued behind it is stopped too');
  eq(compiles.length, callsBefore, 'without being sent to the compiler');
  eq(skipped.pdfUrl, first.pdfUrl, 'it keeps the previous PDF as well');
  check(skipped.runId > stopped.runId, 'each stopped run is a run of its own');

  // A typeset asked for after the stop runs.
  queue.push({ ...good });
  const after = await compileProject(p.id, 'main');
  eq(after.ok, true, 'the next typeset runs normally');
  check(!after.stopped, 'and is not stopped');
  check(stamp('r') > rAfterFirst, 'runs keep being announced');

  // Another project's typesets are not touched by a stop of this one.
  queue.push({ ...good });
  const elsewhere = compileProject(other.id, 'main');
  await stopTypeset(p.id, 'main');
  eq((await elsewhere).ok, true, 'another project\'s typeset runs through a stop of this one');

  // ---- a timed-out run's PDF is not this run's result either ----
  queue.push({ ...good, ok: false, timedOut: true, exitCode: -1, errors: [] });
  const timedOut = await compileProject(p.id, 'main');
  eq(timedOut.pdfUrl, after.pdfUrl, 'a timed-out run keeps the previous PDF on screen');
  eq(timedOut.pdfStale, true, 'and says so');

  // ---- an agent's run is announced as td, not r ----
  const tdBefore = stamp('td'), rBefore = stamp('r');
  queue.push({ ...good });
  await compileProject(p.id, 'main', { agent: true });
  check(stamp('td') > tdBefore, 'an agent run ends with td');
  eq(stamp('r'), rBefore, 'and no r');

  // ---- a compiler that does not answer ----
  answer = 'proxy-error';
  let thrown = null;
  try { await compileProject(p.id, 'main'); } catch (err) { thrown = err; }
  check(thrown instanceof CompilerUnavailableError, `a proxy's error page is the compiler not answering (got ${thrown})`);
  const viaRoute = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/compile`, payload: { branch: 'main' } });
  eq(viaRoute.statusCode, 503, 'the compile route answers 503');
  check(/typesetting service isn’t answering/.test(viaRoute.json().error), `with a sentence (got ${viaRoute.json().error})`);
  answer = 'json';
  await new Promise((r) => mock.close(r));
  mock.closeAllConnections?.();
  const down = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/compile`, payload: { branch: 'main' } });
  eq(down.statusCode, 503, 'a compiler nothing listens for is a 503 too');
  check(!/fetch failed/.test(down.body), `not "fetch failed" (got ${down.body})`);
  const stopDown = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/compile/stop`, payload: { branch: 'main' } });
  eq(stopDown.statusCode, 503, 'stopping against a stopped compiler says so');
  const badBranch = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/compile/stop`, payload: { branch: '../x' } });
  eq(badBranch.statusCode, 400, 'a branch name that is no branch is refused');
  console.log('compile-stop: OK');
} finally {
  signal.disconnect?.();
  await app.close();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
