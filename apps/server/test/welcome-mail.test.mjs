/**
 * The welcome mail (with the confirmation link) goes to an address nobody
 * confirmed, so the only part of the sign-up request in it is that address:
 * a name (text, markup or a link) would make the instance send the signer's
 * own message, under its own branding, to anyone.
 *
 * Real register route (Fastify inject) and the real SMTP backend, against a
 * minimal SMTP listener on a free local port; env is set before any src
 * import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { startSmtp, readable } from './smtp-mock.mjs';

const smtp = await startSmtp();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-welcome-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);

const name = 'Mallory <a href="https://evil.example/reset">Reset your password</a>';
const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'someone@example.com', password: 'password123', name } });
eq(res.statusCode, 200, 'sign-up succeeds');
eq(res.json().user.name, name, 'the account keeps the name it was given');

const text = readable(await smtp.waitFor(1));
eq(smtp.mails.length, 1, 'one sign-up mail was sent');
check(/Welcome to Aldine/.test(text) && /https:\/\/aldine\.test\/\?confirm_email=[A-Za-z0-9_-]{20,}/.test(text), 'the mail is the welcome mail with the confirmation link');
check(text.includes('someone@example.com'), 'the mail is addressed to the sign-up address');
for (const part of ['evil.example', 'Reset your password', 'Mallory']) {
  check(!text.includes(part), `the mail carries nothing of the name (found ${JSON.stringify(part)})`);
}

await app.close();
smtp.close();
console.log('welcome-mail: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
