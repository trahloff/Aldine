/**
 * The starter main.tex of a project created without a template: the project
 * name is typeset as prose, so LaTeX specials in it are escaped and the first
 * typeset does not stop on "Missing $ inserted" and friends.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-title-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { default: Fastify } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');

await initDb();
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
await registerRoutes(app);
await app.ready();

try {
  for (const [name, title] of [
    ['Results_v2', 'Results\\_v2'],
    ['R&D notes', 'R\\&D notes'],
    ['50% draft', '50\\% draft'],
    ['Plain name', 'Plain name'],
  ]) {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
    eq(res.statusCode, 200, `create "${name}": ${res.body}`);
    const main = store.readFile(res.json().id, 'main', 'main.tex').toString('utf8');
    check(main.includes(`\\title{${title}}`), `"${name}" is typeset as ${title}; main.tex has:\n${main}`);
  }
  console.log('default-title: ok');
} finally {
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
