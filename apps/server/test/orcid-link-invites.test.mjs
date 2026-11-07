/**
 * A password account that connected ORCID (Sign-in methods) is reached by
 * invitations to that ORCID iD, as an ORCID account is: one that waited
 * before the connect, and one sent after it. Disconnecting ORCID ends the
 * matching: a new invitation to the iD no longer reaches the account, and
 * neither does a project shared with the iD. /admin lists every way an
 * account signs in.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-orcid-link-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.RL_INVITE_BURST = '100';
process.env.ALDINE_ADMIN_EMAILS = 'admin@example.com';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_SSO_ONLY', 'ALDINE_SIGNUP', 'ALDINE_BASE_PATH', 'ALDINE_PUBLIC_URL', 'SMTP_HOST', 'SES_FROM']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>Aldine</title>\n');

const IID = '0000-0002-1825-0097';
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/oauth/token') {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      if (form.get('code') !== 'ria') return json(400, { error_description: 'invalid code' });
      json(200, { access_token: 'tok', orcid: IID, name: 'Ria Researcher', scope: '/authenticate' });
    });
    return;
  }
  if (url.pathname.startsWith('/v3.0/')) return json(200, { email: [] });
  json(404, {});
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;
Object.assign(process.env, { ORCID_CLIENT_ID: 'cid', ORCID_CLIENT_SECRET: 'sec', ORCID_API_BASE: base, ORCID_PUB_API_BASE: base });

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

let ip = 0;
const call = (method, url, cookie, payload) => app.inject({ method, url, remoteAddress: `10.7.0.${1 + (ip++ % 250)}`, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
const cookieValue = (res, name) => {
  const c = [res.headers['set-cookie'] ?? []].flat().find((s) => s.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};
async function signUp(email) {
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name: email.split('@')[0] });
  eq(res.statusCode, 200, `sign-up ${email} (${res.body})`);
  return `aldine_session=${cookieValue(res, 'aldine_session')}`;
}
async function project(owner, name) {
  const res = await call('POST', '/api/projects', owner, { name });
  eq(res.statusCode, 200, `create ${name} (${res.body.slice(0, 200)})`);
  return res.json().id;
}
async function invite(owner, projectId) {
  const res = await call('POST', `/api/projects/${projectId}/invitations`, owner, { to: IID });
  eq(res.statusCode, 200, `invite the iD to ${projectId} (${res.body.slice(0, 200)})`);
}
const waiting = async (who) => (await call('GET', '/api/invitations', who)).json().map((i) => i.project.id);

const owner = await signUp('admin@example.com');
await db().setEmailPending((await db().findUserByEmail('admin@example.com')).id, null); // an administrator by confirmed address
const ria = await signUp('ria@example.com');
const before = await project(owner, 'Before the connect');
await invite(owner, before);
eq(await waiting(ria), [], 'an invitation to the iD does not reach a password account without ORCID');

// ---- connect ORCID ----
{
  const start = await call('POST', '/api/auth/sign-in-methods/orcid', ria, {});
  eq(start.statusCode, 200, `connect starts (${start.body})`);
  const state = cookieValue(start, 'aldine_oauth_state');
  const s = new URL(start.json().url).searchParams.get('state');
  const cb = await call('GET', `/api/auth/oauth/orcid/callback?code=ria&state=${s}`, `${ria}; aldine_oauth_state=${state}`);
  eq(cb.statusCode, 302, `ORCID connects (${cb.body})`);
  eq((await call('GET', '/api/auth/me', ria)).json().user.orcid, IID, 'the account carries the connected iD');
}

// ---- the invitation that waited, and one sent after ----
{
  eq(await waiting(ria), [before], 'the invitation that waited reaches the account now');
  const after = await project(owner, 'After the connect');
  await invite(owner, after);
  eq((await waiting(ria)).sort(), [before, after].sort(), 'and one sent after the connect');
  const mine = (await call('GET', '/api/invitations', ria)).json();
  for (const inv of mine) eq((await call('POST', `/api/invitations/${inv.id}/accept`, ria)).statusCode, 200, `accept ${inv.project.id}`);
  eq((await call('GET', `/api/projects/${before}`, ria)).statusCode, 200, 'accepting gives access');
  check((await call('GET', '/api/projects', ria)).json().some((p) => p.id === after), 'and lists the project');
}

// ---- /admin lists every way to sign in ----
{
  const users = (await call('GET', '/api/admin/users', owner)).json();
  eq(users.find((u) => u.email === 'ria@example.com').signInMethods, ['Password', 'ORCID'], 'password and the connected provider');
  eq(users.find((u) => u.email === 'ria@example.com').signIn, 'Password', 'signIn stays as it was');
  eq(users.find((u) => u.email === 'admin@example.com').signInMethods, ['Password'], 'an account without connections: password only');
}

// ---- disconnect ----
{
  eq((await call('DELETE', '/api/auth/sign-in-methods/orcid', ria)).statusCode, 200, 'ORCID disconnects');
  check(!(await call('GET', '/api/auth/me', ria)).json().user.orcid, 'the account no longer carries the iD');
  const later = await project(owner, 'After the disconnect');
  await invite(owner, later);
  eq(await waiting(ria), [], 'a new invitation to the iD no longer reaches the account');
  eq((await call('GET', `/api/projects/${before}`, ria)).statusCode, 403, 'and a project shared with the iD no longer opens for it');
  eq((await call('GET', '/api/admin/users', owner)).json().find((u) => u.email === 'ria@example.com').signInMethods, ['Password'], '/admin shows the password only again');
}

await app.close();
stub.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ ORCID link invitations: all passed');
