/**
 * The admin page's password reset on a server that sends email: the account
 * gets the same mail the forgot-password form sends, with a link built from
 * ALDINE_PUBLIC_URL, and the administrator never sees the link. Another
 * administrator's account may be reset this way, since the mail reaches
 * only its owner.
 *
 * Real route table (Fastify inject), real SMTP backend against a local
 * listener; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { startSmtp, decoded } from './smtp-mock.mjs';

const smtp = await startSmtp();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-admin-reset-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_ADMIN_EMAILS = 'root@example.org,second@example.org';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test/write';
process.env.RL_REGISTER_BURST = '200';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_TEST_HOOKS', 'ALDINE_BASE_PATH']) delete process.env[k];

const { initDb, closeDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const cookieOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
async function signUp(email, name) {
  const before = smtp.mails.length;
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name });
  eq(res.statusCode, 200, `register ${email}`);
  await smtp.waitFor(before + 1); // the confirmation mail
  await db().setEmailPending(res.json().user.id, null);
  return { cookie: cookieOf(res), id: res.json().user.id };
}

try {
  const root = await signUp('root@example.org', 'Root');
  const bob = await signUp('bob@example.org', 'Bob');
  const second = await signUp('second@example.org', 'Second');

  const before = smtp.mails.length;
  const res = await call('POST', `/api/admin/users/${bob.id}/reset-link`, root.cookie, {});
  eq(res.statusCode, 200, 'the administrator sends Bob a reset email');
  eq(res.json(), { sent: true, to: 'bob@example.org' }, 'the answer names the address, not the link');
  const mail = decoded(await smtp.waitFor(before + 1));
  check(/^To: bob@example\.org/m.test(mail), 'the mail goes to Bob');
  check(mail.includes('Reset your Aldine password'), 'it is the usual reset mail');
  const token = /https:\/\/aldine\.test\/write\/\?reset_token=([A-Za-z0-9_-]+)/.exec(mail)?.[1];
  check(token, 'with a link on the configured public URL');
  eq((await call('POST', '/api/auth/reset', null, { token, newPassword: 'fresh-password' })).statusCode, 200, 'the mailed link resets the password');
  eq((await call('POST', '/api/auth/login', null, { email: 'bob@example.org', password: 'fresh-password' })).statusCode, 200, 'Bob signs in with the new one');

  const other = await call('POST', `/api/admin/users/${second.id}/reset-link`, root.cookie, {});
  eq([other.statusCode, other.json().sent], [200, true], 'another administrator gets the mail too: only they can follow it');
  await smtp.waitFor(before + 2);
  console.log('✓ admin reset mail: the usual mail, the public URL, never the link in the answer');
} finally {
  await app.close();
  await closeDb();
  smtp.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
