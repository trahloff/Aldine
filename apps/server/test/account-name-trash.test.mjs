/**
 * Accounts on:
 *  - PATCH /api/auth/me sets the name co-authors see (acct-2); blank is
 *    refused, an access token cannot, and the project list names the owner
 *    by it
 *  - a trashed project tells the people it was open to why it went, the
 *    owner and a co-author each in their own words, and a stranger nothing;
 *    the collab socket refuses it (home-1)
 *  - a sign-up from an invitation's page gets a confirmation link back to
 *    that invitation, and only to one sent to that address (acct-5)
 *
 * Real route table (Fastify inject), no mail transport: confirmation links
 * are read through the test hook. Env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-name-trash-')));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_TEST_HOOKS = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_HOST', 'ALDINE_PUBLIC_URL', 'ALDINE_SSO_ONLY', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH', 'REMOTE_PROVIDERS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const confirmed = async (email, name) => {
  const u = await auth.register(email, 'password123', name);
  await db().setEmailPending(u.id, null);
  return { ...u, cookie: `${auth.COOKIE}=${await auth.createSession(u.id)}` };
};
const send = (method, url, who, payload, headers = {}) => app.inject({ method, url, headers: { ...(who ? { cookie: who.cookie } : {}), ...headers }, ...(payload ? { payload } : {}) });

// ---- the account name ----
const ada = await confirmed('ada@example.com', 'ada42');
let res = await send('PATCH', '/api/auth/me', ada, { name: '  Ada Lovelace  ' });
eq([res.statusCode, res.json().user.name], [200, 'Ada Lovelace'], 'the name is set, trimmed');
eq((await send('GET', '/api/auth/me', ada)).json().user.name, 'Ada Lovelace', 'and is the account\'s from now on');
eq((await send('PATCH', '/api/auth/me', ada, { name: '   ' })).json(), { error: 'Enter a name' }, 'a blank name is refused');
eq((await send('PATCH', '/api/auth/me', ada, { name: 42 })).statusCode, 400, 'so is one that is not text');
res = await send('PATCH', '/api/auth/me', ada, { name: 'x'.repeat(300) });
eq(res.json().user.name.length, auth.NAME_MAX, 'a long one is cut to the longest name an account keeps');
await send('PATCH', '/api/auth/me', ada, { name: 'Ada Lovelace' });
eq((await send('PATCH', '/api/auth/me', null, { name: 'Nobody' })).statusCode, 401, 'signed out, nobody to rename');
const { token } = await auth.createAccessToken(ada.id, 'agent', null, null);
eq((await send('PATCH', '/api/auth/me', null, { name: 'Mallory' }, { authorization: `Bearer ${token}` })).statusCode, 403, 'an access token cannot rename the person');
eq((await auth.getUser(ada.id)).name, 'Ada Lovelace', 'the name stays');

// ---- a trashed project says why to those it was open to ----
const bea = await confirmed('bea@example.com', 'Bea');
const carl = await confirmed('carl@example.com', 'Carl');
const p = await store.createProject('Shared paper', { 'main.tex': '\\documentclass{article}\\begin{document}hi\\end{document}\n' }, ada.id);
await store.writeMeta({ ...(await store.readMeta(p.id)), share: { mode: 'private', collaborators: ['bea@example.com'] } });
eq((await send('GET', '/api/projects', bea)).json().find((r) => r.id === p.id)?.ownerName, 'Ada Lovelace', 'a co-author sees the owner by her new name');
eq((await send('DELETE', `/api/projects/${p.id}`, ada)).statusCode, 200, 'the owner moves it to the trash');
eq((await send('GET', `/api/projects/${p.id}`, bea)).json(), { error: 'The owner moved this project to the trash', code: 'trashed' }, 'the co-author is told why it went');
eq((await send('GET', `/api/projects/${p.id}`, ada)).json(), { error: 'This project is in the trash', code: 'trashed' }, 'the owner, in her own words');
res = await send('GET', `/api/projects/${p.id}`, carl);
eq([res.statusCode, res.json()], [404, { error: 'project not found' }], 'a stranger learns nothing about it');
let refused = null;
try {
  await collab.hocuspocus.hooks('onAuthenticate', { documentName: collab.docName(p.id, 'main', 'main.tex'), requestHeaders: { cookie: bea.cookie }, connection: {} });
} catch (err) { refused = err.message; }
eq(refused, 'project not found', 'the collab socket refuses a trashed project');
eq((await send('POST', `/api/projects/${p.id}/restore`, ada)).statusCode, 200, 'restored');
eq((await send('GET', `/api/projects/${p.id}`, bea)).statusCode, 200, 'the co-author is back in');

// ---- the confirmation link returns to the invitation signed up from ----
res = await send('POST', `/api/projects/${p.id}/invitations`, ada, { to: 'dora@example.com' });
eq(res.statusCode, 200, `Dora is invited (${res.body.slice(0, 160)})`);
const invite = res.json().invitations.find((i) => i.to === 'dora@example.com');
res = await send('POST', '/api/auth/register', null, { email: 'dora@example.com', password: 'password123', name: 'Dora', invite: invite.id });
eq(res.statusCode, 200, 'Dora signs up from the invitation');
const link = (await send('GET', '/api/test/confirmation-link?email=dora@example.com')).json().link;
check(link.startsWith(`/invite/${invite.id}?confirm_email=`), `the confirmation link leads back to the invitation: ${link}`);
const doraCookie = res.headers['set-cookie'];
res = await send('POST', '/api/auth/confirm-email/resend', null, { invite: invite.id }, { cookie: String(Array.isArray(doraCookie) ? doraCookie[0] : doraCookie).split(';')[0] });
eq(res.statusCode, 200, 'a new link, asked from the invitation page');
check((await send('GET', '/api/test/confirmation-link?email=dora@example.com')).json().link.startsWith(`/invite/${invite.id}?confirm_email=`), 'leads back there too');
res = await send('POST', '/api/auth/register', null, { email: 'eve@example.com', password: 'password123', invite: invite.id });
eq(res.statusCode, 200, 'Eve signs up naming Dora\'s invitation');
check((await send('GET', '/api/test/confirmation-link?email=eve@example.com')).json().link.startsWith('/?confirm_email='), 'her link goes to her list: the invitation was not sent to her');

await app.close();
console.log('account-name-trash: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
