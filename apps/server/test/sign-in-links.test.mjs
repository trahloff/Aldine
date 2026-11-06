/**
 * Sign-in methods: a password account connects a single sign-on identity
 * (Account settings) and can then sign in either way. Through buildApp()
 * against the mock OIDC provider, restricted to one group: connecting binds
 * the provider's subject to the account, signing in with it opens that
 * account, an identity another account has is refused, the last way to sign
 * in stays, and a session older than ten minutes needs the password again.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq, throws } from './assert.mjs';
import { createMockOidc } from '../../../e2e/auth-tests/mock-oidc.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-sign-in-links-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_SSO_ONLY', 'ALDINE_SIGNUP', 'ALDINE_BASE_PATH', 'ALDINE_PUBLIC_URL']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>Aldine</title>\n');

const mock = await createMockOidc().listen();
Object.assign(process.env, { OIDC_ISSUER: mock.issuer, OIDC_CLIENT_ID: 'aldine-e2e', OIDC_CLIENT_SECRET: 'aldine-e2e-secret', OIDC_ALLOWED_GROUPS: 'aldine' });

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const auth = await import('../src/auth.ts');
const app = await buildApp();

let ip = 0;
const addr = () => `10.8.0.${1 + (ip++ % 250)}`;
const inject = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, remoteAddress: addr(), headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload ? { payload } : {}) });
const cookieValue = (res, name) => {
  const c = [res.headers['set-cookie'] ?? []].flat().find((s) => s.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};

mock.addPersona({ code: 'ada', sub: 'ada-1', claims: { name: 'Ada Lovelace', email: 'ada.idp@example.org', email_verified: true, groups: ['aldine'] } });
mock.addPersona({ code: 'bob', sub: 'bob-1', claims: { name: 'Bob', email: 'bob@example.org', email_verified: true, groups: ['aldine'] } });
mock.addPersona({ code: 'eve', sub: 'eve-1', claims: { name: 'Eve', email: 'eve@example.org', email_verified: true, groups: ['other'] } });
mock.addPersona({ code: 'pat', sub: 'pat-1', claims: { name: 'Pat', email: 'pat@example.org', email_verified: true, groups: ['aldine'] } });

async function signUp(email) {
  const res = await inject('POST', '/api/auth/register', null, { email, password: 'password123', name: email.split('@')[0] });
  eq(res.statusCode, 200, `sign-up ${email} (${res.body})`);
  return { id: res.json().user.id, sid: cookieValue(res, 'aldine_session') };
}
const sessionCookie = (sid) => `aldine_session=${sid}`;

/** The IdP's redirect back for `persona`, after `start` (a 302 to the IdP or a connect's URL). */
async function atIdp(url, persona) {
  const loc = new URL(url);
  loc.searchParams.set('persona', persona);
  const idp = await fetch(loc, { redirect: 'manual' });
  eq(idp.status, 302, 'IdP redirects back');
  return new URL(idp.headers.get('location')).search;
}

/** Connect `persona` to the account of `sid`; the callback's response. */
async function connect(sid, persona, body) {
  const start = await inject('POST', '/api/auth/sign-in-methods/oidc', sessionCookie(sid), body ?? {});
  eq(start.statusCode, 200, `connect starts (${start.body})`);
  const state = cookieValue(start, 'aldine_oauth_state');
  eq(state.split('.')[3], 'link', 'the state cookie names the purpose');
  const query = await atIdp(start.json().url, persona);
  return inject('GET', `/api/auth/oauth/oidc/callback${query}`, `${sessionCookie(sid)}; aldine_oauth_state=${state}`);
}

/** Sign in with `persona` from a browser without a session. */
async function oidcSignIn(persona) {
  const start = await inject('GET', '/api/auth/oauth/oidc');
  eq(start.statusCode, 302, 'sign-in starts');
  const state = cookieValue(start, 'aldine_oauth_state');
  const query = await atIdp(start.headers.location, persona);
  return inject('GET', `/api/auth/oauth/oidc/callback${query}`, `aldine_oauth_state=${state}`);
}
const me = async (sid) => (await inject('GET', '/api/auth/me', sessionCookie(sid))).json().user;
const methods = async (sid) => (await inject('GET', '/api/auth/sign-in-methods', sessionCookie(sid))).json();

