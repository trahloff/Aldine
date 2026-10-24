/**
 * Showcase projects (ALDINE_PROTECTED_PROJECTS) refuse every write however
 * the project id is spelled in the URL: the router decodes a percent-encoded
 * id before it picks the route, so the guard must decide on the decoded
 * parameter and the matched route, as the handler sees them. Typesetting and
 * SyncTeX stay open. Auth is off, as on the public demo, where this guard is
 * the only write protection.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore. COMPILER_URL points at a port nothing listens on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-showcase-'));
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.COMPILER_URL = 'http://127.0.0.1:9';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const { protectedProjects } = await import('../src/collab.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const showcase = await store.createProject('Showcase', { 'main.tex': doc });
const ordinary = await store.createProject('Mine', { 'main.tex': doc });
// The guard is installed when the set is non-empty at registration time.
protectedProjects.add(showcase.id);
const app = Fastify();
await registerRoutes(app);

const hex = (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
const spellings = [
  ['plain', showcase.id],
  ['first character encoded', hex(showcase.id[0]) + showcase.id.slice(1)],
  ['every character encoded', [...showcase.id].map(hex).join('')],
  ['upper-case escape', hex(showcase.id[0]).toUpperCase() + showcase.id.slice(1)],
];
const mainTex = path.join(store.repoDir(showcase.id), 'main.tex');
const refused = (res, label) => {
  eq(res.statusCode, 403, `${label} → 403`);
  check(/read-only showcase/.test(res.json().error), `${label} names the showcase rule: ${res.body}`);
};

try {
  for (const [how, id] of spellings) {
    const base = `/api/projects/${id}`;
    refused(await app.inject({ method: 'PUT', url: `${base}/file`, payload: { path: 'main.tex', content: 'defaced' } }), `PUT file, id ${how}`);
    refused(await app.inject({ method: 'DELETE', url: `${base}/file?path=main.tex` }), `DELETE file, id ${how}`);
    refused(await app.inject({ method: 'POST', url: `${base}/file/rename`, payload: { from: 'main.tex', to: 'x.tex' } }), `rename, id ${how}`);
    refused(await app.inject({ method: 'POST', url: `${base}/branches`, payload: { name: 'b' } }), `create branch, id ${how}`);
    refused(await app.inject({ method: 'PATCH', url: base, payload: { name: 'Renamed' } }), `PATCH project, id ${how}`);
    refused(await app.inject({ method: 'DELETE', url: base }), `DELETE project, id ${how}`);
    refused(await app.inject({ method: 'POST', url: `${base}/comments`, payload: { file: 'main.tex', anchor: { from: 0, to: 4, quote: '\\doc' }, body: 'x' } }), `comment, id ${how}`);

    const read = await app.inject({ method: 'GET', url: `${base}/file?path=main.tex` });
    eq(read.statusCode, 200, `reading, id ${how} → 200`);
    for (const tail of ['compile', 'synctex']) {
      const res = await app.inject({ method: 'POST', url: `${base}/${tail}`, payload: { branch: 'main' } });
      check(!/read-only showcase/.test(res.body), `${tail}, id ${how}, is not refused by the showcase rule: ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
  }
  eq(fs.readFileSync(mainTex, 'utf8'), doc, 'the showcase main.tex is untouched');
  check(fs.existsSync(path.join(store.repoDir(showcase.id), '.git', 'HEAD')), 'the showcase repository is intact');
  eq((await store.readMeta(showcase.id)).name, 'Showcase', 'the showcase keeps its name');
  check(!(await store.readMeta(showcase.id)).deletedAt, 'the showcase is not in the trash');

  const res = await app.inject({ method: 'PUT', url: `/api/projects/${ordinary.id}/file`, payload: { path: 'main.tex', content: 'mine' } });
  eq(res.statusCode, 200, 'an ordinary project still takes writes');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('showcase-guard: all assertions passed');
process.exit(0);
