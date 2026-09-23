/**
 * The OIDC sign-in routes through buildApp() under a URL prefix, SSO-only
 * (ALDINE_BASE_PATH=/x, ALDINE_PUBLIC_URL=https://aldine.test,
 * ALDINE_SSO_ONLY=1): the redirect URI and cookie path carry the prefix, the
 * state cookie binds the attempt, the callback signs in and lands on /x/,
 * and a tampered, missing or replayed state, a refused consent and an
 * unreachable IdP each end in a clear error rather than a session.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { createMockOidc } from '../../../e2e/auth-tests/mock-oidc.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-oidc-routes-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_SSO_ONLY = '1';
process.env.ALDINE_BASE_PATH = '/x';
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.SENTRY_DSN;
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>Aldine</title>\n');

const mock = await createMockOidc().listen();
Object.assign(process.env, { OIDC_ISSUER: mock.issuer, OIDC_CLIENT_ID: 'aldine-e2e', OIDC_CLIENT_SECRET: 'aldine-e2e-secret', OIDC_LABEL: 'Keycloak' });

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const { resetOidcCache } = await import('../src/oidc.ts');
const app = await buildApp();

const REDIRECT = 'https://aldine.test/x/api/auth/oauth/oidc/callback';
let ip = 0;
const get = (url, cookie) => app.inject({ method: 'GET', url, remoteAddress: `10.9.0.${1 + (ip++ % 250)}`, headers: cookie ? { cookie } : {} });
const cookiesOf = (res) => [res.headers['set-cookie'] ?? []].flat();
const cookieValue = (res, name) => {
  const c = cookiesOf(res).find((s) => s.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};

// ---- /me lists the provider by its label; passwords are off ----
{
  const me = (await get('/x/api/auth/me')).json();
  eq(me.providers, [{ id: 'oidc', label: 'Keycloak' }], '/api/auth/me lists oidc with OIDC_LABEL');
  eq(me.passwordAuth, false, 'SSO-only');
  eq((await app.inject({ method: 'POST', url: '/x/api/auth/login', payload: { email: 'a@b.cd', password: 'password123' } })).statusCode, 403, 'password sign-in is off');
}

/** Start → IdP (persona picked) → the callback query, plus the state cookie. */
async function start(persona) {
  const res = await get('/x/api/auth/oauth/oidc');
  eq(res.statusCode, 302, 'start redirects to the IdP');
  const loc = new URL(res.headers.location);
  const raw = cookiesOf(res).find((s) => s.startsWith('aldine_oauth_state='));
  check(raw, 'state cookie set');
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/x;', 'Max-Age=600', 'Secure']) check(raw.includes(attr), `state cookie has ${attr} (${raw})`);
  const [cookieProvider, state, secret] = cookieValue(res, 'aldine_oauth_state').split('.');
  eq(cookieProvider, 'oidc', 'the attempt names its provider');
  eq(loc.searchParams.get('state'), state, 'state in the URL is the cookie\'s');
  eq(loc.searchParams.get('redirect_uri'), REDIRECT, 'redirect URI carries the public URL and base path');
  check(secret && !res.headers.location.includes(secret), 'the attempt secret never goes to the IdP');
  loc.searchParams.set('persona', persona.code);
  const idp = await fetch(loc, { redirect: 'manual' });
  eq(idp.status, 302, 'IdP redirects back');
  const back = new URL(idp.headers.get('location'));
  eq(back.origin + back.pathname, REDIRECT, 'IdP returns to the redirect URI');
  return { query: back.search, cookie: `aldine_oauth_state=oidc.${state}.${secret}`, state, secret };
}
const callback = (query, cookie) => get(`/x/api/auth/oauth/oidc/callback${query}`, cookie);

mock.addPersona({ code: 'ada', sub: 'ada-1', claims: { name: 'Ada Lovelace', email: 'ada@example.org', email_verified: true, groups: ['aldine'] } });
mock.addPersona({ code: 'eve', sub: 'eve-1', claims: { name: 'Eve', email: 'eve@example.org', email_verified: true, groups: ['other'] } });

