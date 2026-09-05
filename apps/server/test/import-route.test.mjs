/**
 * Import and project-settings routes against a throwaway data dir:
 *  - a ZIP entry that escapes the project → 400 and NO project left behind
 *  - a failure after the project exists (file/dir collision) → 400, cleaned up
 *  - a base64 body past the global 32 MB limit is accepted on the import route
 *  - a ZIP over the limit gets the honest size message, not a bare 413
 *  - multipart/form-data (the web client) and JSON base64 (API clients) both
 *    import; a 60 MB multipart body passes the route's limit
 *  - unsupported method, encrypted entry, ZIP64 and cp437 names via the route
 *  - every failure is one info-level log line with reason, size, entry count
 *  - PATCH engine rejects anything the compiler cannot run
 *  - engine detection: latexmkrc, xepersian root, Latin-1 transcode, reported in the response
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, eq } from './assert.mjs';
import { buildZip } from './zip.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-import-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { default: Fastify, LogController } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes, IMPORT_MAX_ZIP_BYTES } = await import('../src/routes.ts');
const store = await import('../src/store.ts');

await initDb();
const logLines = [];
const logStream = { write: (line) => { logLines.push(JSON.parse(line)); } };
const app = Fastify({ logger: { level: 'info', stream: logStream }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 32 * 1024 * 1024 });
await registerRoutes(app);
await app.ready();

const projectIds = async () => (await store.listProjects()).map((m) => m.id).sort();
const importZip = (entries, name = 'T', opts) => app.inject({ method: 'POST', url: '/api/projects/import', payload: { name, zipBase64: buildZip(entries, opts).toString('base64') } });
const BOUNDARY = '----aldineTestBoundary7d3';
const multipartBody = (zip, name, filename = 'proj.zip') => Buffer.concat([
  ...(name === undefined ? [] : [Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`)]),
  Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="zip"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
  zip,
  Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
]);
const importMultipart = (zip, name, filename) => app.inject({ method: 'POST', url: '/api/projects/import', headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, payload: multipartBody(zip, name, filename) });
/** The one 'ZIP import failed' line written since the last call. */
const lastImportLog = () => {
  const found = logLines.filter((l) => l.msg === 'ZIP import failed');
  logLines.length = 0;
  eq(found.length, 1, 'exactly one import-failure log line');
  return found[0].import;
};
const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';

