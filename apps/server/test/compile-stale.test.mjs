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
const { compileProject, forgetPdfUrls, synctexLookup, pagesFromLog } = await import('../src/compile.ts');

// pdfTeX wraps log lines at max_print_line; the page count must survive one wrap.
eq(pagesFromLog('Output written on .aldine-out/main.pdf (12 pages, 100 bytes).\n'), 12, 'pages on one line');
eq(pagesFromLog('Output written on .aldine-out/thesis-final-version-2026-for-submission.pdf (\n12 pages, 100 bytes).\n'), 12, 'pages after a wrapped line');
eq(pagesFromLog('Output written on .aldine-out/thesis-final-version-2026-for-submission.pdf\n(3 pages, 100 bytes).\nOutput written on x.pdf (4 pages).\n'), 4, 'the last run wins, wrapped or not');
eq(pagesFromLog('Output written on .aldine-out/main.pdf (12\npages, 100 bytes).\n'), 12, 'a wrap between the count and "pages"');
eq(pagesFromLog('No pages of output.\n'), null, 'no output → null');
const gitops = await import('../src/gitops.ts');

await initDb();
const meta = await store.createProject('Stale test');
// The mock compiler writes nothing; a previous PDF is offered only while its
// file is still on disk, so stage one where the compiler would have put it.
const pdfOnDisk = path.join(store.branchDir(meta.id, 'main'), '.aldine-out', 'main.pdf');
fs.mkdirSync(path.dirname(pdfOnDisk), { recursive: true });
fs.writeFileSync(pdfOnDisk, '%PDF-1.5 placeholder');
const good = { ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: '.aldine-out/main.synctex.gz', synctexFresh: true, log: 'ok', errors: [], durationMs: 5 };
// Errors, but TeX ran to the end: the PDF and SyncTeX on disk are this run's.
const errorsFull = { ok: false, exitCode: 12, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: '.aldine-out/main.synctex.gz', synctexFresh: true, log: '! Undefined control sequence.', errors: [{ type: 'error', line: 3, message: 'Undefined control sequence' }], durationMs: 5 };
// Nothing written (missing root, crash, timeout): whatever is on disk is old.
const fatal = { ok: false, exitCode: 1, pdf: '.aldine-out/main.pdf', pdfFresh: false, synctex: '.aldine-out/main.synctex.gz', synctexFresh: false, log: '! Emergency stop.', errors: [{ type: 'error', line: null, message: 'Emergency stop' }], durationMs: 5 };
// A compiler from before pdfFresh existed reports ok only.
const legacyBad = { ok: false, exitCode: 12, pdf: '.aldine-out/main.pdf', synctex: '.aldine-out/main.synctex.gz', log: '! Undefined control sequence.', errors: [{ type: 'error', line: 3, message: 'Undefined control sequence' }], durationMs: 5 };