const ada = await signUp('ada@example.com');

// ---- the list before anything is connected ----
{
  const m = await methods(ada.sid);
  eq({ password: m.password, provider: m.provider, links: m.links, canConnect: m.canConnect, recent: m.recent }, { password: true, provider: null, links: [], canConnect: true, recent: true }, 'a fresh password account: password only, may connect, session recent');
  eq(m.providers, [{ id: 'oidc', label: 'Single sign-on' }], 'the configured providers are offered');
  eq((await inject('GET', '/api/auth/sign-in-methods')).statusCode, 401, 'signed out: 401');
  eq((await inject('POST', '/api/auth/sign-in-methods/google', sessionCookie(ada.sid), {})).statusCode, 404, 'an unconfigured provider cannot be connected');
}

// ---- before connecting, the address rule still refuses ----
{
  mock.addPersona({ code: 'ada-mail', sub: 'ada-mail-1', claims: { name: 'Ada', email: 'ada@example.com', email_verified: true, groups: ['aldine'] } });
  const res = await oidcSignIn('ada-mail');
  eq(res.statusCode, 400, 'an identity with the password account\'s address does not sign in to it');
  check(res.json().error.includes('sign in with your password'), `and says to use the password (${res.body})`);
}

// ---- connect, then sign in with it ----
{
  const res = await connect(ada.sid, 'ada');
  eq(res.statusCode, 302, `the callback connects (${res.body})`);
  eq(res.headers.location, '/?account=sign-in&connected=oidc', 'and returns to Account settings');
  check(!cookieValue(res, 'aldine_session'), 'connecting issues no new session');
  check([res.headers['set-cookie']].flat().some((c) => c.startsWith('aldine_oauth_state=;')), 'the state cookie is cleared');
  const m = await methods(ada.sid);
  eq(m.links.map((l) => [l.provider, l.label, l.configured]), [['oidc', 'Single sign-on', true]], 'the identity is listed');
  const link = await db().findSignInLink((await db().listSignInLinks(ada.id))[0].subject);
  check(link.subject.startsWith('oidc:') && link.subject.endsWith(':ada-1'), `keyed by the issuer-bound subject, not the address (${link.subject})`);

  const signIn = await oidcSignIn('ada');
  eq(signIn.statusCode, 302, `signing in with the identity works (${signIn.body})`);
  const sid = cookieValue(signIn, 'aldine_session');
  eq((await me(sid)).id, ada.id, 'and opens the password account');
  eq((await me(sid)).email, 'ada@example.com', 'whose address stays its own, not the IdP\'s');
  const pw = await inject('POST', '/api/auth/login', null, { email: 'ada@example.com', password: 'password123' });
  eq(pw.statusCode, 200, 'the password still signs in too');

  const again = await connect(ada.sid, 'ada');
  eq(again.statusCode, 302, 'connecting the same identity again is not an error');
  const other = await connect(ada.sid, 'pat');
  eq(other.statusCode, 409, 'a second identity at the same provider is refused');
  check(other.json().error.includes('Disconnect that one first'), `and says what to do (${other.body})`);
}

// ---- an identity another account has is refused ----
{
  const ben = await signUp('ben@example.com');
  const taken = await connect(ben.sid, 'ada');
  eq(taken.statusCode, 409, 'an identity connected to another account is refused');
  eq(taken.json().error, 'This Single sign-on account already signs in to another account on this server, so it cannot be connected to yours.', 'in a plain sentence');
  const bob = await oidcSignIn('bob');
  eq(bob.statusCode, 302, 'bob has an account of his own, created by single sign-on');
  const own = await connect(ben.sid, 'bob');
  eq(own.statusCode, 409, 'an identity that is an account of its own is refused');
  eq((await methods(ben.sid)).links, [], 'nothing was connected');

  // A single sign-on account does not connect another provider.
  const bobSid = cookieValue(bob, 'aldine_session');
  const bobStart = await inject('POST', '/api/auth/sign-in-methods/oidc', sessionCookie(bobSid), {});
  eq(bobStart.statusCode, 400, 'a single sign-on account cannot connect');
  eq((await methods(bobSid)).canConnect, false, 'and is not offered to');
}