try {
  // ---- escaping entry: rejected before anything is created ----
  let before = await projectIds();
  let res = await importZip({ 'main.tex': doc, '../evil.tex': 'x' });
  eq(res.statusCode, 400, 'escaping entry → 400');
  check(res.json().error.includes('../evil.tex'), `error names the entry: ${res.json().error}`);
  eq(await projectIds(), before, 'no project created for an escaping entry');
  check(!fs.existsSync(path.join(process.env.DATA_DIR, 'projects')) || fs.readdirSync(path.join(process.env.DATA_DIR, 'projects')).length === 0, 'no repo dir left on disk');

  res = await importZip({ 'main.tex': doc, 'a\\..\\evil.tex': 'x' });
  eq(res.statusCode, 400, 'backslash escape → 400');
  eq(await projectIds(), before, 'no project created for a backslash escape');

  // ---- failure after createProject: binary write collides with a text file ----
  const bin = Buffer.concat([Buffer.from([0, 1, 2, 3]), crypto.randomBytes(64)]);
  res = await importZip({ 'main.tex': doc, 'figs': 'a text file named like the dir', 'figs/plot.png': bin });
  eq(res.statusCode, 400, 'collision → 400');
  check(/both a file and a directory/.test(res.json().error), `collision names the clashing entry: ${res.json().error}`);
  eq(await projectIds(), before, 'half-imported project removed');
  eq(fs.readdirSync(path.join(process.env.DATA_DIR, 'projects')), [], 'orphan repo dir removed');

  // ---- happy path: backslash names, __MACOSX junk, data..csv, nested root ----
  res = await importZip({ '__MACOSX/._main.tex': 'junk', 'paper\\main.tex': doc, 'paper/data..csv': '1,2', 'paper/figs/plot.png': bin });
  eq(res.statusCode, 200, `windows-style archive imports: ${res.body}`);
  const meta = res.json();
  eq(meta.rootFile, 'paper/main.tex', 'root detected from the normalized path');
  const files = store.listFiles(meta.id, 'main').filter((f) => f.type === 'file' && f.path !== '.gitignore').map((f) => f.path).sort();
  eq(files, ['paper/data..csv', 'paper/figs/plot.png', 'paper/main.tex'], 'files placed under normalized paths, junk dropped');
  eq(store.readFile(meta.id, 'main', 'paper/figs/plot.png').equals(bin), true, 'binary written byte-exact');
  before = await projectIds();

  // ---- body past the global limit is accepted on this route ----
  const big = crypto.randomBytes(26 * 1024 * 1024); // base64 ≈ 34.7 MB > 32 MB global bodyLimit
  res = await importZip({ 'main.tex': doc, 'assets/blob.bin': big });
  eq(res.statusCode, 200, `>32 MB base64 body accepted: ${res.statusCode} ${res.body.slice(0, 200)}`);
  eq(store.readFile(res.json().id, 'main', 'assets/blob.bin').length, big.length, 'large asset intact');
  before = await projectIds();

  // ---- over the raw limit: the message states both numbers ----
  res = await importZip({ 'main.tex': doc, 'pad.bin': Buffer.alloc(IMPORT_MAX_ZIP_BYTES) });
  eq(res.statusCode, 413, 'ZIP over the limit → 413');
  eq(res.json().error, 'ZIP is 60 MB; the limit is 60 MB', 'honest size message');
  eq(await projectIds(), before, 'over-limit import created nothing');

  // ---- multipart: the web client's shape ----
  logLines.length = 0;
  res = await importMultipart(buildZip({ 'main.tex': doc, 'figs/plot.png': bin }), 'Multipart paper');
  eq(res.statusCode, 200, `multipart import: ${res.body.slice(0, 200)}`);
  eq(res.json().name, 'Multipart paper', 'name field read from the form');
  eq(res.json().rootFile, 'main.tex', 'root detected on a multipart import');
  eq(store.readFile(res.json().id, 'main', 'figs/plot.png').equals(bin), true, 'multipart binary byte-exact');
  eq(logLines.filter((l) => l.msg === 'ZIP import failed').length, 0, 'a successful import logs no failure line');
  res = await importMultipart(buildZip({ 'main.tex': doc }), undefined, 'thesis-final.zip');
  eq(res.statusCode, 200, 'multipart without a name field');
  eq(res.json().name, 'thesis-final', 'project named after the file');
  res = await app.inject({ method: 'POST', url: '/api/projects/import', headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, payload: Buffer.from('garbage') });
  eq(res.statusCode, 400, 'malformed multipart → 400');
  res = await app.inject({ method: 'POST', url: '/api/projects/import', headers: { 'content-type': 'multipart/form-data' }, payload: Buffer.from('garbage') });
  eq(res.statusCode, 400, 'multipart without a boundary → 400');
  res = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'x' } });
  eq(res.statusCode, 400, 'JSON without zipBase64 → 400');
  check(res.json().error.includes('zipBase64') && res.json().error.includes('multipart'), `error names both body shapes: ${res.json().error}`);
  before = await projectIds();

  // ---- 60 MB multipart: at the limit, accepted ----
  const nearLimit = buildZip({ 'main.tex': doc, 'assets/blob.bin': crypto.randomBytes(IMPORT_MAX_ZIP_BYTES - 4096) });
  check(nearLimit.length <= IMPORT_MAX_ZIP_BYTES && nearLimit.length > IMPORT_MAX_ZIP_BYTES - 4096, `fixture sits just under the limit: ${nearLimit.length}`);
  res = await importMultipart(nearLimit, 'Sixty');
  eq(res.statusCode, 200, `60 MB multipart import accepted: ${res.statusCode} ${res.body.slice(0, 200)}`);
  eq(store.readFile(res.json().id, 'main', 'assets/blob.bin').length, IMPORT_MAX_ZIP_BYTES - 4096, '60 MB asset intact');
  logLines.length = 0;
  res = await importMultipart(buildZip({ 'main.tex': doc, 'pad.bin': Buffer.alloc(IMPORT_MAX_ZIP_BYTES) }), 'Over');
  eq(res.statusCode, 413, 'multipart ZIP over the limit → 413');
  eq(res.json().error, 'ZIP is 60 MB; the limit is 60 MB', 'honest size message on multipart too');
  let logged = lastImportLog();
  eq(logged.reason, 'ZIP is 60 MB; the limit is 60 MB', 'log line carries the reason');
  eq(logged.multipart, true, 'log line says which body shape');
  check(logged.zipBytes > IMPORT_MAX_ZIP_BYTES, `log line carries the zip size: ${logged.zipBytes}`);
  eq(logged.entries, 2, 'log line carries the entry count');
  before = await projectIds();

  // ---- explicit errors through the route, each logged ----
  logLines.length = 0;
  res = await importZip({ 'main.tex': doc, 'figs/plot.pdf': { data: 'BZh9', method: 12 } });
  eq(res.statusCode, 400, 'bzip2 entry → 400');
  eq(res.json().error, 'Could not import ZIP: entry "figs/plot.pdf" uses bzip2 compression (method 12); only store and deflate are supported, so re-zip the files with standard compression', 'bzip2 message');
  logged = lastImportLog();
  eq(logged.entries, 2, 'entry count logged from the directory even though unzip failed');
  eq(logged.multipart, false, 'JSON body shape logged');
  check(!JSON.stringify(logged).includes(doc.slice(0, 20)), 'no file contents in the log');
  res = await importZip({ 'main.tex': { data: 'x', flags: 0x1 } });
  eq(res.statusCode, 400, 'encrypted entry → 400');
  eq(res.json().error, 'Could not import ZIP: entry "main.tex" is password protected (ZipCrypto); remove the password and export the archive again', 'encrypted message');
  lastImportLog();
  res = await importZip({ 'main.tex': doc, '../evil.tex': 'x' });
  eq(lastImportLog().reason, 'ZIP entry "../evil.tex" points outside the project', 'path escape logged with its reason');
  res = await importZip({ '__MACOSX/._x': 'junk' });
  eq(res.statusCode, 400, 'nothing usable → 400');
  eq(lastImportLog().reason, 'ZIP had no usable files', 'empty import logged');
  res = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'x', zipBase64: Buffer.from('not a zip').toString('base64') } });
  eq(res.statusCode, 400, 'not a zip → 400');
  eq(res.json().error, 'Could not import ZIP: not a zip file', 'not-a-zip message');
  eq(lastImportLog().entries, null, 'no directory: entry count null, still logged');
  eq(await projectIds(), before, 'no project left behind by any rejected archive');

  // ---- ZIP64 and legacy names import normally ----
  res = await importZip({ 'paper/main.tex': doc, 'paper/refs.bib': { data: '@book{k}', method: 8 } }, 'Z64', { zip64: true });
  eq(res.statusCode, 200, `ZIP64 archive imports: ${res.body.slice(0, 200)}`);
  eq(res.json().rootFile, 'paper/main.tex', 'ZIP64 root detected');
  const cp437 = Buffer.concat([Buffer.from('r'), Buffer.from([0x82]), Buffer.from('sum'), Buffer.from([0x82]), Buffer.from('.tex')]);
  res = await importZip({ x: { data: doc, nameBytes: cp437 } }, 'CP');
  eq(res.statusCode, 200, 'cp437 archive imports');
  eq(res.json().rootFile, 'résumé.tex', 'cp437 name decoded before root detection');
  eq(store.readFile(res.json().id, 'main', 'résumé.tex').toString(), doc, 'file stored under the decoded name');
  before = await projectIds();

  // ---- engine validation ----
  const id = meta.id;
  res = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { engine: 'latex' } });
  eq(res.statusCode, 400, 'unknown engine → 400');
  check(res.json().error.includes('latex') && res.json().error.includes('lualatex'), `error names the engine and the options: ${res.json().error}`);
  eq((await store.readMeta(id)).engine, 'pdf', 'engine unchanged after a rejected value');
  res = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { engine: '' } });
  eq(res.statusCode, 400, 'empty engine → 400');
  res = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { engine: 'xelatex' } });
  eq(res.statusCode, 200, 'known engine accepted');
  eq((await store.readMeta(id)).engine, 'xelatex', 'engine persisted');
  res = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { name: 'Renamed' } });
  eq(res.statusCode, 200, 'PATCH without engine still works');
  eq((await store.readMeta(id)).engine, 'xelatex', 'engine untouched by a name-only patch');

  // ---- engine detection on import ----
  res = await importZip({ 'latexmkrc': '$pdf_mode = 5;\n', 'main.tex': doc });
  eq(res.statusCode, 200, 'latexmkrc archive imports');
  eq(res.json().engine, 'xelatex', 'engine set from latexmkrc');
  eq(res.json().import, { engine: 'xelatex', engineReason: 'latexmkrc in the archive', transcoded: [] }, 'response says why');
  eq((await store.readMeta(res.json().id)).engine, 'xelatex', 'engine persisted in meta');

  const persian = '\\documentclass{article}\n\\usepackage{xepersian}\n\\begin{document}\nسلام\n\\end{document}\n';
  res = await importZip({ 'main.tex': persian, 'refs.bib': '' });
  eq(res.json().engine, 'xelatex', 'xepersian root selects XeLaTeX');
  eq(res.json().import.engineReason, 'the xepersian package in the main document', 'reason names the package');

  res = await importZip({ 'main.tex': doc });
  eq(res.json().engine, 'pdf', 'plain archive stays on pdflatex');
  eq(res.json().import, { engine: 'pdf', engineReason: null, transcoded: [] }, 'nothing to explain');

  const latin1Doc = Buffer.concat([Buffer.from('\\documentclass{article}\n\\usepackage[latin1]{inputenc}\n\\begin{document}\ncaf'), Buffer.from([0xe9]), Buffer.from('\n\\end{document}\n')]);
  res = await importZip({ 'main.tex': latin1Doc, 'notes.txt': 'plain ascii' });
  eq(res.statusCode, 200, 'Latin-1 archive imports');
  eq(res.json().import.transcoded, ['main.tex'], 'the transcoded file is named');
  const text = store.readFile(res.json().id, 'main', 'main.tex').toString('utf8');
  check(text.includes('café'), `file is UTF-8 on disk: ${JSON.stringify(text)}`);
  check(text.includes('[utf8]{inputenc}'), 'inputenc switched to utf8 with the transcode');

  console.log('import route: all checks passed');
} finally {
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