// ---- happy path ----
{
  const s = await start({ code: 'ada' });
  const res = await callback(s.query, s.cookie);
  eq(res.statusCode, 302, `callback signs in (${res.body})`);
  eq(res.headers.location, '/x/', 'lands on the app root under the prefix');
  const sid = cookieValue(res, 'aldine_session');
  check(sid, 'session cookie issued');
  check(cookiesOf(res).some((c) => c.startsWith('aldine_oauth_state=;') && c.includes('Max-Age=0')), 'state cookie cleared');
  const me = (await get('/x/api/auth/me', `aldine_session=${sid}`)).json();
  eq(me.user.provider, 'oidc', 'signed in via oidc');
  eq(me.user.email, 'ada@example.org', 'verified email on the account');
  eq(me.user.name, 'Ada Lovelace', 'name from the ID token');

  // The same callback again: its cookie is gone in a browser; replayed with the old cookie, the code is spent.
  const replay = await callback(s.query, s.cookie);
  eq(replay.statusCode, 400, 'a replayed callback is refused');
  check(replay.json().error.startsWith('Keycloak sign-in failed:'), `replay names the provider (${replay.body})`);
  check(!cookieValue(replay, 'aldine_session'), 'no session from a replay');
}

// ---- state checks ----
{
  const s = await start({ code: 'ada' });
  const tampered = s.query.replace(`state=${s.state}`, `state=${s.state.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}`);
  check(tampered !== s.query, 'state was tampered');
  let r = await callback(tampered, s.cookie);
  eq(r.statusCode, 400, 'tampered state → 400');
  check(r.json().error.includes('state mismatch'), 'says state mismatch');
  r = await callback(s.query);
  eq(r.statusCode, 400, 'no state cookie → 400');
  r = await callback(s.query, `aldine_oauth_state=oidc.${s.state}`);
  eq(r.statusCode, 400, 'a state cookie without its attempt secret → 400');
  r = await callback(s.query, `aldine_oauth_state=google.${s.state}.${s.secret}`);
  eq(r.statusCode, 400, 'an attempt started at another provider → 400');
  r = await callback(s.query, `aldine_oauth_state=oidc.${s.state}.${'A'.repeat(43)}`);
  eq(r.statusCode, 400, 'another attempt secret (wrong verifier) → 400');
  check(!cookieValue(r, 'aldine_session'), 'no session');
}

// ---- a browser gets a page with a way back; API clients keep JSON ----
{
  const s = await start({ code: 'ada' });
  const r = await app.inject({ method: 'GET', url: `/x/api/auth/oauth/oidc/callback?code=c&state=nope`, headers: { cookie: s.cookie, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  eq(r.statusCode, 400, 'still a 400 for a browser');
  check(String(r.headers['content-type']).startsWith('text/html'), 'HTML for a browser navigation');
  check(r.body.includes('data-testid="sign-in-error">OAuth state mismatch'), `the message is on the page (${r.body.slice(0, 200)})`);
  check(r.body.includes('data-testid="sign-in-error-back" href="/x/"'), 'the way back honours the base path');
  check(String(r.headers['content-security-policy']).includes("default-src 'none'"), 'no scripts on the error page');
  const injected = await app.inject({ method: 'GET', url: `/x/api/auth/oauth/oidc/callback?error=%3Cscript%3Ealert(1)%3C/script%3E+call+us&state=${s.state}`, headers: { cookie: s.cookie, accept: 'text/html' } });
  check(!injected.body.includes('<script') && !injected.body.includes('call us'), 'IdP error text from the URL never reaches the page');
  check(injected.body.includes('cancelled or refused (error)'), `only a well-formed error code is shown (${injected.body.slice(-300)})`);
}

// ---- refused consent, group restriction, IdP down ----
{
  const s = await start({ code: 'ada' });
  const r = await callback(`?error=access_denied&state=${s.state}`, s.cookie);
  eq(r.statusCode, 400, 'refused consent → 400');
  check(r.json().error.includes('cancelled or refused (access_denied)'), `says so (${r.body})`);
}
process.env.OIDC_ALLOWED_GROUPS = 'aldine';
{
  const s = await start({ code: 'eve' });
  const r = await callback(s.query, s.cookie);
  eq(r.statusCode, 400, 'not in an allowed group → 400');
  check(r.json().error.includes('not in a group'), `says why (${r.body})`);
  const ok = await start({ code: 'ada' });
  eq((await callback(ok.query, ok.cookie)).statusCode, 302, 'a member still gets in');
}
delete process.env.OIDC_ALLOWED_GROUPS;
mock.state.down = true;
resetOidcCache();
{
  const r = await get('/x/api/auth/oauth/oidc');
  eq(r.statusCode, 502, 'IdP down → 502, not a crash');
  check(r.json().error.startsWith('Keycloak sign-in is unavailable:'), `clear message (${r.body})`);
  check(!cookieValue(r, 'aldine_oauth_state'), 'no state cookie for an attempt that never started');
  eq((await get('/x/api/auth/me')).json().providers, [{ id: 'oidc', label: 'Keycloak' }], 'the button stays');
}

await app.close();
await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('OIDC routes: ALL PASSED');
