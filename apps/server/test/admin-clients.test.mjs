/**
 * Assistant clients on the admin page: the list names every client that is
 * registered here or holds a live consent, with how many consents are live;
 * removing one ends its access for every account at once and deletes the
 * registration, and leaves other clients and hand-made tokens alone. The
 * routes share the admin guard.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-admin-clients-')));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_ADMIN_EMAILS = 'root@example.org';
process.env.RL_REGISTER_BURST = '200';
process.env.RL_ADMIN_BURST = '200';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SMTP_HOST', 'SES_FROM', 'ALDINE_PUBLIC_URL', 'ALDINE_SSO_ONLY', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH', 'ALDINE_OAUTH_REGISTRATION']) delete process.env[k];

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };

const { initDb, closeDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { authenticateMcp } = await import('../src/mcp/guards.ts');
const { issueCode } = await import('../src/oauth/codes.ts');
const { exchangeCode, refreshTokens } = await import('../src/oauth/token.ts');
const { registerClient } = await import('../src/oauth/register.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const cookieOf = (res) => [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${auth.COOKIE}=`));
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload !== undefined ? { payload } : {}) });
async function signUp(email, name) {
  const res = await call('POST', '/api/auth/register', null, { email, password: 'password123', name });
  eq(res.statusCode, 200, `register ${email}`);
  await db().setEmailPending(res.json().user.id, null);
  return { cookie: cookieOf(res), id: res.json().user.id, email };
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const live = async (token) => (await authenticateMcp(`Bearer ${token}`, undefined)) !== null;

const ISSUER = 'https://aldine.test';
/** A consent for `userId` given to `client`, exchanged the way a client does. */
async function consent(userId, client) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = issueCode({ clientId: client.id, clientName: client.name, redirectUri: client.redirect, codeChallenge: challenge, resource: null, scope: 'projects', userId, projectIds: null });
  return exchangeCode(ISSUER, { code, client_id: client.id, redirect_uri: client.redirect, code_verifier: verifier });
}

const root = await signUp('root@example.org', 'Root');
const bob = await signUp('bob@example.org', 'Bob');
const carol = await signUp('carol@example.org', 'Carol');
const clients = async () => (await call('GET', '/api/admin/clients', root.cookie)).json();
const remove = (cookie, id, headers) => call('POST', '/api/admin/clients/remove', cookie, { id }, headers);

