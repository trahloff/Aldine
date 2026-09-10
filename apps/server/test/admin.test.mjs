/**
 * Instance admin: the allow-list guard, the stats and users routes, and the
 * activity heartbeat.
 *  - signed-out → 401, signed-in non-admin → 403, admin → 200
 *  - the email comparison is case-insensitive
 *  - stats count accounts, active users by lastSeenAt, projects by owner
 *  - the heartbeat is throttled and never blocks the request
 *  - /api/auth/me reports `admin` so the client can show the page
 *
 * Env must be set before any src import — AUTH_ENABLED and the admin list
 * are read at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-admin-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_ADMIN_EMAILS = ' Root@Example.org ,second@example.org';
process.env.RL_REGISTER_BURST = '200';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { default: Fastify } = await import('fastify');
const { initDb, closeDb, db } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { resetActivityThrottle } = await import('../src/admin.ts');

await initDb();
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const cookieOf = (res) => String(res.headers['set-cookie']).split(';')[0];
async function signUp(email, name) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123', name } });
  eq(res.statusCode, 200, `register ${email}`);
  return { cookie: cookieOf(res), id: res.json().user.id };
}
const get = (url, cookie) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

// ---- guard ----
eq((await get('/api/admin/stats')).statusCode, 401, 'signed out → 401');
const bob = await signUp('bob@example.org', 'Bob');
const denied = await get('/api/admin/stats', bob.cookie);
eq(denied.statusCode, 403, 'non-admin → 403');
eq(denied.json().error, 'Administrator access required', 'non-admin error names the requirement');
eq((await get('/api/admin/users', bob.cookie)).statusCode, 403, 'users route shares the guard');
eq((await get('/api/auth/me', bob.cookie)).json().admin, false, 'me: admin false for Bob');

const root = await signUp('root@example.org', 'Root'); // allow-list has "Root@Example.org"
eq((await get('/api/auth/me', root.cookie)).json().admin, true, 'me: admin true, case-insensitive');

// ---- stats ----
await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: root.cookie }, payload: { name: 'Live' } });
const trashed = (await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: root.cookie }, payload: { name: 'Gone' } })).json();
eq((await app.inject({ method: 'DELETE', url: `/api/projects/${trashed.id}`, headers: { cookie: root.cookie } })).statusCode, 200, 'trash a project');

const stats = (await get('/api/admin/stats', root.cookie)).json();
eq(stats.users.total, 2, 'stats: two accounts');
eq(stats.users.active7d, 2, 'stats: both made a request since signing up');
eq(stats.users.active30d, 2, 'stats: active30d');
eq(stats.users.onlineNow, 0, 'stats: no collab sockets');
eq(stats.projects, { total: 1, trashed: 1 }, 'stats: live and trashed projects');
eq(stats.admins, ['root@example.org', 'second@example.org'], 'stats: allow-list, normalised');
check(/^\d{4}-\d{2}$/.test(stats.compile.month), 'stats: month key');
eq(stats.compile.metering, false, 'stats: metering off by default');

// ---- users ----
const users = (await get('/api/admin/users', root.cookie)).json();
eq(users.map((u) => u.email), ['bob@example.org', 'root@example.org'], 'users: oldest first');
const rootRow = users.find((u) => u.id === root.id);
eq(rootRow.admin, true, 'users: admin flag');
eq(rootRow.projects, 1, 'users: owned projects exclude trash');
check(typeof rootRow.lastSeenAt === 'string', 'users: lastSeenAt present');
check(!('hash' in rootRow) && !('salt' in rootRow), 'users: no credential material');

// ---- heartbeat ----
// A user who never signed in again keeps the old timestamp within the window...
const stale = '2026-01-01T00:00:00.000Z';
await db().touchUser(bob.id, stale);
await get('/api/projects', bob.cookie);
eq((await db().getUser(bob.id)).lastSeenAt, stale, 'heartbeat: throttled within the window');
// ...and is counted inactive; once the throttle lapses, the next request touches.
eq((await get('/api/admin/stats', root.cookie)).json().users.active30d, 1, 'stats: stale user is inactive');
resetActivityThrottle();
await get('/api/projects', bob.cookie);
await new Promise((r) => setTimeout(r, 20)); // the touch is fire-and-forget
check((await db().getUser(bob.id)).lastSeenAt > stale, 'heartbeat: touches after the window');
eq((await get('/api/admin/stats', root.cookie)).json().users.active30d, 2, 'stats: active again');

await app.close();
await closeDb();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ admin: guard, stats, users, heartbeat');
