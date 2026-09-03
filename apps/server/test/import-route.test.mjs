/**
 * Import and project-settings routes against a throwaway data dir:
 *  - a ZIP entry that escapes the project → 400 and NO project left behind
 *  - a failure after the project exists (file/dir collision) → 400, cleaned up
 *  - a base64 body past the global 32 MB limit is accepted on the import route
 *  - a ZIP over the limit gets the honest size message, not a bare 413
 *  - PATCH engine rejects anything the compiler cannot run
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

const { default: Fastify } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes, IMPORT_MAX_ZIP_BYTES } = await import('../src/routes.ts');
const store = await import('../src/store.ts');

await initDb();
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
await registerRoutes(app);
await app.ready();

const projectIds = async () => (await store.listProjects()).map((m) => m.id).sort();
const importZip = (entries, name = 'T') => app.inject({ method: 'POST', url: '/api/projects/import', payload: { name, zipBase64: buildZip(entries).toString('base64') } });
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
  check(res.json().error.startsWith('Could not import ZIP'), `collision reports the import failure: ${res.json().error}`);
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

  console.log('import route: all checks passed');
} finally {
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
