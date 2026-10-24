/**
 * The starter main.tex of a project created without a template or files
 * (issue #131):
 *  - the project name reaches \title LaTeX-escaped, so names like
 *    "Results_v2", "R&D notes" and "50% draft" typeset instead of failing
 *    the first compile with stray _, & and % specials
 *  - a request without a name seeds "Untitled project", sentence case
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-default-title-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { default: Fastify } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');

await initDb();
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
await registerRoutes(app);
await app.ready();

const create = (payload) => app.inject({ method: 'POST', url: '/api/projects', payload });
const mainTex = async (id) => (await app.inject({ method: 'GET', url: `/api/projects/${id}/file?branch=main&path=main.tex` })).body;

try {
  for (const [name, escaped] of [
    ['Results_v2', 'Results\\_v2'],
    ['R&D notes', 'R\\&D notes'],
    ['50% draft', '50\\% draft'],
  ]) {
    const res = await create({ name });
    eq(res.statusCode, 200, `${name}: created (${res.body})`);
    const tex = await mainTex(res.json().id);
    check(tex.includes(`\\title{${escaped}}`), `${name}: \\title escapes the name (got ${tex.match(/\\title\{[^}]*\}/)?.[0]})`);
  }

  const res = await create({});
  eq(res.statusCode, 200, `no name: created (${res.body})`);
  const tex = await mainTex(res.json().id);
  check(tex.includes('\\title{Untitled project}'), 'no name: the seeded title is "Untitled project"');

  console.log('default-title: all assertions passed');
} finally {
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