// ---- OIDC_ALLOWED_GROUPS applies to connecting ----
{
  const cy = await signUp('cy@example.com');
  const res = await connect(cy.sid, 'eve');
  eq(res.statusCode, 400, 'an identity outside the allowed groups is not connected');
  check(res.json().error.includes('not in a group'), `with the IdP refusal (${res.body})`);
  eq((await methods(cy.sid)).links, [], 'nothing was connected');
}

// ---- the state is bound to the session that started it ----
{
  const dee = await signUp('dee@example.com');
  const eli = await signUp('eli@example.com');
  const start = await inject('POST', '/api/auth/sign-in-methods/oidc', sessionCookie(dee.sid), {});
  const state = cookieValue(start, 'aldine_oauth_state');
  const query = await atIdp(start.json().url, 'pat');
  const swapped = await inject('GET', `/api/auth/oauth/oidc/callback${query}`, `${sessionCookie(eli.sid)}; aldine_oauth_state=${state}`);
  eq(swapped.statusCode, 400, 'a connect finished in another session is refused');
  check(swapped.json().error.includes('signed in to another account'), `and says why (${swapped.body})`);
  const signedOut = await inject('GET', `/api/auth/oauth/oidc/callback${query}`, `aldine_oauth_state=${state}`);
  eq(signedOut.statusCode, 400, 'a connect finished signed out is refused');
  check(!cookieValue(signedOut, 'aldine_session'), 'and signs nobody in');
  const [p, s, secret] = state.split('.');
  const forged = await inject('GET', `/api/auth/oauth/oidc/callback${query}`, `${sessionCookie(eli.sid)}; aldine_oauth_state=${p}.${s}.${secret}.link.${'A'.repeat(43)}`);
  eq(forged.statusCode, 400, 'a binding that is not the session\'s is refused');
  const odd = await inject('GET', `/api/auth/oauth/oidc/callback${query}`, `${sessionCookie(dee.sid)}; aldine_oauth_state=${p}.${s}.${secret}.merge`);
  eq(odd.statusCode, 400, 'an unknown purpose is a state mismatch');
  eq((await methods(dee.sid)).links.length + (await methods(eli.sid)).links.length, 0, 'nothing was connected');
}

// ---- a session older than ten minutes asks for the password ----
{
  const fay = await signUp('fay@example.com');
  const stale = 'stale-session-for-fay-000000000000';
  await db().createSession(stale, fay.id, Date.now() + 30 * 864e5 - 11 * 60_000, Date.now() - 11 * 60_000);
  check(!(await auth.sessionIsRecent(stale)), 'a session issued 11 minutes ago is not recent');
  const renewed = 'renewed-session-for-fay-00000000000';
  await db().createSession(renewed, fay.id, Date.now() + 30 * 864e5, Date.now() - 2 * 864e5);
  check(!(await auth.sessionIsRecent(renewed)), 'nor is one renewed just now that began with a sign-in two days ago');
  check(await auth.sessionIsRecent(fay.sid), 'one issued just now is');
  eq((await methods(stale)).recent, false, 'the list says the password will be asked for');
  const bare = await inject('POST', '/api/auth/sign-in-methods/oidc', sessionCookie(stale), {});
  eq(bare.statusCode, 403, 'a stale session cannot connect without the password');
  eq(bare.json().code, 'reauth-required', 'and the client is told to ask for it');
  check(!cookieValue(bare, 'aldine_oauth_state'), 'no attempt is started');
  const wrong = await inject('POST', '/api/auth/sign-in-methods/oidc', sessionCookie(stale), { password: 'not-it-at-all' });
  eq(wrong.statusCode, 403, 'a wrong password is refused');
  eq(wrong.json().error, 'That password is incorrect.', 'and says so');
  const res = await connect(stale, 'pat', { password: 'password123' });
  eq(res.statusCode, 302, `with the password it connects (${res.body})`);
  eq((await methods(stale)).links.map((l) => l.provider), ['oidc'], 'the identity is listed');
}

