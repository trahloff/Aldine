/**
 * Saving sharing drops the project's collab sockets only when it lets fewer
 * people in: link sharing turned off, or someone taken off the list. Those
 * clients reconnect and re-authenticate, which is what shuts a revoked
 * person out. Turning link sharing on, inviting, or saving the same share
 * keeps every editor connected.
 *
 * Real route table (Fastify inject), auth on; env is set before any src
 * import. Socket drops are counted at hocuspocus.closeConnections.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-share-reconnect-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_HOST', 'ALDINE_SSO_ONLY', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const collab = await import('../src/collab.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const json = async (method, url, who, payload) => {
  const res = await app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });
  eq(res.statusCode, 200, `${method} ${url} as ${who.name}: ${res.body.slice(0, 200)}`);
  return res.json();
};
async function person(email, name) {
  const user = await auth.register(email, 'password123', name);
  await db().setEmailPending(user.id, null);
  return { name, cookie: `${auth.COOKIE}=${await auth.createSession(user.id)}` };
}
const owner = await person('owner@example.com', 'Olive');
const bob = await person('bob@example.org', 'Bob');
const P = (await json('POST', '/api/projects', owner, { name: 'Reconnects' })).id;

// A loaded document of the project, so that dropping its sockets is observable.
const conn = await collab.hocuspocus.openDirectConnection(collab.docName(P, 'main', 'main.tex'), {});
let drops = 0;
const close = collab.hocuspocus.closeConnections.bind(collab.hocuspocus);
collab.hocuspocus.closeConnections = (name) => { if (name?.startsWith(`${P}::`)) drops++; return close(name); };
const share = (body) => json('POST', `/api/projects/${P}/share`, owner, body);
const dropsFor = async (body) => { const before = drops; await share(body); return drops - before; };

eq(await dropsFor({ mode: 'link' }), 0, 'turning link sharing on keeps editors connected');
eq(await dropsFor({ mode: 'link', collaborators: ['bob@example.org'], previous: [] }), 0, 'inviting someone keeps them connected');
const inv = (await json('GET', '/api/invitations', bob)).find((i) => i.project.id === P);
check(!!inv, 'Bob has an invitation');
await json('POST', `/api/invitations/${inv.id}/accept`, bob);
eq(await dropsFor({ mode: 'link', collaborators: ['bob@example.org'], previous: ['bob@example.org'] }), 0, 'saving the same share keeps them connected');
check(await dropsFor({ mode: 'private' }) > 0, 'turning link sharing off drops the sockets, so link visitors are shut out');
eq(await dropsFor({ mode: 'private' }), 0, 'saving Invite only again drops nothing');
check(await dropsFor({ mode: 'private', collaborators: [], previous: ['bob@example.org'] }) > 0, 'taking someone off the list drops the sockets');

await conn.disconnect();
await app.close();
console.log('share-reconnect: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
