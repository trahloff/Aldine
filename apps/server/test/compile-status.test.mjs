/**
 * The branch's last run, as compile-status reports it: a client adopts a
 * typeset it did not make instead of rebuilding the same PDF, and orders runs
 * by runId — which, unlike compileId, is never reused. The compiler is a mock
 * that answers whatever the test queues next.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compile-status-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const queue = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
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
const { compileProject, compileStatus, forgetPdfUrls } = await import('../src/compile.ts');

await initDb();
const meta = await store.createProject('Compile status');
// The mock compiler writes nothing; the previous PDF is offered only while its
// file is on disk, so stage one where the compiler would have put it.
const pdfOnDisk = path.join(store.branchDir(meta.id, 'main'), '.aldine-out', 'main.pdf');
fs.mkdirSync(path.dirname(pdfOnDisk), { recursive: true });
fs.writeFileSync(pdfOnDisk, '%PDF-1.5 placeholder');
const good = { ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: '.aldine-out/main.synctex.gz', synctexFresh: true, log: 'ok', errors: [], durationMs: 5 };
// Nothing written (missing root, crash, timeout): whatever is on disk is old.
const fatal = { ok: false, exitCode: 1, pdf: '.aldine-out/main.pdf', pdfFresh: false, synctex: '.aldine-out/main.synctex.gz', synctexFresh: false, log: '! Emergency stop.', errors: [{ type: 'error', line: null, message: 'Emergency stop' }], durationMs: 5 };

try {
  let st = compileStatus(meta.id, 'main');
  eq(st.running, false, 'nothing in flight before any run');
  eq(st.result, null, 'no run remembered before any run');
  eq(st.finishedAt, null, 'and no time to report');
  eq(st.agent, false, 'nor an agent flag');

  queue.push({ ...good });
  const first = await compileProject(meta.id, 'main');
  st = compileStatus(meta.id, 'main');
  eq(st.running, false, 'the run is over');
  eq(st.result.ok, true, 'the branch remembers a successful run');
  eq(st.agent, false, 'a plain typeset is not agent-caused');
  eq(typeof st.finishedAt, 'number', 'with the time it finished');
  eq(typeof st.result.runId, 'number', 'and a runId the client can order by');

  // An agent compile is marked as one, so the other tabs know the preview
  // they are about to adopt followed Claude's edits.
  queue.push({ ...good });
  const agentRun = await compileProject(meta.id, 'main', { agent: true });
  st = compileStatus(meta.id, 'main');
  eq(st.agent, true, 'the MCP compile is recorded as agent-caused');
  check(agentRun.runId > first.runId, `a later run gets a greater runId: ${first.runId} → ${agentRun.runId}`);
  eq(st.result.runId, agentRun.runId, 'and that is the run the branch reports');

  // latexmk found nothing to redo: same PDF, same URL, same compileId — the
  // property that makes compileId useless for ordering and runId necessary.
  queue.push({ ...good, pdfFresh: false, synctexFresh: false });
  const redo = await compileProject(meta.id, 'main');
  eq(redo.ok, true, 'an unchanged document still typesets fine');
  eq(redo.compileId, agentRun.compileId, 'nothing was rewritten, so the compileId and its URL stand');
  eq(redo.pdfUrl, agentRun.pdfUrl, 'the client keeps the PDF it already loaded');
  check(redo.runId > agentRun.runId, `but the run itself is newer: ${agentRun.runId} → ${redo.runId}`);

  // A failed run is remembered too: a client adopts the failure (errors panel,
  // stale flag) instead of waiting for a run that will never come.
  queue.push({ ...fatal });
  const failed = await compileProject(meta.id, 'main', { agent: true });
  st = compileStatus(meta.id, 'main');
  eq(st.result.ok, false, 'the failure is what the branch reports');
  eq(st.result.pdfStale, true, 'and it says the pages on screen are from the previous typeset');
  eq(st.agent, true, 'still agent-caused');
  check(failed.runId > redo.runId, 'a failed run is ordered like any other');

  // A branch deleted and recreated under the same name must not report the
  // old branch's run.
  forgetPdfUrls(meta.id, 'main');
  st = compileStatus(meta.id, 'main');
  eq(st.result, null, 'forgetting the branch forgets its last run');
  eq(st.agent, false, 'and its agent flag');
} finally {
  await closeDb();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
