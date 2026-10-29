/**
 * Without ALDINE_PUBLIC_URL (and so without invitation mail) the owner still
 * gets an invitation link to copy: built from the request's origin, under
 * the base path the app is served at.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-invite-links-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_BASE_PATH = '/internal/aldine';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['ALDINE_PUBLIC_URL', 'DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_HOST', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const owner = await auth.register('owner@example.com', 'password123', 'Owner');
await db().setEmailPending(owner.id, null);
const headers = { cookie: `${auth.COOKIE}=${await auth.createSession(owner.id)}`, host: 'lan.example:8080' };
const project = (await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Paper' } })).json();
const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/share`, headers, payload: { mode: 'private', collaborators: ['ada@example.org'] } });
eq(res.statusCode, 200, 'sharing saves');
const r = res.json();
eq([r.invited, r.notEmailed, r.reason], [0, ['ada@example.org'], 'no-mail'], 'nothing is mailed without a public URL');
const [inv] = r.invitations;
eq(inv.link, `http://lan.example:8080/internal/aldine/invite/${inv.id}`, 'the copy link is on the request origin, under the base path');
const viaProxy = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/invitations`, headers: { ...headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'aldine.example.org' } })).json();
eq(viaProxy[0].link, `https://aldine.example.org/internal/aldine/invite/${inv.id}`, 'and on the proxy\'s origin behind one');

await app.close();
console.log('invite-links: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