// ---- disconnect, and the last way to sign in stays ----
{
  const gus = await signUp('gus@example.com');
  mock.addPersona({ code: 'gus', sub: 'gus-1', claims: { name: 'Gus', email: 'gus.idp@example.org', email_verified: true, groups: ['aldine'] } });
  eq((await connect(gus.sid, 'gus')).statusCode, 302, 'gus connects');
  await throws(() => auth.unlinkSignIn(gus.id, 'oidc', false), 'Single sign-on is the only way to sign in to this account, so it stays connected.', 'without password sign-in (ALDINE_SSO_ONLY) the last provider stays');
  eq((await methods(gus.sid)).links.length, 1, 'and is still connected');
  const off = await inject('DELETE', '/api/auth/sign-in-methods/oidc', sessionCookie(gus.sid));
  eq(off.statusCode, 200, `with the password, disconnecting works (${off.body})`);
  eq((await methods(gus.sid)).links, [], 'the identity is gone');
  const missing = await inject('DELETE', '/api/auth/sign-in-methods/oidc', sessionCookie(gus.sid));
  eq(missing.statusCode, 400, 'disconnecting what is not connected says so');
  const after = await oidcSignIn('gus');
  eq(after.statusCode, 302, 'the identity signs in again');
  check((await me(cookieValue(after, 'aldine_session'))).id !== gus.id, 'but no longer to gus\'s account');
}

// ---- a connected account that is disabled, or waits for approval, is refused ----
{
  const hal = await signUp('hal@example.com');
  mock.addPersona({ code: 'hal', sub: 'hal-1', claims: { name: 'Hal', email: 'hal.idp@example.org', email_verified: true, groups: ['aldine'] } });
  eq((await connect(hal.sid, 'hal')).statusCode, 302, 'hal connects');
  await auth.disableAccount(hal.id, false);
  const disabled = await oidcSignIn('hal');
  eq(disabled.statusCode, 400, 'a disabled account does not sign in through its connected identity');
  check(disabled.json().error.includes(auth.ACCOUNT_DISABLED), `and says so (${disabled.body})`);
  const user = await db().getUser(hal.id);
  await db().setDisabled(hal.id, user.createdAt);
  const waiting = await oidcSignIn('hal');
  eq(waiting.statusCode, 403, 'an account waiting for approval does not either');
  check(waiting.json().error.includes(auth.AWAITING_APPROVAL), `and says it waits (${waiting.body})`);
}

// ---- bearer tokens never reach the sign-in methods ----
{
  const ivy = await signUp('ivy@example.com');
  const { token } = await auth.createAccessToken(ivy.id, 'script', null, null);
  const res = await inject('GET', '/api/auth/sign-in-methods', null, null, { authorization: `Bearer ${token}` });
  eq(res.statusCode, 403, 'an access token cannot list or connect sign-in methods');
}

// ---- deleting the account removes its links ----
{
  const jo = await signUp('jo@example.com');
  mock.addPersona({ code: 'jo', sub: 'jo-1', claims: { name: 'Jo', email: 'jo.idp@example.org', email_verified: true, groups: ['aldine'] } });
  eq((await connect(jo.sid, 'jo')).statusCode, 302, 'jo connects');
  const [link] = await db().listSignInLinks(jo.id);
  await auth.deleteAccount(jo.id);
  check((await db().findSignInLink(link.subject)) === null, 'the link goes with the account');
}

await app.close();
await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ sign-in links: all passed');
