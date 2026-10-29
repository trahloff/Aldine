/**
 * The invitation budgets at their defaults, as an instance that sets neither
 * RL_INVITE_BURST nor RL_SHARE_BURST runs them. Sharing with 30 people at
 * once saves all 30 invitations and mails 20 of them, as 1.2.0 did; the
 * rest are reported for the owner to send the link. Past 200 invitations an
 * hour a share request is refused and nothing of it is saved.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-invite-budgets-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
for (const k of ['RL_INVITE_BURST', 'RL_SHARE_BURST', 'RL_REGISTER_BURST', 'DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_USER', 'SMTP_SECURE', 'ALDINE_SSO_ONLY', 'ALDINE_RESET_ECHO', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const sessionOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
const settle = () => new Promise((r) => setTimeout(r, 300));

/** A confirmed account: sign up, follow the mailed link. */
async function signUp(email, name) {
  const before = smtp.mails.length;
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name });
  eq(res.statusCode, 200, `register ${email}`);
  const cookie = sessionOf(res);
  const token = /confirm_email=([A-Za-z0-9_-]+)/.exec(decoded(await smtp.waitFor(before + 1)))[1];
  eq((await call('POST', '/api/auth/confirm-email', cookie, { token })).statusCode, 200, `confirm ${email}`);
  return cookie;
}
const project = async (cookie, name) => (await call('POST', '/api/projects', cookie, { name })).json();
const addresses = (tag, count) => Array.from({ length: count }, (_, i) => `${tag}${String(i + 1).padStart(3, '0')}@example.org`);

// ---- 30 addresses at once: all saved, 20 mailed ----
const owner = await signUp('owner@example.com', 'Owner');
const p = await project(owner, 'Thirty');
const thirty = addresses('p', 30);
let base = smtp.mails.length;
let res = await call('POST', `/api/projects/${p.id}/share`, owner, { mode: 'private', collaborators: thirty });
eq(res.statusCode, 200, 'sharing with 30 people at once is not refused');
let r = res.json();
eq(r.invitations.map((i) => i.to).sort(), thirty, 'all 30 invitations are saved');
eq([r.invited, r.reason], [20, 'limit'], '20 are mailed, the rest over the hourly mail limit');
eq(r.notEmailed, thirty.slice(20), 'and the 10 not mailed are named');
eq(r.invitations.filter((i) => i.emailedAt).length, 20, 'only the mailed invitations say they were');
await smtp.waitFor(base + 20);
await settle();
eq(smtp.mails.length, base + 20, '20 mails went out');
const mailedTo = smtp.mails.slice(base).map((m) => /^To: (.+)$/m.exec(m)?.[1].trim()).sort();
eq(mailedTo, thirty.slice(0, 20), 'to the first 20 addresses');

// ---- the mail limit leaves invitations alone: 200 an hour before a refusal ----
// A project holds 50 people, so 200 invitations take four projects.
const crowd = await signUp('crowd@example.com', 'Crowd');
const started = Date.now();
for (let n = 0; n < 4; n++) {
  const q = await project(crowd, `Crowd ${n}`);
  res = await call('POST', `/api/projects/${q.id}/share`, crowd, { mode: 'private', collaborators: addresses(`c${n}x`, 50) });
  eq(res.statusCode, 200, `invitations ${n * 50 + 1}–${n * 50 + 50} are made`);
  eq(res.json().invitations.length, 50, `all 50 on project ${n + 1}`);
}
const last = await project(crowd, 'Too many');
// The budget refills one invitation every 18 s, so five more are refused
// for as long as the 200 above took under 90 s to make.
const late = [...addresses('late', 4), '0000-0002-1825-0097'];
res = await call('POST', `/api/projects/${last.id}/share`, crowd, { mode: 'link', collaborators: late });
check(Date.now() - started < 90_000, 'the 200 invitations were made within five refill steps');
eq([res.statusCode, res.json().error], [429, 'You can invite at most 200 people an hour, so nothing was saved. Invite fewer people at once, or try again later.'], 'five more past 200 are refused, saying so');
const meta = (await call('GET', `/api/projects/${last.id}`, crowd)).json();
eq(meta.share, { mode: 'private', collaborators: [] }, 'nothing of the refused request is saved, the mode included');
eq((await call('GET', `/api/projects/${last.id}/invitations`, crowd)).json(), [], 'and nobody is invited');

await app.close();
smtp.close();
console.log('invite-budgets-default: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
