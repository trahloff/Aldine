/**
 * The away-review prompt without accounts: there is no user to key a mark on,
 * so the browser supplies one on the query and the POST persists nothing.
 *
 * A separate file from agent-review.test.mjs because auth.ts reads
 * AUTH_ENABLED at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-away-anon-'));
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const project = await store.createProject('Anonymous Away', { 'main.tex': 'Original line.\n' });
const id = project.id;

fs.writeFileSync(path.join(store.branchDir(id, 'main'), 'main.tex'), 'Claude wrote this.\n');
const committed = await gitops.commitPaths(id, 'main', ['main.tex'], 'Rewrite the opening line', 'Claude');
check(committed.committed, 'the agent commit landed');

const activity = async (query = 'branch=main') =>
  (await app.inject({ method: 'GET', url: `/api/projects/${id}/agent-activity?${query}` })).json();

let a = await activity();
eq(a.commitCount, 1, 'one Claude commit with no mark');
check(a.since === null, 'no mark was supplied');

// the client-supplied mark is honoured only because there is no user
const now = new Date().toISOString();
eq((await activity(`branch=main&sinceHead=${a.head}&sinceAt=${encodeURIComponent(now)}`)).commitCount, 0,
  'the browser mark bounds the answer');

// a malformed mark falls back to "no mark" rather than a 400 — a corrupt
// localStorage value must not cost the person the prompt
eq((await activity('branch=main&sinceHead=zzz&sinceAt=not-a-date')).commitCount, 1, 'a malformed mark is ignored');

const res = await app.inject({
  method: 'POST', url: `/api/projects/${id}/agent-activity/seen`,
  payload: { branch: 'main', head: a.head, kind: 'acknowledged' },
});
eq(res.statusCode, 200, 'the POST answers');
eq(res.json(), { ok: true, stored: false }, 'and stores nothing server-side');
eq((await activity()).commitCount, 1, 'a parameterless GET still reports the batch');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('agent-review-anon: ALL PASSED');
