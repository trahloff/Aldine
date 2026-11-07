/**
 * Typesetting in the browser (ALDINE_TYPESET=browser), server side:
 *
 * - A snapshot names the root file, engine and every file of the checkout
 *   with a change key, and reserves the run's id; the files come from the
 *   ordinary file route.
 * - /api/typeset/parse reads a log as the compiler would, for a run the
 *   browser only shows.
 * - A published run finishes as a compiler run would: output in .aldine-out,
 *   the PDF served, rows parsed from the log, a thumbnail written, under the
 *   reserved id; a failed one keeps the previous PDF (pdfStale).
 * - A run nobody's browser asked for (POST /compile, an agent's) waits for a
 *   tab to claim it, and fails with a sentence when none does; stop ends it.
 *
 * Real routes on a throwaway datastore, auth off; the browser is this test.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-browsertex-jobs-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
process.env.ALDINE_TYPESET = 'browser';
process.env.ALDINE_BROWSER_CLAIM_MS = '400';
process.env.COMPILER_URL = 'http://127.0.0.1:9';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

// A one-file "build", baked, so no download happens.
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const baked = path.join(tmp, 'baked');
fs.mkdirSync(path.join(baked, 't1'), { recursive: true });
const files = { 'busytex_worker.js': 'w', 'busytex.wasm': 'wasm', 'tl.js': 'js', 'tl.data': 'data', 'LICENSE': 'agpl' };
for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(baked, 't1', k), v);
fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({
  version: 't1', texlive: '2026', baseUrl: 'http://127.0.0.1:9/',
  files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { sha256: sha(v), size: v.length }])),
  core: ['busytex_worker.js', 'busytex.wasm'], profiles: { recommended: ['tl.js', 'tl.data'] }, biber: [], licenses: ['LICENSE'],
}));
process.env.ALDINE_BROWSER_TEX_MANIFEST = path.join(tmp, 'manifest.json');
process.env.ALDINE_BROWSER_TEX_DIR = baked;

const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const { compileProject } = await import('../src/compile.ts');
const { browserTexAssets } = await import('../src/browsertex/build.ts');
const { encodeBundle, BUNDLE_TYPE } = await import('../src/browsertex/bundle.ts');
await browserTexAssets().ready();

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const main = fs.readFileSync(path.join(here, '..', '..', 'web', 'src', 'browsertex', '__tests__', 'fixtures', 'main.tex'), 'utf8');
const ch1 = fs.readFileSync(path.join(here, '..', '..', 'web', 'src', 'browsertex', '__tests__', 'fixtures', 'ch1.tex'), 'utf8');
const synctex = fs.readFileSync(path.join(here, '..', '..', 'web', 'src', 'browsertex', '__tests__', 'fixtures', 'main.synctex.gz'));
const p = await store.createProject('Browser', { 'paper/main.tex': main, 'paper/chapters/ch1.tex': ch1, 'paper/fig.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
await store.writeMeta({ ...(await store.readMeta(p.id)), rootFile: 'paper/main.tex' });
const pdf = Buffer.from('%PDF-1.5\n% a stand-in the server only checks the header of\n');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const log = 'This is pdfTeX\n(./main.tex\n(./chapters/ch1.tex\n! Undefined control sequence.\nl.2 Text \\bogus\n                from the chapter\n)\n\\openout1 = `main.aux\'.\n)\nOutput written on main.pdf (2 pages, 29060 bytes).\n';

const post = (url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });

try {
  // ---- /api/typeset tells the browser what to load ----
  const info = (await app.inject({ method: 'GET', url: '/api/typeset' })).json();
  eq({ mode: info.mode, base: info.assets.base, bundle: info.assets.bundle, state: info.state }, { mode: 'browser', base: '/browser-tex/t1/', bundle: 'tl.js', state: 'ready' }, 'the build is announced');
  const wasm = await app.inject({ method: 'GET', url: '/browser-tex/t1/busytex.wasm' });
  eq([wasm.statusCode, wasm.headers['content-type'], wasm.body], [200, 'application/wasm', 'wasm'], 'the wasm is served with its type');
  check(/immutable/.test(wasm.headers['cache-control']), 'and cached for good');
  eq((await app.inject({ method: 'GET', url: '/browser-tex/t1/manifest.json' })).statusCode, 404, 'only build files are served');
  eq((await app.inject({ method: 'GET', url: '/browser-tex/t0/busytex.wasm' })).statusCode, 404, 'only the current build is served');

  // ---- a snapshot of the branch ----
  const snap = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/compile/snapshot?branch=main` })).json();
  eq({ rootFile: snap.rootFile, engine: snap.engine, haltOnError: snap.haltOnError }, { rootFile: 'paper/main.tex', engine: 'pdf', haltOnError: false }, 'the snapshot says what to typeset');
  eq(snap.files.map((f) => f.path).sort(), ['.gitignore', 'paper/chapters/ch1.tex', 'paper/fig.png', 'paper/main.tex'], 'every file of the checkout, none of git\'s');
  check(typeof snap.runId === 'number', 'and reserves the run\'s id');
  const file = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/file?branch=main&path=paper/fig.png` });
  eq(file.rawPayload.length, 4, 'files come from the file route, bytes intact');

  // ---- a run the browser only shows is read like the compiler reads it ----
  const parsed = (await post('/api/typeset/parse', { log, rootFile: 'paper/main.tex', exitCode: 0, pdf: true })).json();
  const row0 = parsed.errors.find((e) => e.type === 'error');
  eq(row0 && { file: row0.file, line: row0.line }, { file: 'paper/chapters/ch1.tex', line: 2 }, 'rows are project-relative');
  eq([parsed.ok, parsed.pages], [true, 2], 'with the verdict and page count');
  eq((await post('/api/typeset/parse', { log: '', rootFile: 'main.tex', exitCode: 1, pdf: false })).json().errors.length, 1, 'a run with nothing in its log still says it failed');

  // ---- a published run ----
  const publish = (meta, entries) => post(`/api/projects/${p.id}/compile/publish`, encodeBundle([['meta', Buffer.from(JSON.stringify(meta))], ...entries.map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)])]), { 'content-type': BUNDLE_TYPE });
  const res = await publish({ branch: 'main', rootFile: snap.rootFile, runId: snap.runId, exitCode: 0, durationMs: 1234, thumb: { w: 512, h: 663 } }, [['pdf', pdf], ['synctex', synctex], ['log', log], ['thumb', jpeg]]);
  eq(res.statusCode, 200, `the publish is accepted (${res.body.slice(0, 200)})`);
  const r = res.json();
  eq({ ok: r.ok, pdf: r.pdf, pages: r.pages, durationMs: r.durationMs, runId: r.runId }, { ok: true, pdf: 'paper/.aldine-out/main.pdf', pages: 2, durationMs: 1234, runId: snap.runId }, 'it finishes as a compiler run would, under the reserved id');
  check(typeof r.pdfUrl === 'string' && r.pdfUrl.includes('/output?'), 'the result links the PDF');
  eq((await app.inject({ method: 'GET', url: r.pdfUrl })).body, pdf.toString('latin1'), 'the published PDF is served');
  eq((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/output?branch=main&path=paper/.aldine-out/main.synctex.gz` })).rawPayload.length, synctex.length, 'its SyncTeX is served for tabs that adopt it');
  const thumb = JSON.parse(fs.readFileSync(path.join(store.branchDir(p.id, 'main'), 'paper', '.aldine-out', '.main.thumb.json'), 'utf8'));
  eq({ w: thumb.w, h: thumb.h }, { w: 512, h: 663 }, 'the thumbnail sidecar is written');
  const status = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/compile-status?branch=main` })).json();
  eq(status.result?.runId, snap.runId, 'tabs without TeX adopt it from compile-status');
  const reused = (await publish({ branch: 'main', rootFile: snap.rootFile, runId: snap.runId, exitCode: 0 }, [['pdf', pdf], ['log', log]])).json();
  check(reused.runId > snap.runId, 'a reserved id serves one run; a client cannot pick ids');

  // ---- a failed run keeps the previous PDF ----
  const s2 = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/compile/snapshot?branch=main` })).json();
  const failed = (await publish({ branch: 'main', rootFile: s2.rootFile, runId: s2.runId, exitCode: 1 }, [['log', '(./main.tex\n! LaTeX Error: File `nope.sty\' not found.\n\nl.3 \\usepackage{nope}\n)\n']])).json();
  eq({ ok: failed.ok, pdfStale: failed.pdfStale, pdfUrl: failed.pdfUrl }, { ok: false, pdfStale: true, pdfUrl: reused.pdfUrl }, 'the previous PDF stays, marked stale');
  check(failed.errors.some((e) => /nope\.sty/.test(e.message)), 'the error says why');

  // ---- a run nobody's browser asked for waits for a tab ----
  const apiRun = post(`/api/projects/${p.id}/compile`, { branch: 'main' });
  await new Promise((r) => setTimeout(r, 50));
  const claimed = (await post(`/api/projects/${p.id}/compile/jobs/claim`, { branch: 'main' })).json();
  check(claimed.job?.id && claimed.job.rootFile === 'paper/main.tex', 'an open tab claims the run POST /compile asked for');
  eq((await post(`/api/projects/${p.id}/compile/jobs/claim`, { branch: 'main' })).statusCode, 404, 'only once');
  const viaTab = (await publish({ jobId: claimed.job.id, exitCode: 0 }, [['pdf', pdf], ['log', log]])).json();
  const apiResult = (await apiRun).json();
  eq([apiResult.ok, apiResult.runId], [true, viaTab.runId], 'the caller gets the run the tab made');
  eq((await publish({ jobId: claimed.job.id, exitCode: 0 }, [['pdf', pdf]])).statusCode, 410, 'a job takes one upload');

  // ---- stop ends a waiting run ----
  const agentRun = compileProject(p.id, 'main', { agent: true });
  await new Promise((r) => setTimeout(r, 20));
  const j3 = (await post(`/api/projects/${p.id}/compile/jobs/claim`, { branch: 'main' })).json().job;
  eq((await post(`/api/projects/${p.id}/compile/stop`, { branch: 'main' })).statusCode, 200, 'stop is accepted');
  eq((await agentRun).stopped, true, 'the waiting run ends stopped');
  eq((await publish({ jobId: j3.id, exitCode: 0 }, [['pdf', pdf]])).statusCode, 410, 'its upload is refused');

  // The claim timeout is unref'd (a server's listener keeps it alive); so does this.
  const alive = setInterval(() => {}, 1000);
  const unclaimed = await compileProject(p.id, 'main', { agent: true });
  clearInterval(alive);
  eq(unclaimed.ok, false, 'with no tab the run fails');
  check(/Open the project in a browser/.test(unclaimed.error), `and says what to do (got ${unclaimed.error})`);

  console.log('browsertex-jobs: all checks passed');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  // Pending claim timers are unref'd, but collab keeps handles open.
  process.exit();
}