try {
  // ---- nothing connected yet ----
  eq(await clients(), { registration: 'open', clients: [] }, 'an instance nobody connected to lists nothing');

  // ---- two registered clients and one named by its metadata document ----
  const gpt = await registerClient({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.example/cb', 'https://chatgpt.example/cb2', 'http://127.0.0.1/cb'] });
  const idle = await registerClient({ client_name: 'Never used', redirect_uris: ['https://idle.example/cb'] });
  const GPT = { id: gpt.client_id, name: 'ChatGPT', redirect: 'https://chatgpt.example/cb' };
  const DOC = { id: 'https://code.example/oauth/client.json', name: 'Claude Code', redirect: 'http://127.0.0.1/cb' };

  const bobGpt = await consent(bob.id, GPT);
  const carolGpt = await consent(carol.id, GPT);
  const bobDoc = await consent(bob.id, DOC);
  const { token: bobPat } = await auth.createAccessToken(bob.id, 'my script', null, null);
  // a rotation is still one connection
  const carolGpt2 = await refreshTokens(ISSUER, { refresh_token: carolGpt.refresh_token, client_id: GPT.id });
  for (const t of [bobGpt.access_token, carolGpt2.access_token, bobDoc.access_token, bobPat]) check(await live(t), 'every credential works before anything is removed');

  // ---- the guard ----
  eq((await call('GET', '/api/admin/clients', null)).statusCode, 401, 'the list needs a session');
  eq((await call('GET', '/api/admin/clients', bob.cookie)).statusCode, 403, 'and an administrator');
  eq((await remove(bob.cookie, GPT.id)).statusCode, 403, 'someone else cannot remove a client');
  eq((await call('GET', '/api/admin/clients', null, undefined, bearer(bobPat))).statusCode, 403, 'an access token cannot read the list');
  const { token: rootPat } = await auth.createAccessToken(root.id, 'root script', null, null);
  eq((await remove(null, GPT.id, bearer(rootPat))).statusCode, 403, 'not even the administrator\'s own token removes a client');
  eq((await app.inject({ method: 'POST', url: '/api/admin/clients/remove', headers: { cookie: root.cookie, 'content-type': 'text/plain' }, payload: JSON.stringify({ id: GPT.id }) })).statusCode, 415, 'a body that is not JSON is refused');
  check(await live(bobGpt.access_token), 'none of that ended a connection');

  // ---- the list ----
  let list = await clients();
  eq(list.registration, 'open', 'the list says how clients may register');
  const byName = (n) => list.clients.find((c) => c.name === n);
  eq([byName('ChatGPT').id, byName('ChatGPT').kind, byName('ChatGPT').hosts, byName('ChatGPT').connections], [GPT.id, 'registered', ['chatgpt.example', '127.0.0.1'], 2], 'a registered client: its hosts once each, one connection per person');
  check(!!byName('ChatGPT').createdAt && !!byName('ChatGPT').lastUsedAt, 'with when it was registered and last used');
  eq([byName('Never used').kind, byName('Never used').connections], ['registered', 0], 'a registration nobody approved shows with no connections');
  eq([byName('Claude Code').id, byName('Claude Code').kind, byName('Claude Code').hosts, byName('Claude Code').connections, byName('Claude Code').createdAt], [DOC.id, 'metadata', ['code.example'], 1, null], 'a metadata client shows by its connections, with the document host');
  eq(list.clients.length, 3, 'hand-made tokens are not clients');
  check(!JSON.stringify(list).includes('bob@example.org') && !JSON.stringify(list).includes(bob.id), 'the list names no account');

  // ---- removing a registered client ----
  eq((await remove(root.cookie, 'aldc_doesnotexist0000000')).statusCode, 404, 'an unknown client is refused');
  eq((await remove(root.cookie, undefined)).statusCode, 404, 'so is a missing id');
  let res = await remove(root.cookie, GPT.id);
  eq([res.statusCode, res.json()], [200, { ok: true, removed: true, connections: 2 }], 'removing answers what it ended');
  check(!(await live(bobGpt.access_token)) && !(await live(carolGpt2.access_token)), 'every account\'s access through that client ends at once');
  let dead = await refreshTokens(ISSUER, { refresh_token: carolGpt2.refresh_token, client_id: GPT.id }).then(() => null, (e) => e);
  check(dead !== null, 'and the refresh token no longer renews it');
  check((await db().getOAuthClient(GPT.id)) === null, 'the registration is deleted');
  check(await live(bobDoc.access_token), 'another client\'s connection for the same person stays');
  check(await live(bobPat), 'and so does a hand-made token');
  check(logs.some((l) => l.startsWith('[aldine] admin ') && l.includes('removed assistant client "ChatGPT"') && l.includes('2 connections ended')), 'the removal is logged with who did it');
  list = await clients();
  eq(list.clients.map((c) => c.name).sort(), ['Claude Code', 'Never used'], 'the list no longer shows it');
  eq((await remove(root.cookie, GPT.id)).statusCode, 404, 'removing it twice finds nothing');

  // ---- removing a metadata client: nothing stored, the connections end ----
  res = await remove(root.cookie, DOC.id);
  eq([res.statusCode, res.json()], [200, { ok: true, removed: false, connections: 1 }], 'a metadata client has no registration to delete');
  check(!(await live(bobDoc.access_token)), 'its connections end all the same');
  check(await live(bobPat), 'the hand-made token still works');

  // ---- a registration with no connections ----
  res = await remove(root.cookie, idle.client_id);
  eq(res.json(), { ok: true, removed: true, connections: 0 }, 'an unused registration is simply deleted');
  eq((await clients()).clients, [], 'and the list is empty again');

  // ---- a registration that went away while its consents live ----
  const lru = await registerClient({ client_name: 'Evicted', redirect_uris: ['https://lru.example/cb'] });
  const LRU = { id: lru.client_id, name: 'Evicted', redirect: 'https://lru.example/cb' };
  const carolLru = await consent(carol.id, LRU);
  await db().deleteOAuthClient(LRU.id);
  list = await clients();
  eq([list.clients[0].id, list.clients[0].kind, list.clients[0].hosts, list.clients[0].connections], [LRU.id, 'removed', [], 1], 'a client whose registration is gone still shows while a consent is live');
  eq((await remove(root.cookie, LRU.id)).json(), { ok: true, removed: false, connections: 1 }, 'and can be ended from the list');
  check(!(await live(carolLru.access_token)), 'which ends the connection');

  // ---- closed registration is reported ----
  process.env.ALDINE_OAUTH_REGISTRATION = 'closed';
  eq((await clients()).registration, 'closed', 'the list reports closed registration');
} finally {
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log = realLog;
console.log('Admin clients: ALL PASSED');
process.exit(0);
