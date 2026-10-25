/**
 * A password sign-up proves its address before the address grants anything:
 * invites by email and ALDINE_ADMIN_EMAILS skip the account until it follows
 * the one-time link mailed at sign-up (or logged, without a transport), and
 * apply from then on. Confirming takes the session of that account; a resend
 * replaces the link; a link expires; a completed password reset proves the
 * address too, except under ALDINE_RESET_ECHO=1. Accounts without the marker
 * (every account from before it, every single sign-on account) count as
 * confirmed.
 *
 * Real route table (Fastify inject), real SMTP backend against a local
 * listener; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { startSmtp, readable, decoded } from './smtp-mock.mjs';

const smtp = await startSmtp();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-confirm-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.ALDINE_ADMIN_EMAILS = 'root@example.org';
process.env.RL_REGISTER_BURST = '200';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const sessionOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
const linkToken = (mail) => {
  const m = /https:\/\/aldine\.test\/\?confirm_email=([A-Za-z0-9_-]+)/.exec(decoded(mail));
  check(m, 'the mail carries a confirmation link');
  return m[1];
};
async function signUp(email, name) {
  const before = smtp.mails.length;
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name });
  eq(res.statusCode, 200, `register ${email}`);
  const mail = await smtp.waitFor(before + 1);
  check(readable(mail).includes(`To: ${email}`), `the confirmation mail goes to ${email}`);
  const token = linkToken(mail);
  check(!res.body.includes(token), `the sign-up response for ${email} does not carry the link's secret`);
  return { cookie: sessionOf(res), id: res.json().user.id, user: res.json().user, token };
}
const listed = async (cookie, id) => (await call('GET', '/api/projects', cookie)).json().some((p) => p.id === id);

// ---- a sign-up starts pending, and still uses its own projects ----
const alice = await signUp('alice@example.com', 'Alice');
eq(alice.user.emailPending, true, 'a password sign-up starts with its address pending');
const me = (await call('GET', '/api/auth/me', alice.cookie)).json();
eq(me.user.emailPending, true, '/api/auth/me reports the pending address');
eq(me.sendsEmail, true, '/api/auth/me reports that links go out by mail');
const project = (await call('POST', '/api/projects', alice.cookie, { name: 'Secret paper' })).json();
check(project.id, 'a pending account creates projects of its own');
eq((await call('GET', `/api/projects/${project.id}`, alice.cookie)).statusCode, 200, 'and opens them');
eq((await call('POST', `/api/projects/${project.id}/share`, alice.cookie, { mode: 'private', collaborators: ['bob@uni.example'] })).statusCode, 200, 'and shares them');

// ---- whoever registers the invited address first sees nothing until confirmed ----
const bob = await signUp('bob@uni.example', 'Bob');
eq((await call('GET', `/api/projects/${project.id}`, bob.cookie)).statusCode, 403, 'a pending invitee cannot open the shared project');
check(!(await listed(bob.cookie, project.id)), 'nor does it list it');
eq((await call('GET', `/api/projects/${project.id}/file?branch=main&path=main.tex`, bob.cookie)).statusCode, 403, 'nor read its files');
eq((await call('POST', `/api/projects/${project.id}/opened`, bob.cookie, { branch: 'main' })).statusCode, 403, 'nor put it on its list by opening it');
eq((await call('POST', `/api/projects/${project.id}/copy`, bob.cookie, {})).statusCode, 403, 'nor duplicate it');
await db().setProjectOpen({ userId: bob.id, projectId: project.id, at: new Date().toISOString(), branch: 'main', hidden: false });
check(!(await listed(bob.cookie, project.id)), 'an open row of its own does not list it either');

// ---- confirming takes that account's session and the current link ----
eq((await call('POST', '/api/auth/confirm-email', null, { token: bob.token })).statusCode, 401, 'confirming signed out is refused');
const elsewhere = await call('POST', '/api/auth/confirm-email', alice.cookie, { token: bob.token });
eq(elsewhere.statusCode, 400, "another account's session cannot use the link");
check(/belongs to another account/.test(elsewhere.json().error), 'the refusal says why');
check((await db().getUser(bob.id)).emailPending, 'the address stays pending after that attempt');
eq((await call('POST', '/api/auth/confirm-email', bob.cookie, { token: 'x'.repeat(32) })).statusCode, 400, 'a wrong token is refused');
eq((await call('POST', '/api/auth/confirm-email', bob.cookie, {})).statusCode, 400, 'a missing token is refused');
const confirmed = await call('POST', '/api/auth/confirm-email', bob.cookie, { token: bob.token });
eq(confirmed.statusCode, 200, 'the right session with the link confirms');
eq(confirmed.json().user.emailPending, undefined, 'the response says the address is confirmed');
check(!(await db().getUser(bob.id)).emailPending, 'the marker is gone from the store');
eq((await call('GET', `/api/projects/${project.id}`, bob.cookie)).statusCode, 200, 'the invite applies once confirmed');
check(await listed(bob.cookie, project.id), 'and the project is listed');
eq((await call('POST', '/api/auth/confirm-email', bob.cookie, { token: bob.token })).statusCode, 200, 'confirming again is not an error');
eq((await call('POST', '/api/auth/confirm-email/resend', bob.cookie)).json(), { ok: true, confirmed: true }, 'a confirmed account gets no new link');

// ---- ALDINE_ADMIN_EMAILS skips a pending account; a resend replaces the link ----
const root = await signUp('root@example.org', 'Root');
eq((await call('GET', '/api/auth/me', root.cookie)).json().admin, false, 'a pending address on the admin list is not an admin');
eq((await call('GET', '/api/admin/stats', root.cookie)).statusCode, 403, 'nor reaches the admin routes');
const mailsBefore = smtp.mails.length;
const resent = await call('POST', '/api/auth/confirm-email/resend', root.cookie);
eq(resent.json(), { ok: true, sent: true }, 'a resend mails a new link');
const newToken = linkToken(await smtp.waitFor(mailsBefore + 1));
check(newToken !== root.token, 'the new link is a different one');
check(readable(smtp.mails[mailsBefore]).includes('Confirm your email address'), 'the resent mail asks to confirm');
eq((await call('POST', '/api/auth/confirm-email', root.cookie, { token: root.token })).statusCode, 400, 'the replaced link no longer works');
eq((await call('POST', '/api/auth/confirm-email', root.cookie, { token: newToken })).statusCode, 200, 'the new one does');
eq((await call('GET', '/api/auth/me', root.cookie)).json().admin, true, 'once confirmed the admin list applies');
eq((await call('GET', '/api/admin/stats', root.cookie)).statusCode, 200, 'and the admin routes open');
const rows = (await call('GET', '/api/admin/users', root.cookie)).json();
eq(rows.find((r) => r.email === 'alice@example.com').emailPending, true, 'the admin page lists a pending address as such');
eq(rows.find((r) => r.email === 'root@example.org').emailPending, false, 'and a confirmed one as confirmed');

// ---- resends are limited per account ----
const carol = await signUp('carol@example.com', 'Carol');
const carolMails = smtp.mails.length;
const resendCodes = [];
for (let i = 0; i < 4; i++) resendCodes.push((await call('POST', '/api/auth/confirm-email/resend', carol.cookie)).statusCode);
eq(resendCodes, [200, 200, 200, 429], 'three new links per account, then a wait');
await smtp.waitFor(carolMails + 3);

// ---- a link expires ----
const dora = await signUp('dora@example.com', 'Dora');
const stale = (await db().getUser(dora.id)).emailPending;
await db().setEmailPending(dora.id, { ...stale, expiresAt: new Date(Date.now() - 1000).toISOString() });
eq((await call('POST', '/api/auth/confirm-email', dora.cookie, { token: dora.token })).statusCode, 400, 'an expired link is refused');
check((await db().getUser(dora.id)).emailPending, 'and the address stays pending');

// ---- a completed password reset proves the address, except with ALDINE_RESET_ECHO=1 ----
const reset = async (who) => {
  const r = await auth.requestReset(who);
  eq((await call('POST', '/api/auth/reset', null, { token: r.token, newPassword: 'another-password-1' })).statusCode, 200, `reset for ${who}`);
};
await reset('dora@example.com');
check(!(await db().getUser(dora.id)).emailPending, 'a completed reset confirms the address');
const erin = await signUp('erin@example.com', 'Erin');
process.env.ALDINE_RESET_ECHO = '1';
await reset('erin@example.com');
delete process.env.ALDINE_RESET_ECHO;
check((await db().getUser(erin.id)).emailPending, 'with ALDINE_RESET_ECHO=1 a reset proves nothing');

// ---- accounts without the marker count as confirmed ----
await db().createUser({ id: 'legacy-frank', email: 'frank@example.com', name: 'Frank', salt: 's', hash: 'h', createdAt: '2026-01-01T00:00:00.000Z' });
const frank = `${auth.COOKIE}=${await auth.createSession('legacy-frank')}`;
await call('POST', `/api/projects/${project.id}/share`, alice.cookie, { mode: 'private', collaborators: ['bob@uni.example', 'frank@example.com', 'gina@example.com'] });
eq((await call('GET', `/api/projects/${project.id}`, frank)).statusCode, 200, 'an account from before the marker is matched by its address');
const gina = await auth.register('gina@example.com', '', 'Gina', 'github', 'github:42');
check(!gina.emailPending && !(await db().getUser(gina.id)).emailPending, 'a single sign-on account has no marker');
const ginaCookie = `${auth.COOKIE}=${await auth.createSession(gina.id)}`;
eq((await call('GET', `/api/projects/${project.id}`, ginaCookie)).statusCode, 200, 'and is matched by its address');

// ---- without a transport the link is logged for the operator ----
delete process.env.SMTP_HOST;
const logged = [];
const log = console.log;
console.log = (...a) => { logged.push(a.join(' ')); };
const henry = await call('POST', '/api/auth/register', null, { email: 'henry@example.com', password: 'password123' });
const henryResend = await call('POST', '/api/auth/confirm-email/resend', sessionOf(henry));
const henryMe = (await call('GET', '/api/auth/me', sessionOf(henry))).json();
console.log = log;
eq(henry.statusCode, 200, 'sign-up works without a transport');
const lines = logged.filter((l) => l.includes('email confirmation for henry@example.com'));
eq(lines.length, 2, 'the sign-up and the resend each log a link');
const m = /https:\/\/aldine\.test\/\?confirm_email=([A-Za-z0-9_-]+)/.exec(lines[1]);
check(m, 'the logged line holds the full link');
eq(henryResend.json(), { ok: true, sent: false }, 'the resend says the link was not mailed');
eq(henryMe.sendsEmail, false, '/api/auth/me says links are not mailed');
eq((await call('POST', '/api/auth/confirm-email', sessionOf(henry), { token: m[1] })).statusCode, 200, 'the logged link confirms');

await app.close();
smtp.close();
console.log('email-confirmation: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
