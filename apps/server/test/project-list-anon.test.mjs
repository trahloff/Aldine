/**
 * The project list without accounts: one implicit person, who owns every
 * project, so every row is the owner's, opens are kept under one id, and
 * there is nothing to remove from the list. On a showcase project
 * (ALDINE_PROTECTED_PROJECTS) the routes that touch only the visitor's own
 * list or make the visitor's own copy stay open while every write is refused.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore. COMPILER_URL points at a port nothing listens on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-project-list-anon-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.COMPILER_URL = 'http://127.0.0.1:9';
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const { initDb, db, closeDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const { protectedProjects } = await import('../src/collab.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const showcase = await store.createProject('Showcase', { 'main.tex': doc });
protectedProjects.add(showcase.id);
const app = Fastify();
await registerRoutes(app);
const send = (method, url, payload) => app.inject({ method, url, payload });

try {
  const p = (await send('POST', '/api/projects', { name: 'Mine', files: { 'main.tex': doc } })).json();
  const rows = (await send('GET', '/api/projects')).json();
  const mine = rows.find((r) => r.id === p.id);
  eq(mine.access, 'owner', 'without accounts the one person owns every project');
  eq([mine.lastEdit.byId, mine.lastEdit.byName, mine.lastEdit.branch], [null, null, 'main'], 'a write without accounts names nobody');
  eq(rows.find((r) => r.id === showcase.id).access, 'owner', 'the showcase too');

  const opened = await send('POST', `/api/projects/${p.id}/opened`, { branch: 'main' });
  eq(opened.statusCode, 200, 'an open is recorded');
  eq((await db().getProjectOpen('local', p.id))?.branch, 'main', 'under the one implicit person');
  eq((await send('GET', '/api/projects')).json().find((r) => r.id === p.id).opened.branch, 'main', 'and shows on the row');
  eq((await send('DELETE', `/api/projects/${p.id}/listing`)).statusCode, 400, 'there is nobody but the owner to remove it from a list');

  // ---- showcase: own list and own copy yes, writes no ----
  eq((await send('PUT', `/api/projects/${showcase.id}/file`, { path: 'main.tex', content: 'changed' })).statusCode, 403, 'the showcase refuses a write');
  eq((await send('POST', `/api/projects/${showcase.id}/opened`, { branch: 'main' })).statusCode, 200, 'but records an open');
  const copy = await send('POST', `/api/projects/${showcase.id}/copy`, {});
  eq(copy.statusCode, 200, 'and makes a copy');
  eq(copy.json().name, 'Showcase copy', 'named after it');
  check(!protectedProjects.has(copy.json().id), 'the copy is an ordinary project');
  eq((await send('PUT', `/api/projects/${copy.json().id}/file`, { path: 'main.tex', content: 'mine now' })).statusCode, 200, 'that takes writes');
  eq(fs.readFileSync(path.join(store.repoDir(showcase.id), 'main.tex'), 'utf8'), doc, 'the showcase is unchanged');
  console.log('✓ project list without accounts, and on a showcase');
} finally {
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