try {
  queue.push({ ...fatal });
  let r = await compileProject(meta.id, 'main');
  eq(r.ok, false, 'first run fails');
  eq(r.pdfUrl, null, 'no previous output → no URL to show, even though the compiler found a PDF');
  eq(r.pdfStale, false, 'nothing stale when nothing is shown');
  eq(r.pdf, '.aldine-out/main.pdf', 'the on-disk path is still reported');
  eq(requests.at(-1).haltOnError, false, 'default: the compiler is asked to run to the end');

  queue.push({ ...good });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, true, 'success');
  check(typeof r.pdfUrl === 'string' && /[?&]t=\d+/.test(r.pdfUrl), `success mints a cache-busted URL: ${r.pdfUrl}`);
  eq(r.pdfStale, undefined, 'a fresh result is not stale');
  eq(typeof r.compileId, 'number', 'a shown run carries its compileId');
  eq(r.synctex, '.aldine-out/main.synctex.gz', 'synctex path forwarded');
  const fresh = r.pdfUrl;
  const freshId = r.compileId;

  queue.push({ ...errorsFull });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, false, 'errors are reported');
  check(r.pdfUrl !== fresh, 'a run that wrote a complete PDF is shown, errors and all');
  eq(r.pdfStale, undefined, 'not stale: the PDF on screen is this run\'s');
  eq(r.errors.length, 1, 'errors pass through');
  check(r.compileId > freshId, 'compileId increases');
  const withErrors = r.pdfUrl;
  const withErrorsId = r.compileId;

  // latexmk had nothing to redo (ok, PDF on disk, nothing rewritten): the
  // document is unchanged, so it is neither stale nor a new run.
  queue.push({ ...good, pdfFresh: false, synctexFresh: false });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, true, 'unchanged document typesets ok');
  eq(r.pdfUrl, withErrors, 'an unchanged document keeps its URL');
  eq(r.pdfStale, undefined, 'and is not stale');
  eq(r.compileId, withErrorsId, 'and keeps its compileId so SyncTeX stays bound');

  // SyncTeX binding: a lookup for a preview from another run is refused
  // before the compiler is asked; the current run's id goes through.
  let sx = await synctexLookup(meta.id, 'main', { direction: 'inverse', page: 1, x: 1, y: 1, compileId: freshId });
  eq(sx.stale, true, 'lookup with an older compileId is stale');
  const before = requests.length;
  queue.push({ ok: true, records: [] });
  sx = await synctexLookup(meta.id, 'main', { direction: 'inverse', page: 1, x: 1, y: 1, compileId: withErrorsId });
  eq(sx.ok, true, 'lookup with the current compileId reaches the compiler');
  eq(requests.length, before + 1, 'exactly one compiler request');
  eq(requests.at(-1).compileId, undefined, 'compileId is not forwarded to the compiler');

  queue.push({ ...fatal });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, false, 'fatal after output');
  eq(r.pdfUrl, withErrors, 'pdfUrl is the last shown one, byte-identical');
  eq(r.pdfStale, true, 'flagged stale');

  queue.push({ ...legacyBad });
  r = await compileProject(meta.id, 'main');
  eq(r.pdfUrl, withErrors, 'a legacy compiler without pdfFresh: failure keeps the last URL');
  eq(r.pdfStale, true, 'still stale');

  // stopOnFirstError: a failing run is truncated, so only ok runs are shown.
  meta.stopOnFirstError = true;
  await store.writeMeta(meta);
  queue.push({ ...errorsFull });
  r = await compileProject(meta.id, 'main');
  eq(requests.at(-1).haltOnError, true, 'the compiler is asked to halt');
  eq(r.pdfUrl, withErrors, 'with stop-on-first-error a failing run keeps the previous PDF');
  eq(r.pdfStale, true, 'and flags it');
  meta.stopOnFirstError = false;
  await store.writeMeta(meta);

  await new Promise((res) => setTimeout(res, 5));
  queue.push({ ...good });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, true, 'recovered');
  check(r.pdfUrl !== withErrors, 'a new success mints a new URL');
  const recovered = r.pdfUrl;
  const recoveredId = r.compileId;

  // latexmk found nothing to redo (ok, PDF on disk, nothing rewritten): the
  // result is this run's under the SAME URL — not stale, no refetch, SyncTeX
  // still bound to the run that wrote the files.
  queue.push({ ...good, pdfFresh: false, synctexFresh: false, log: 'Output written on main.pdf (2 pages, 100 bytes).' });
  r = await compileProject(meta.id, 'main');
  eq(r.ok, true, 'up to date: ok');
  eq(r.pdfUrl, recovered, 'up to date: the same URL');
  eq(r.compileId, recoveredId, 'up to date: the same compileId');
  eq(r.pdfStale, undefined, 'up to date: not stale');
  eq(r.pages, 2, 'up to date: pages from the log latexmk left in place');
  forgetPdfUrls(meta.id);
  queue.push({ ...good, pdfFresh: false, synctexFresh: false });
  r = await compileProject(meta.id, 'main');
  check(typeof r.pdfUrl === 'string' && r.pdfUrl !== recovered, 'up to date after a restart: a URL is minted rather than none');
  eq(r.pdfStale, undefined, 'and it is not stale either');

  // stopOnFirstError: a halted run that got as far as writing the PDF left a
  // torso on disk, and says so; one that halted before touching it does not.
  meta.stopOnFirstError = true;
  await store.writeMeta(meta);
  queue.push({ ...errorsFull });
  r = await compileProject(meta.id, 'main');
  eq(r.pdfStale, true, 'halted after writing: stale');
  eq(r.pdfTruncated, true, 'halted after writing: the file on disk is flagged truncated');
  queue.push({ ...fatal });
  r = await compileProject(meta.id, 'main');
  eq(r.pdfStale, true, 'halted before writing: stale');
  eq(r.pdfTruncated, undefined, 'halted before writing: nothing truncated');
  meta.stopOnFirstError = false;
  await store.writeMeta(meta);

  // Switching the main document: the remembered URL names main.pdf and must
  // not stand in for other.tex, nor, when switching back, the other way round
  // (the "nothing to redo" branch used to hand back whatever URL was remembered).
  meta.rootFile = 'other.tex';
  await store.writeMeta(meta);
  queue.push({ ...good, pdf: '.aldine-out/other.pdf', synctex: '.aldine-out/other.synctex.gz' });
  r = await compileProject(meta.id, 'main');
  check(r.pdfUrl.includes('other.pdf'), `the other document gets its own URL: ${r.pdfUrl}`);
  meta.rootFile = 'main.tex';
  await store.writeMeta(meta);
  queue.push({ ...good, pdfFresh: false, synctexFresh: false });
  r = await compileProject(meta.id, 'main');
  check(r.pdfUrl.includes('main.pdf'), `switching back does not serve the other document: ${r.pdfUrl}`);
  check(r.pdfUrl !== recovered, 'and it is a fresh URL, not the one remembered from before the switch');
  eq(r.pdfStale, undefined, 'not stale: the PDF on disk is this root\'s');

  // The previous PDF is gone from disk (a halted run under stop-on-first-error
  // deletes the output): nothing to show, rather than a URL that 404s.
  queue.push({ ...good });
  r = await compileProject(meta.id, 'main');
  fs.rmSync(pdfOnDisk);
  queue.push({ ...fatal });
  r = await compileProject(meta.id, 'main');
  eq(r.pdfUrl, null, 'no URL to a PDF that no longer exists');
  eq(r.pdfStale, true, 'but the pages a client still shows are flagged as the last successful typeset');
  queue.push({ ...fatal });
  r = await compileProject(meta.id, 'main');
  eq(r.pdfStale, false, 'once forgotten, a further failure has nothing to flag');
} finally {
  await closeDb();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
