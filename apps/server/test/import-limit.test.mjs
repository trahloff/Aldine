/**
 * ALDINE_IMPORT_MAX_MB (#423): the ZIP import limit an operator sets.
 *  - the setting as read: unset, a valid figure, and everything that is not
 *    one (each named in a warning, never silently another limit)
 *  - a server started with 75: a 64 MB archive imports, a 76 MB one gets the
 *    message with both numbers, and /api/auth/me tells the web app the limit
 *  - the unpacked allowance follows the limit and never drops below 200 MB
 *
 * The limit is read once at import of the module, so env is set before any
 * src import and one process tests one limit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, eq } from './assert.mjs';
import { buildZip } from './zip.mjs';

const MB = 1024 * 1024;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-import-limit-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_IMPORT_MAX_MB = '75';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'AUTH_ENABLED', 'ALDINE_STORAGE_QUOTA_MB']) delete process.env[k];

const { importLimit, proxyBodyMb, IMPORT_LIMIT } = await import('../src/importlimit.ts');

// ---- the setting as read ----
let l = importLimit({});
eq(l.mb, 60, 'unset: 60 MB');
eq(l.zipBytes, 60 * MB, 'unset: 60 MB in bytes');
eq(l.unpackedBytes, 200 * MB, 'unset: 200 MB unpacked, as before the setting existed');
eq(l.warning, null, 'unset: nothing to warn about');
eq(proxyBodyMb(l), 81, 'unset: a proxy has to allow 81 MB, the figure deploy/nginx.conf carries');

l = importLimit({ ALDINE_IMPORT_MAX_MB: ' 100 ' });
eq(l.mb, 100, 'a figure with spaces around it');
eq(l.unpackedBytes, 300 * MB, 'the unpacked allowance is three times the limit once that passes 200 MB');
eq(proxyBodyMb(l), 135, '100 MB base64-encoded plus 1 MB, rounded up');
eq(l.warning, null, 'a valid figure: no warning');

eq(importLimit({ ALDINE_IMPORT_MAX_MB: '1' }).unpackedBytes, 200 * MB, 'a small limit keeps the 200 MB unpacked allowance');

for (const bad of ['0', '-5', '1.5', 'inf', 'Infinity', '60MB', 'abc']) {
  l = importLimit({ ALDINE_IMPORT_MAX_MB: bad });
  eq(l.mb, 60, `"${bad}" is not a limit: 60 MB stays`);
  check(l.warning?.includes(`"${bad}"`) && l.warning.includes('60 MB'), `"${bad}" is named in a warning: ${l.warning}`);
}
l = importLimit({ ALDINE_IMPORT_MAX_MB: '5000' });
eq(l.mb, 1024, 'above the ceiling: the ceiling');
check(l.warning?.includes('5000') && l.warning.includes('1024 MB'), `and a warning says so: ${l.warning}`);

// ---- a server started with 75 ----
eq(IMPORT_LIMIT.mb, 75, 'setup: this process runs with 75 MB');
const { default: Fastify, LogController } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes, IMPORT_MAX_ZIP_BYTES } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
await initDb();
const app = Fastify({ logger: false, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 32 * MB });
await registerRoutes(app);
await app.ready();

const BOUNDARY = '----aldineLimitBoundary4c1';
const importMultipart = (zip, name) => app.inject({
  method: 'POST', url: '/api/projects/import', headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  payload: Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="zip"; filename="p.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]),
});
const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';

try {
  eq(IMPORT_MAX_ZIP_BYTES, 75 * MB, 'the route enforces the configured limit');
  let res = await app.inject({ method: 'GET', url: '/api/auth/me' });
  eq(res.json().importMaxMb, 75, '/api/auth/me tells the web app the limit');

  // past the 60 MB every server had before, inside the 75 set here
  const figures = crypto.randomBytes(64 * MB);
  res = await importMultipart(buildZip({ 'main.tex': doc, 'figures/all.bin': figures }), 'Sixty-four');
  eq(res.statusCode, 200, `a 64 MB archive imports: ${res.statusCode} ${res.body.slice(0, 200)}`);
  check(store.readFile(res.json().id, 'main', 'figures/all.bin').equals(figures), 'and its file arrives byte for byte');

  const before = (await store.listProjects()).length;
  res = await importMultipart(buildZip({ 'main.tex': doc, 'pad.bin': Buffer.alloc(76 * MB) }), 'Over');
  eq(res.statusCode, 413, 'a 76 MB archive → 413');
  eq(res.json().error, 'ZIP is 76 MB; the limit is 75 MB', 'with the size and the configured limit');
  eq((await store.listProjects()).length, before, 'and no project left behind');

  // the base64 shape API clients send needs the body limit to follow as well
  res = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'JSON', zipBase64: buildZip({ 'main.tex': doc, 'figures/all.bin': figures }).toString('base64') } });
  eq(res.statusCode, 200, `the same archive as base64 in JSON imports: ${res.statusCode} ${res.body.slice(0, 200)}`);

  // ---- the unpacked allowance ----
  const { unzip } = await import('../src/unzip.ts');
  const packed = buildZip({ 'a.txt': { data: Buffer.alloc(3 * MB), method: 8 }, 'b.txt': { data: Buffer.alloc(3 * MB), method: 8 } });
  eq(Object.keys(unzip(packed)).length, 2, 'unzip without an allowance keeps its 200 MB one');
  let message = '';
  try { unzip(packed, { maxTotalBytes: 4 * MB }); } catch (err) { message = err.message; }
  check(message.includes('unpacks past the 4 MB total limit'), `an archive past the allowance names it: ${message}`);
} finally {
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('import-limit: ok');
process.exit(0);
