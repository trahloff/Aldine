/**
 * Without accounts there is nobody to invite: sharing mails nobody even with
 * a transport and a public URL, and says so.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from './assert.mjs';
import { startSmtp } from './smtp-mock.mjs';

const smtp = await startSmtp();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-invite-off-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Open' } })).json();
const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/share`, payload: { mode: 'private', collaborators: ['someone@example.org'] } });
eq(res.statusCode, 200, 'sharing saves');
const r = res.json();
eq([r.invited, r.notEmailed, r.reason], [0, ['someone@example.org'], 'accounts-off'], 'nobody is mailed without accounts');
await new Promise((ok) => setTimeout(ok, 300));
eq(smtp.mails.length, 0, 'no mail was sent');

await app.close();
smtp.close();
console.log('invite-mails-off: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
