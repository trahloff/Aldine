/**
 * OAuth 2.1 authorization server for the MCP connector: discovery documents,
 * the /mcp bearer challenge, dynamic client registration (validation + the
 * 500-client cap), the consent routes, the code + PKCE exchange with every
 * binding, refresh rotation + reuse detection, revocation, Client ID Metadata
 * Documents against a loopback stub, and the auth-off 404 rule.
 *
 * Env must be set before any src import (AUTH_ENABLED, the data roots and the
 * limiter bursts are read at module load). The token/register limiters are
 * keyed per IP, so each section injects from its own address and the limiter
 * sections use addresses nobody else touches.
 *
 * ALDINE_TEST_ALLOW_LOOPBACK_CIMD=1 is what lets the stub on 127.0.0.1 pass
 * the SSRF policy; the "policy without the flag" section clears it again
 * (the flag is read per call, never cached) to prove the default refuses.
 *
 * The auth-off leg needs AUTH_ENABLED unset at module load, so the file
 * re-runs itself in a child process with ALDINE_OAUTH_TEST_MODE=off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const ISSUER = 'https://aldine.test';
const OFF_MODE = process.env.ALDINE_OAUTH_TEST_MODE === 'off';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), OFF_MODE ? 'aldine-oauth-off-' : 'aldine-oauth-'));
if (OFF_MODE) delete process.env.AUTH_ENABLED; else process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = ISSUER;
process.env.ALDINE_TEST_ALLOW_LOOPBACK_CIMD = '1';
process.env.RL_OAUTH_TOKEN_BURST = '12';
process.env.RL_OAUTH_REGISTER_BURST = '8';
process.env.RL_OAUTH_CLIENT_BURST = '40';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_MCP_TOKEN;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerMcp } = await import('../src/mcp/server.ts');
const oauth = await import('../src/oauth/index.ts');
const cimd = await import('../src/oauth/cimd.ts');
const Fastify = (await import('fastify')).default;

// Mirror production wiring: routes.ts (which registers OAuth) first, then MCP.
const app = Fastify();
await registerRoutes(app);
await registerMcp(app);

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const rpcPing = { jsonrpc: '2.0', method: 'ping', id: 1 };
const REDIRECT = 'http://127.0.0.1:4321/callback';

let ipCounter = 0;
/** A fresh client address per section so per-IP limiters never bleed between sections. */
const freshIp = () => `10.9.${Math.floor(ipCounter / 250)}.${1 + (ipCounter++ % 250)}`;

const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

/** Authenticated on /mcp? GET → 405 means the guard let the request through; 401 means it did not. */
async function mcpAccepts(token) {
  const r = await app.inject({ method: 'GET', url: '/mcp', remoteAddress: freshIp(), headers: { authorization: `Bearer ${token}` } });
  return r.statusCode === 405;
}

// =====================================================================
// auth-off leg: nothing OAuth is served, /mcp carries no challenge
// =====================================================================
if (OFF_MODE) {
  for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
    const r = await app.inject({ method: 'GET', url });
    check(r.statusCode === 404, `auth off: ${url} → 404 (got ${r.statusCode})`);
  }
  for (const url of ['/oauth/token', '/oauth/register', '/oauth/revoke']) {
    const r = await app.inject({ method: 'POST', url, headers: FORM, payload: form({ token: 'x' }) });
    check(r.statusCode === 404, `auth off: POST ${url} → 404 (got ${r.statusCode})`);
  }
  let r = await app.inject({ method: 'GET', url: `/api/oauth/client?client_id=aldc_x&redirect_uri=${encodeURIComponent(REDIRECT)}` });
  check(r.statusCode === 404, `auth off: /api/oauth/client → 404 (got ${r.statusCode})`);
  r = await app.inject({ method: 'POST', url: '/api/oauth/consent', payload: { decision: 'allow' } });
  check(r.statusCode === 404, `auth off: /api/oauth/consent → 404 (got ${r.statusCode})`);
  // Without ALDINE_MCP_TOKEN /mcp is an unconditional 401 — and must not
  // advertise an authorization server that does not exist.
  r = await app.inject({ method: 'POST', url: '/mcp', payload: rpcPing });
  check(r.statusCode === 401 && r.headers['www-authenticate'] === undefined, 'auth off: /mcp 401 carries no WWW-Authenticate challenge');
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('OAuth (auth off): ALL PASSED');
  process.exit(0);
}

// =====================================================================
// discovery
// =====================================================================
for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
  const r = await app.inject({ method: 'GET', url });
  check(r.statusCode === 200, `${url} → 200 (got ${r.statusCode})`);
  const prm = r.json();
  eq(prm.resource, `${ISSUER}/mcp`, `${url}: resource is <issuer>/mcp`);
  eq(prm.authorization_servers, [ISSUER], `${url}: authorization_servers is the issuer`);
  eq(prm.bearer_methods_supported, ['header'], `${url}: bearer_methods_supported`);
  eq(prm.scopes_supported, ['projects'], `${url}: scopes_supported`);
}
{
  const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
  check(r.statusCode === 200, `AS metadata → 200 (got ${r.statusCode})`);
  const as = r.json();
  eq(as.issuer, ISSUER, 'AS metadata: issuer honours ALDINE_PUBLIC_URL, not the Host header');
  eq(as.authorization_endpoint, `${ISSUER}/oauth/authorize`, 'AS metadata: authorization_endpoint');
  eq(as.token_endpoint, `${ISSUER}/oauth/token`, 'AS metadata: token_endpoint');
  eq(as.registration_endpoint, `${ISSUER}/oauth/register`, 'AS metadata: registration_endpoint');
  eq(as.revocation_endpoint, `${ISSUER}/oauth/revoke`, 'AS metadata: revocation_endpoint');
  eq(as.response_types_supported, ['code'], 'AS metadata: response_types_supported');
  eq(as.grant_types_supported, ['authorization_code', 'refresh_token'], 'AS metadata: grant_types_supported');
  eq(as.code_challenge_methods_supported, ['S256'], 'AS metadata: only S256');
  eq(as.token_endpoint_auth_methods_supported, ['none'], 'AS metadata: public clients only');
  eq(as.client_id_metadata_document_supported, true, 'AS metadata: CIMD advertised');
  eq(as.scopes_supported, ['projects'], 'AS metadata: scopes_supported');
}
{
  // Host-header spoofing must not leak into the documents.
  const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
  eq(r.json().issuer, ISSUER, 'AS metadata: forwarded host is ignored while ALDINE_PUBLIC_URL is set');
}
{
  // The challenge's resource_metadata URL: unchanged at the root, path-inserted under a prefix.
  eq(oauth.resourceMetadataUrl('https://aldine.test'), 'https://aldine.test/.well-known/oauth-protected-resource/mcp', 'no prefix: PRM URL is unchanged');
  eq(oauth.resourceMetadataUrl('https://aldine.test/'), 'https://aldine.test/.well-known/oauth-protected-resource/mcp', 'trailing slash on the issuer is dropped');
  eq(oauth.resourceMetadataUrl('https://aldine.test/internal/aldine'), 'https://aldine.test/.well-known/oauth-protected-resource/internal/aldine/mcp', 'prefixed issuer: the path is inserted after the well-known segment (RFC 9728 §3.1)');
  check(oauth.wwwAuthenticate('https://aldine.test/internal/aldine', { invalidToken: false }).includes('resource_metadata="https://aldine.test/.well-known/oauth-protected-resource/internal/aldine/mcp"'), 'the challenge names the path-inserted document');
  check(oauth.isOurResource('https://aldine.test/internal/aldine', 'https://aldine.test/internal/aldine/mcp') && !oauth.isOurResource('https://aldine.test/internal/aldine', 'https://aldine.test/mcp'), 'resource check is prefix-aware');
}

// =====================================================================
// /mcp challenge
// =====================================================================
{
  let r = await app.inject({ method: 'POST', url: '/mcp', remoteAddress: freshIp(), payload: rpcPing });
  check(r.statusCode === 401, `/mcp without credential → 401 (got ${r.statusCode})`);
  const w = r.headers['www-authenticate'];
  check(typeof w === 'string' && w.startsWith('Bearer '), `challenge is a Bearer challenge (got ${w})`);
  check(w.includes(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource`), `challenge points at the discovery document (got ${w})`);
  check(!w.includes('invalid_token'), 'no credential → no error="invalid_token"');
  eq(r.json(), { error: 'A valid access token is required' }, 'the 401 body is unchanged');

  r = await app.inject({ method: 'POST', url: '/mcp', remoteAddress: freshIp(), headers: { authorization: 'Bearer aldn_wrongwrongwrongwrong' }, payload: rpcPing });
  check(r.statusCode === 401 && r.headers['www-authenticate'].includes('error="invalid_token"'), 'rejected credential → error="invalid_token" on the challenge');
}

// =====================================================================
// dynamic client registration
// =====================================================================
const register = (payload, ip = freshIp(), headers = {}) => app.inject({ method: 'POST', url: '/oauth/register', remoteAddress: ip, headers, payload });
let clientId;
{
  let r = await register({ redirect_uris: [REDIRECT, 'https://client.example/cb'], client_name: 'Test connector', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  check(r.statusCode === 201, `register → 201 (got ${r.statusCode}: ${r.body})`);
  const reg = r.json();
  check(/^aldc_[A-Za-z0-9_-]{16,64}$/.test(reg.client_id), `client_id carries the aldc_ prefix (got ${reg.client_id})`);
  check(reg.client_secret === undefined, 'no client_secret is ever issued');
  eq(reg.client_name, 'Test connector', 'client_name echoed');
  eq(reg.redirect_uris, [REDIRECT, 'https://client.example/cb'], 'redirect_uris echoed');
  eq(reg.token_endpoint_auth_method, 'none', 'auth method is none');
  eq(reg.grant_types, ['authorization_code', 'refresh_token'], 'grant_types echoed');
  eq(reg.response_types, ['code'], 'response_types echoed');
  check(typeof reg.client_id_issued_at === 'number', 'client_id_issued_at is a unix timestamp');
  check(r.headers['cache-control'] === 'no-store', 'registration response is no-store');
  clientId = reg.client_id;
  check((await db().getOAuthClient(clientId)) !== null, 'the client is stored');

  r = await register({ redirect_uris: ['https://only.example/cb'] });
  check(r.statusCode === 201 && r.json().client_name === 'only.example', 'omitted client_name defaults to the redirect host');
  check(r.json().token_endpoint_auth_method === 'none', 'omitted auth method is treated as none');

  const bad = async (payload, code, why) => {
    const res = await register(payload);
    check(res.statusCode === 400 && res.json().error === code, `${why} → 400 ${code} (got ${res.statusCode} ${res.body})`);
    check(typeof res.json().error_description === 'string', `${why}: error_description present`);
  };
  await bad({}, 'invalid_redirect_uri', 'missing redirect_uris');
  await bad({ redirect_uris: [] }, 'invalid_redirect_uri', 'empty redirect_uris');
  await bad({ redirect_uris: ['http://client.example/cb'] }, 'invalid_redirect_uri', 'plain http redirect');
  await bad({ redirect_uris: ['https://client.example/cb#frag'] }, 'invalid_redirect_uri', 'redirect with a fragment');
  await bad({ redirect_uris: ['https://user:pw@client.example/cb'] }, 'invalid_redirect_uri', 'redirect with userinfo');
  await bad({ redirect_uris: ['not a url'] }, 'invalid_redirect_uri', 'unparsable redirect');
  await bad({ redirect_uris: [42] }, 'invalid_redirect_uri', 'non-string redirect');
  await bad({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata', 'client_secret_basic');
  await bad({ redirect_uris: [REDIRECT], grant_types: ['implicit'] }, 'invalid_client_metadata', 'unsupported grant_type');
  await bad({ redirect_uris: [REDIRECT], response_types: ['token'] }, 'invalid_client_metadata', 'unsupported response_type');
  await bad({ redirect_uris: [REDIRECT], client_name: 12 }, 'invalid_client_metadata', 'non-string client_name');
  await bad([REDIRECT], 'invalid_client_metadata', 'array body');

  const big = { redirect_uris: [REDIRECT], client_name: 'x'.repeat(9 * 1024) };
  r = await register(big);
  check(r.statusCode === 413, `body over 8 KB → 413 (got ${r.statusCode})`);
}

// ---- register limiter: RL_OAUTH_REGISTER_BURST per IP ----
{
  const ip = freshIp();
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await register({ redirect_uris: [REDIRECT] }, ip)).statusCode);
  check(codes.slice(0, 8).every((c) => c === 201), `registrations inside the burst succeed (got ${codes.join(',')})`);
  check(codes.slice(8).every((c) => c === 429), `registrations beyond the burst → 429 (got ${codes.join(',')})`);
}

// ---- storage cap: past MAX_CLIENTS the least recently used go first ----
{
  const before = await db().countOAuthClients();
  const seeded = [];
  for (let i = before; i < oauth.MAX_CLIENTS; i++) {
    // lastUsedAt ascends with i, so the lowest-numbered seeds are the LRU victims.
    const c = { id: `aldc_seed${String(i).padStart(12, '0')}`, name: `seed ${i}`, redirectUris: [REDIRECT], createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() };
    await db().createOAuthClient(c);
    seeded.push(c.id);
  }
  eq(await db().countOAuthClients(), oauth.MAX_CLIENTS, 'store filled to the cap');
  // The real clients registered above are newer than every seed, so they survive.
  const r = await register({ redirect_uris: [REDIRECT], client_name: 'Past the cap' });
  check(r.statusCode === 201, `registration past the cap still succeeds (got ${r.statusCode})`);
  eq(await db().countOAuthClients(), oauth.MAX_CLIENTS, 'count stays at the cap');
  check((await db().getOAuthClient(seeded[0])) === null, 'the least recently used client was evicted');
  check((await db().getOAuthClient(seeded[1])) !== null, 'the next-oldest client survived');
  check((await db().getOAuthClient(clientId)) !== null, 'a recently used client survived');
  check((await db().getOAuthClient(r.json().client_id)) !== null, 'the new client is stored');
}

// =====================================================================
// consent routes (cookie session only)
// =====================================================================
const user = await auth.register('ada@example.com', 'password123', 'Ada');
const cookie = `aldine_session=${await auth.createSession(user.id)}`;
const projA = await store.createProject('A', { 'main.tex': 'aaa' }, user.id);
const projB = await store.createProject('B', { 'main.tex': 'bbb' }, user.id);
const pat = await auth.createAccessToken(user.id, 'Hand-made', null, null);

const clientLookup = (q, headers = {}) => app.inject({ method: 'GET', url: `/api/oauth/client?${new URLSearchParams(q)}`, remoteAddress: freshIp(), headers });
{
  let r = await clientLookup({ client_id: clientId, redirect_uri: REDIRECT });
  check(r.statusCode === 200, `client lookup → 200 (got ${r.statusCode} ${r.body})`);
  eq(r.json(), { name: 'Test connector', host: '127.0.0.1:4321', redirectHost: '127.0.0.1:4321', loopbackOnly: false, kind: 'dcr' }, 'client lookup body');
  check(r.headers['cache-control'] === 'no-store', 'client lookup is no-store');

  r = await clientLookup({ client_id: clientId, redirect_uri: 'http://127.0.0.1:9999/callback' });
  check(r.statusCode === 200, 'loopback redirect matches with a different port (RFC 8252 §7.3)');
  r = await clientLookup({ client_id: clientId, redirect_uri: 'http://127.0.0.1:4321/other' });
  check(r.statusCode === 400 && r.json().error === 'invalid_redirect_uri', 'loopback redirect with another path is refused');
  r = await clientLookup({ client_id: clientId, redirect_uri: 'https://client.example/cb/' });
  check(r.statusCode === 400 && r.json().error === 'invalid_redirect_uri', 'https redirect is matched exactly (trailing slash refused)');
  r = await clientLookup({ client_id: clientId, redirect_uri: 'https://client.example:8443/cb' });
  check(r.statusCode === 400 && r.json().error === 'invalid_redirect_uri', 'https redirect port is not ignored');
  r = await clientLookup({ client_id: 'aldc_doesnotexist0000000', redirect_uri: REDIRECT });
  check(r.statusCode === 400 && r.json().error === 'invalid_client', 'unknown aldc_ id → invalid_client');
  r = await clientLookup({ client_id: 'garbage', redirect_uri: REDIRECT });
  check(r.statusCode === 400 && r.json().error === 'invalid_client', 'non-URL, non-aldc_ id → invalid_client');
  r = await clientLookup({ redirect_uri: REDIRECT });
  check(r.statusCode === 400 && r.json().error === 'invalid_client', 'missing client_id → invalid_client');
  r = await clientLookup({ client_id: clientId });
  check(r.statusCode === 400 && r.json().error === 'invalid_request', 'missing redirect_uri → invalid_request');
  r = await clientLookup({ client_id: clientId, redirect_uri: REDIRECT }, { authorization: `Bearer ${pat.token}` });
  check(r.statusCode === 403, `bearer token on /api/oauth/client → 403 (got ${r.statusCode})`);
}

const authz = (extra = {}) => {
  const { verifier, challenge } = pkce();
  return {
    verifier,
    params: { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st4te-123', scope: 'projects', resource: `${ISSUER}/mcp`, ...extra },
  };
};
const consent = (payload, headers = { cookie }) => app.inject({ method: 'POST', url: '/api/oauth/consent', remoteAddress: freshIp(), headers, payload });
const redirectParams = (r) => { const u = new URL(r.json().redirectTo); return { u, q: u.searchParams }; };

{
  const { params } = authz();
  let r = await consent({ ...params, decision: 'allow', projectIds: null }, {});
  check(r.statusCode === 401, `consent without a session → 401 (got ${r.statusCode})`);
  r = await consent({ ...params, decision: 'allow', projectIds: null }, { authorization: `Bearer ${pat.token}` });
  check(r.statusCode === 403, `consent with a bearer token → 403 (tokens cannot mint tokens; got ${r.statusCode})`);
  // CSRF: the session cookie rides along on a cross-site <form> post, but the
  // route has no form parser — the browser cannot produce a JSON body cross-site.
  r = await app.inject({ method: 'POST', url: '/api/oauth/consent', remoteAddress: freshIp(), headers: { cookie, ...FORM }, payload: form({ ...params, decision: 'allow' }) });
  check(r.statusCode === 415, `form-encoded consent → 415, cross-site form posts cannot consent (got ${r.statusCode})`);

  r = await consent({ ...params, client_id: 'aldc_doesnotexist0000000', decision: 'allow', projectIds: null });
  check(r.statusCode === 400 && r.json().error === 'invalid_client' && r.json().redirectTo === undefined, 'unknown client → typed error, never a redirect');
  r = await consent({ ...params, redirect_uri: 'https://evil.example/cb', decision: 'allow', projectIds: null });
  check(r.statusCode === 400 && r.json().error === 'invalid_redirect_uri' && r.json().redirectTo === undefined, 'unregistered redirect_uri → typed error, never a redirect');

  r = await consent({ ...params, decision: 'deny' });
  check(r.statusCode === 200, `deny → 200 (got ${r.statusCode} ${r.body})`);
  let { u, q } = redirectParams(r);
  check(u.origin + u.pathname === REDIRECT, `deny redirects to the registered redirect_uri (got ${u})`);
  eq(q.get('error'), 'access_denied', 'deny → error=access_denied');
  eq(q.get('state'), 'st4te-123', 'deny echoes state');
  eq(q.get('iss'), ISSUER, 'deny carries iss');
  check(q.get('code') === null, 'deny issues no code');

  // Parameter errors go back to the (validated) client per RFC 6749 §4.1.2.1.
  r = await consent({ ...params, code_challenge_method: 'plain', decision: 'allow', projectIds: null });
  eq(redirectParams(r).q.get('error'), 'invalid_request', 'plain PKCE → invalid_request at the redirect');
  r = await consent({ ...params, code_challenge: undefined, decision: 'allow', projectIds: null });
  eq(redirectParams(r).q.get('error'), 'invalid_request', 'missing code_challenge → invalid_request at the redirect');
  r = await consent({ ...params, response_type: 'token', decision: 'allow', projectIds: null });
  eq(redirectParams(r).q.get('error'), 'invalid_request', 'response_type=token → invalid_request at the redirect');
  r = await consent({ ...params, scope: 'projects admin', decision: 'allow', projectIds: null });
  eq(redirectParams(r).q.get('error'), 'invalid_scope', 'unknown scope → invalid_scope at the redirect');
  r = await consent({ ...params, resource: 'https://other.example/mcp', decision: 'allow', projectIds: null });
  ({ q } = redirectParams(r));
  eq(q.get('error'), 'invalid_target', 'foreign resource → invalid_target at the redirect');
  eq(q.get('state'), 'st4te-123', 'error redirects echo state');
  r = await consent({ ...params, resource: `${ISSUER}/mcp/`, decision: 'allow', projectIds: null });
  check(redirectParams(r).q.get('code') !== null, 'resource with a trailing slash is tolerated');
  r = await consent({ ...params, resource: undefined, decision: 'allow', projectIds: null });
  check(redirectParams(r).q.get('code') !== null, 'resource may be omitted');

  r = await consent({ ...params, decision: 'maybe', projectIds: null });
  check(r.statusCode === 400, `unknown decision → 400 (got ${r.statusCode})`);
  r = await consent({ ...params, decision: 'allow', projectIds: [] });
  check(r.statusCode === 400, `empty projectIds → 400 (got ${r.statusCode})`);
  r = await consent({ ...params, decision: 'allow', projectIds: ['../evil'] });
  check(r.statusCode === 400, `malformed project id → 400 (got ${r.statusCode})`);
  r = await consent({ ...params, decision: 'allow', projectIds: 'all' });
  check(r.statusCode === 400, `non-array projectIds → 400 (got ${r.statusCode})`);

  r = await consent({ ...params, decision: 'allow', projectIds: null });
  check(r.statusCode === 200, `allow → 200 (got ${r.statusCode} ${r.body})`);
  ({ u, q } = redirectParams(r));
  check(u.origin + u.pathname === REDIRECT, `allow redirects to the registered redirect_uri (got ${u})`);
  check(/^[A-Za-z0-9_-]{32,}$/.test(q.get('code') || ''), 'allow issues an opaque code');
  eq(q.get('state'), 'st4te-123', 'allow echoes state untouched');
  eq(q.get('iss'), ISSUER, 'allow carries iss');
  check(r.headers['cache-control'] === 'no-store', 'consent response is no-store');

  // A registered redirect with its own query keeps it.
  const withQuery = await register({ redirect_uris: ['https://client.example/cb?app=1'] });
  const { params: p2 } = authz({ client_id: withQuery.json().client_id, redirect_uri: 'https://client.example/cb?app=1' });
  r = await consent({ ...p2, decision: 'deny' });
  ({ q } = redirectParams(r));
  check(q.get('app') === '1' && q.get('error') === 'access_denied', 'the redirect_uri query survives the appended parameters');
}

// =====================================================================
// token endpoint: authorization_code + PKCE
// =====================================================================
const tokenReq = (body, ip) => app.inject({ method: 'POST', url: '/oauth/token', remoteAddress: ip, headers: FORM, payload: form(body) });
/** Consent (allow) → code, ready for exchange. */
async function grant(projectIds = null, extra = {}) {
  const a = authz(extra);
  const r = await consent({ ...a.params, decision: 'allow', projectIds });
  const code = redirectParams(r).q.get('code');
  check(code, `grant issued a code (${r.body})`);
  return { code, verifier: a.verifier, params: a.params };
}
const exchangeBody = (g, over = {}) => ({ grant_type: 'authorization_code', code: g.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: g.verifier, resource: `${ISSUER}/mcp`, ...over });

let happy;
{
  const ip = freshIp();
  const g = await grant([projA.id]);
  let r = await tokenReq(exchangeBody(g), ip);
  check(r.statusCode === 200, `exchange → 200 (got ${r.statusCode} ${r.body})`);
  happy = r.json();
  check(happy.access_token.startsWith('aldn_'), 'access token is an ordinary aldn_ token');
  check(happy.refresh_token.startsWith('aldr_'), 'refresh token carries the aldr_ prefix');
  eq(happy.token_type, 'Bearer', 'token_type');
  eq(happy.expires_in, 24 * 3600, 'expires_in is 24 h');
  eq(happy.scope, 'projects', 'scope');
  check(r.headers['cache-control'] === 'no-store' && r.headers.pragma === 'no-cache', 'token response is no-store');
  check(await mcpAccepts(happy.access_token), 'the access token authenticates on /mcp');

  const hit = await auth.userFromToken(`Bearer ${happy.access_token}`);
  check(hit?.user.id === user.id, 'the access token resolves to the consenting user');
  eq(hit?.tokenScope.projectIds, [projA.id], 'the access token carries the consented project scope');
  const listed = (await auth.listAccessTokens(user.id)).find((t) => t.id === hit.tokenScope.tokenId);
  eq(listed.name, 'Test connector', 'the token is named after the client');
  eq(listed.clientName, 'Test connector', 'the listing exposes clientName (the "via Connect" marker)');
  const ttl = Date.parse(listed.expiresAt) - Date.now();
  check(ttl > 23.9 * 3600_000 && ttl <= 24 * 3600_000, `access token expires in ~24 h (got ${ttl} ms)`);
  const rec = await db().getToken(hit.tokenScope.tokenId);
  check(typeof rec.family === 'string' && rec.family.length > 0, 'the token record carries a family');
  const refreshRec = await db().getRefreshByHash(auth.secretDigest(happy.refresh_token));
  check(refreshRec && refreshRec.family === rec.family && refreshRec.tokenId === rec.id, 'the refresh token is stored hashed, in the same family');
  check(refreshRec.clientId === clientId, 'the refresh token is bound to the client');
  const rttl = Date.parse(refreshRec.expiresAt) - Date.now();
  check(rttl > 29.9 * 864e5 && rttl <= 30 * 864e5, `refresh token expires in ~30 d (got ${rttl} ms)`);

  // Scoped consent shapes the REST surface too.
  r = await app.inject({ method: 'GET', url: `/api/projects/${projB.id}/files?branch=main`, headers: { authorization: `Bearer ${happy.access_token}` } });
  check(r.statusCode === 403, `the OAuth token is refused outside its consented scope (got ${r.statusCode})`);
  r = await app.inject({ method: 'GET', url: `/api/projects/${projA.id}/files?branch=main`, headers: { authorization: `Bearer ${happy.access_token}` } });
  check(r.statusCode === 200, `the OAuth token reads its consented project (got ${r.statusCode})`);
  r = await app.inject({ method: 'GET', url: '/api/tokens', headers: { authorization: `Bearer ${happy.access_token}` } });
  check(r.statusCode === 403, 'an OAuth token cannot reach token management (bearer allowlist unchanged)');

  // Second presentation of the same code: invalid_grant AND the family it produced is revoked.
  r = await tokenReq(exchangeBody(g), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', `code reuse → invalid_grant (got ${r.statusCode} ${r.body})`);
  check(!(await mcpAccepts(happy.access_token)), 'code reuse revoked the access token it produced');
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: happy.refresh_token, client_id: clientId }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'code reuse revoked the refresh token it produced');
}

{
  const ip = freshIp();
  const g = await grant();
  let r = await tokenReq(exchangeBody(g, { code_verifier: crypto.randomBytes(48).toString('base64url') }), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', `wrong verifier → invalid_grant (got ${r.statusCode} ${r.body})`);
  r = await tokenReq(exchangeBody(g), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'a code is burned by the failed attempt — the right verifier no longer helps');
  check((await auth.listAccessTokens(user.id)).every((t) => t.clientName === null), 'no OAuth token was minted by the failed exchanges');
}
{
  const ip = freshIp();
  let g = await grant();
  let r = await tokenReq(exchangeBody(g, { redirect_uri: 'http://127.0.0.1:4321/other' }), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', `wrong redirect_uri → invalid_grant (got ${r.statusCode} ${r.body})`);
  g = await grant();
  const other = (await register({ redirect_uris: [REDIRECT] })).json().client_id;
  r = await tokenReq(exchangeBody(g, { client_id: other }), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', `another client_id → invalid_grant (got ${r.statusCode} ${r.body})`);
  g = await grant();
  r = await tokenReq(exchangeBody(g, { resource: 'https://other.example/mcp' }), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_target', `foreign resource on exchange → invalid_target (got ${r.statusCode} ${r.body})`);
  // resource is checked before the code is consumed: the code is still good.
  r = await tokenReq(exchangeBody(g), ip);
  check(r.statusCode === 200, 'the code survives an invalid_target attempt');

  g = await grant();
  r = await tokenReq(exchangeBody(g, { code_verifier: undefined }), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_request', `missing verifier → invalid_request (got ${r.body})`);
  r = await tokenReq(exchangeBody(g, { code_verifier: 'short' }), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_request', `short verifier → invalid_request (got ${r.body})`);
  r = await tokenReq(exchangeBody(g, { code_verifier: 'a'.repeat(129) }), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_request', `over-long verifier → invalid_request (got ${r.body})`);
  r = await tokenReq(exchangeBody(g), ip);
  check(r.statusCode === 200, 'invalid_request attempts do not consume the code');

  r = await tokenReq(exchangeBody(g, { code: 'nosuchcode_' + crypto.randomBytes(24).toString('base64url') }), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'unknown code → invalid_grant');
  eq(r.json().error_description, 'The authorization code is invalid or has expired', 'unknown and used codes share one description');
  r = await tokenReq({ grant_type: 'client_credentials' }, ip);
  check(r.statusCode === 400 && r.json().error === 'unsupported_grant_type', `client_credentials → unsupported_grant_type (got ${r.body})`);
  r = await tokenReq({ code: 'x' }, ip);
  check(r.statusCode === 400 && r.json().error === 'unsupported_grant_type', 'missing grant_type → unsupported_grant_type');
  r = await app.inject({ method: 'POST', url: '/oauth/token', remoteAddress: ip, headers: FORM, payload: 'x'.repeat(9 * 1024) });
  check(r.statusCode === 413, `token body over 8 KB → 413 (got ${r.statusCode})`);
}

// ---- code expiry ----
{
  const ip = freshIp();
  const g = await grant();
  const late = Date.now() + oauth.CODE_TTL_MS + 1;
  eq(oauth.consumeCode(g.code, late).status, 'unknown', 'a code past its TTL is unknown');
  const r = await tokenReq(exchangeBody(g), ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'an expired code is invalid_grant at the endpoint');
}

// =====================================================================
// refresh rotation + reuse detection
// =====================================================================
{
  const ip = freshIp();
  const g = await grant([projA.id]);
  const t1 = (await tokenReq(exchangeBody(g), ip)).json();
  check(await mcpAccepts(t1.access_token), 'first access token works');
  const rec1 = await db().getToken((await auth.userFromToken(`Bearer ${t1.access_token}`)).tokenScope.tokenId);

  let r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId, resource: `${ISSUER}/mcp` }, ip);
  check(r.statusCode === 200, `refresh → 200 (got ${r.statusCode} ${r.body})`);
  const t2 = r.json();
  check(t2.access_token !== t1.access_token && t2.refresh_token !== t1.refresh_token, 'refresh rotates both tokens');
  check(r.headers['cache-control'] === 'no-store', 'refresh response is no-store');
  check(await mcpAccepts(t2.access_token), 'the rotated access token works');
  check(!(await mcpAccepts(t1.access_token)), 'the previous access token is revoked by the rotation');
  const hit = await auth.userFromToken(`Bearer ${t2.access_token}`);
  eq(hit.tokenScope.projectIds, [projA.id], 'the rotated token keeps the consented scope');
  const rec2 = await db().getToken(hit.tokenScope.tokenId);
  check(rec2.createdAt === rec1.createdAt && rec2.lastUsedAt === rec1.lastUsedAt, 'the rotated-in token keeps the connection\'s createdAt and lastUsedAt (the card shows the connection, not the rotation)');
  const family = rec2.family;
  const live = (await db().listTokensForUser(user.id)).filter((t) => t.family === family && !t.revokedAt);
  eq(live.map((t) => t.id), [hit.tokenScope.tokenId], 'only the rotated-in token of the family stays live');

  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: 'aldc_someoneelse00000000' }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'refresh bound to another client_id → invalid_grant');
  check(await mcpAccepts(t2.access_token), 'a client_id mismatch does not burn the family');
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, resource: 'https://other.example/mcp' }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_target', 'foreign resource on refresh → invalid_target');
  r = await tokenReq({ grant_type: 'refresh_token' }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_request', 'missing refresh_token → invalid_request');
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: 'aldr_' + crypto.randomBytes(32).toString('base64url') }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'unknown refresh token → invalid_grant');
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t2.access_token }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'an access token is not a refresh token');

  // Reuse of the rotated-out t1 refresh token: the whole family dies.
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'presenting a used refresh token → invalid_grant');
  check(!(await mcpAccepts(t2.access_token)), 'reuse revoked the family\'s live access token');
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: clientId }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'reuse revoked the family\'s live refresh token');
  check((await db().listTokensForUser(user.id)).filter((t) => t.family === family).every((t) => t.revokedAt), 'every token of the family is revoked');
  check(await mcpAccepts(pat.token), 'the hand-made token is untouched by family revocation');
}

// ---- concurrency: one code / one refresh token presented twice at once ----
// A Postgres round trip separates the read from the write; the JSON store's
// synchronous writes would hide the race, so the store calls are slowed here.
const slowStore = (method, ms = 5) => {
  const real = db()[method];
  db()[method] = async function (...args) { await new Promise((r) => setTimeout(r, ms)); return real.apply(this, args); };
  return () => { delete db()[method]; };
};
{
  const ip = freshIp();
  const g = await grant();
  const liveBefore = (await auth.listAccessTokens(user.id)).filter((t) => t.clientName === 'Test connector').length;
  const restore = slowStore('createRefresh');
  let rs;
  try { rs = await Promise.all([tokenReq(exchangeBody(g), ip), tokenReq(exchangeBody(g), ip)]); } finally { restore(); }
  const statuses = rs.map((r) => r.statusCode);
  check(statuses.every((c) => c === 400) && rs.every((r) => r.json().error === 'invalid_grant'), `two concurrent exchanges of one code both fail (got ${statuses.join(',')})`);
  const liveAfter = (await auth.listAccessTokens(user.id)).filter((t) => t.clientName === 'Test connector').length;
  eq(liveAfter, liveBefore, 'a code replayed while its first exchange was minting leaves no live token behind');
}
{
  const ip = freshIp();
  const g = await grant();
  const t1 = (await tokenReq(exchangeBody(g), ip)).json();
  const family = (await db().getRefreshByHash(auth.secretDigest(t1.refresh_token))).family;
  // Both reads must land before either write: the delay sits on the write.
  const restore = slowStore('markRefreshUsed');
  let rs;
  try {
    rs = await Promise.all([
      tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId }, ip),
      tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId }, ip),
    ]);
  } finally { restore(); }
  const statuses = rs.map((r) => r.statusCode).sort();
  eq(statuses, [200, 400], `two concurrent refreshes of one token: exactly one rotates (got ${rs.map((r) => r.statusCode).join(',')})`);
  const loser = rs.find((r) => r.statusCode === 400);
  eq(loser.json().error, 'invalid_grant', 'the losing refresh is invalid_grant');
  const winner = rs.find((r) => r.statusCode === 200).json();
  check(!(await mcpAccepts(winner.access_token)), 'the concurrent presentation burned the family — the winner\'s access token is dead too');
  check((await db().listTokensForUser(user.id)).filter((t) => t.family === family).every((t) => t.revokedAt), 'every access token of the raced family is revoked');
  const r = await tokenReq({ grant_type: 'refresh_token', refresh_token: winner.refresh_token, client_id: clientId }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'the winner\'s new refresh token is revoked as well');
}
{
  // The other ordering: the loser's family revocation lands AFTER the winner's
  // CAS but BEFORE its new rows exist (Postgres: two UPDATEs beat four
  // statements). Slowing the access-token insert pins the revoke inside the
  // winner's mint; the winner must notice and burn what it just wrote.
  const ip = freshIp();
  const g = await grant();
  const t1 = (await tokenReq(exchangeBody(g), ip)).json();
  const family = (await db().getRefreshByHash(auth.secretDigest(t1.refresh_token))).family;
  const restore = slowStore('createToken', 20);
  let rs;
  try {
    rs = await Promise.all([
      tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId }, ip),
      tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId }, ip),
    ]);
  } finally { restore(); }
  const statuses = rs.map((r) => r.statusCode).sort();
  eq(statuses, [400, 400], `a family revoked mid-mint fails both rotations (got ${rs.map((r) => r.statusCode).join(',')})`);
  check(rs.every((r) => r.json().error === 'invalid_grant'), 'both mid-mint refreshes are invalid_grant');
  const fam = (await db().listTokensForUser(user.id)).filter((t) => t.family === family);
  check(fam.length >= 2 && fam.every((t) => t.revokedAt), 'the pair minted during the revocation is revoked too');
  check(!(await mcpAccepts(t1.access_token)), 'the pre-rotation access token is dead');
}

// ---- an idle connector's grant stays visible and revocable ----
// The access token expires after 24 h; the refresh token lives 30 d. The
// expired record is the card's only handle on the grant, so the prune that
// clears rotated-out records must leave it alone.
{
  const ip = freshIp();
  const g = await grant();
  const t = (await tokenReq(exchangeBody(g), ip)).json();
  const refreshRec = await db().getRefreshByHash(auth.secretDigest(t.refresh_token));
  const access = await db().getToken(refreshRec.tokenId);
  access.expiresAt = new Date(Date.now() - 8 * 864e5).toISOString();
  await db().updateToken(access);
  await auth.createAccessToken(user.id, 'Unrelated PAT', null, null);
  const listed = (await auth.listAccessTokens(user.id)).find((x) => x.id === access.id);
  check(!!listed, 'an expired-but-unrevoked Connect token stays on the Agent access card while its refresh token is live');
  check(await auth.revokeAccessToken(user.id, access.id), 'the idle grant can still be revoked from the card');
  const r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'the card revoke ended the idle connector\'s refresh token');
}

// ---- refresh expiry ----
{
  const ip = freshIp();
  const g = await grant();
  const t = (await tokenReq(exchangeBody(g), ip)).json();
  const rec = await db().getRefreshByHash(auth.secretDigest(t.refresh_token));
  // Backdate through the store: the record shape is the seam, not a private API.
  await db().createRefresh({ ...rec, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'an expired refresh token → invalid_grant');
}

// ---- token limiter: RL_OAUTH_TOKEN_BURST per IP ----
{
  const ip = freshIp();
  const codes = [];
  for (let i = 0; i < 16; i++) codes.push((await tokenReq({ grant_type: 'authorization_code', code: `guess${i}`, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'v'.repeat(43) }, ip)).statusCode);
  check(codes.slice(0, 12).every((c) => c === 400), `guesses inside the burst are answered (got ${codes.join(',')})`);
  check(codes.slice(12).every((c) => c === 429), `guesses beyond the burst → 429 (got ${codes.join(',')})`);
  const r = await tokenReq({ grant_type: 'authorization_code' }, ip);
  eq(r.json().error, 'invalid_request', 'the 429 body keeps the RFC error shape');
}

// =====================================================================
// revocation
// =====================================================================
const revoke = (body, ip = freshIp()) => app.inject({ method: 'POST', url: '/oauth/revoke', remoteAddress: ip, headers: FORM, payload: form(body) });
{
  const ip = freshIp();
  let t = (await tokenReq(exchangeBody(await grant()), ip)).json();
  let r = await revoke({ token: t.access_token, token_type_hint: 'access_token' });
  check(r.statusCode === 200, `revoke access token → 200 (got ${r.statusCode})`);
  check(!(await mcpAccepts(t.access_token)), 'the revoked access token is dead');
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, ip);
  check(r.statusCode === 200, 'revoking an access token alone leaves its refresh token usable (RFC 7009 §2.1 MAY)');
  t = r.json();

  r = await revoke({ token: t.refresh_token, token_type_hint: 'refresh_token' });
  check(r.statusCode === 200, `revoke refresh token → 200 (got ${r.statusCode})`);
  check(!(await mcpAccepts(t.access_token)), 'revoking a refresh token revokes the family\'s access token');
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'the revoked refresh token is dead');

  for (const body of [{ token: 'aldr_nothing' }, { token: 'aldn_nothing' }, { token: 'garbage' }, {}, { token: 'x'.repeat(600) }]) {
    r = await revoke(body);
    check(r.statusCode === 200, `revoke ${JSON.stringify(body)} → 200, never reveals whether a token existed (got ${r.statusCode})`);
  }
  check(r.headers['cache-control'] === 'no-store', 'revoke response is no-store');

  // Revoking from the Agent access card (session route) also kills the refresh token.
  const t3 = (await tokenReq(exchangeBody(await grant()), ip)).json();
  const id = (await auth.userFromToken(`Bearer ${t3.access_token}`)).tokenScope.tokenId;
  r = await app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, headers: { cookie } });
  check(r.statusCode === 200, `DELETE /api/tokens revokes the OAuth token (got ${r.statusCode})`);
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t3.refresh_token }, ip);
  check(r.statusCode === 400 && r.json().error === 'invalid_grant', 'a card revoke cancels the refresh token — the connector cannot mint a replacement');
}

// =====================================================================
// Client ID Metadata Documents (loopback stub, allowed by the test flag)
// =====================================================================
let stubDoc = null;
let stubStatus = 200;
let stubContentType = 'application/json';
let stubHits = 0;
const stub = http.createServer((req, res) => {
  stubHits++;
  if (req.url === '/redirect') { res.writeHead(302, { location: `${stubBase}/meta.json` }); res.end(); return; }
  if (req.url === '/huge.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ client_id: `${stubBase}/huge.json`, client_name: 'x'.repeat(70 * 1024), redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })); return; }
  if (req.url === '/slow.json') { return; /* never answers — the fetch must time out */ }
  if (req.url === '/drip.json') {
    // Headers at once, then one byte per second: resets a socket idle timer forever.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    const drip = setInterval(() => res.write(' '), 1000);
    res.on('close', () => clearInterval(drip));
    return;
  }
  if (req.url === '/cut.json') {
    // A body that promises more than it delivers, then the socket goes away.
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
    res.write('{"client_id":');
    setTimeout(() => res.socket?.destroy(), 20);
    return;
  }
  if (req.url.startsWith('/many/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ client_id: `${stubBase}${req.url}`, client_name: 'Many', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
    return;
  }
  res.writeHead(stubStatus, { 'content-type': stubContentType });
  res.end(typeof stubDoc === 'string' ? stubDoc : JSON.stringify(stubDoc));
});
await new Promise((res) => stub.listen(0, '127.0.0.1', res));
const stubBase = `http://127.0.0.1:${stub.address().port}`;
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const metaId = `${stubBase}/meta.json`;
const lookupCimd = (id = metaId, redirect = CLAUDE_CB) => clientLookup({ client_id: id, redirect_uri: redirect });

{
  stubDoc = { client_id: metaId, client_name: 'Claude', client_uri: 'https://claude.ai', redirect_uris: [CLAUDE_CB, 'http://localhost/callback'], token_endpoint_auth_method: 'none' };
  let r = await lookupCimd();
  check(r.statusCode === 200, `CIMD happy path → 200 (got ${r.statusCode} ${r.body})`);
  eq(r.json(), { name: 'Claude', host: `127.0.0.1:${stub.address().port}`, redirectHost: 'claude.ai', loopbackOnly: false, kind: 'cimd' }, 'CIMD lookup body');
  const hitsAfterFirst = stubHits;
  r = await lookupCimd();
  check(r.statusCode === 200 && stubHits === hitsAfterFirst, 'a second lookup within 5 min is served from the cache');
  r = await lookupCimd(metaId, 'http://localhost:51234/callback');
  check(r.statusCode === 200, 'CIMD loopback redirect matches with a port (Claude Code registers the portless form)');
  r = await lookupCimd(metaId, `${CLAUDE_CB}/extra`);
  check(r.statusCode === 400 && r.json().error === 'invalid_redirect_uri', 'CIMD redirect_uri must be listed exactly');
  r = await lookupCimd(metaId, 'https://claude.ai/api/mcp/auth_callback?x=1');
  check(r.statusCode === 400 && r.json().error === 'invalid_redirect_uri', 'CIMD redirect_uri with an extra query is refused');

  // The full flow works for a CIMD client too (consent binds the URL id; the exchange must present it).
  const ip = freshIp();
  const a = authz({ client_id: metaId, redirect_uri: CLAUDE_CB });
  r = await consent({ ...a.params, decision: 'allow', projectIds: null });
  const code = redirectParams(r).q.get('code');
  check(code && redirectParams(r).u.origin + redirectParams(r).u.pathname === CLAUDE_CB, 'CIMD consent redirects to the listed callback');
  r = await tokenReq({ grant_type: 'authorization_code', code, client_id: metaId, redirect_uri: CLAUDE_CB, code_verifier: a.verifier }, ip);
  check(r.statusCode === 200, `CIMD exchange → 200 (got ${r.statusCode} ${r.body})`);
  const listed = (await auth.listAccessTokens(user.id)).find((t) => t.clientName === 'Claude');
  check(listed !== undefined, 'the CIMD client\'s token is named after the document');
  await revoke({ token: r.json().refresh_token });

  // Document defects — each fetched fresh because errors are never cached and
  // the cache is cleared between cases.
  const reject = async (why, setup, code = 'invalid_client', id = metaId) => {
    oauth.resetOAuthStateForTests();
    stubStatus = 200; stubContentType = 'application/json';
    setup();
    const res = await lookupCimd(id);
    check(res.statusCode === 400 && res.json().error === code, `${why} → ${code} (got ${res.statusCode} ${res.body})`);
    check(!/aldn_|aldr_|secret/i.test(res.json().error_description) || /client secret|client_secret/.test(res.json().error_description), `${why}: description carries no secret`);
  };
  await reject('client_id in the document differs from the URL', () => { stubDoc = { client_id: `${stubBase}/other.json`, client_name: 'X', redirect_uris: [CLAUDE_CB] }; });
  await reject('missing client_name', () => { stubDoc = { client_id: metaId, redirect_uris: [CLAUDE_CB] }; });
  await reject('missing redirect_uris', () => { stubDoc = { client_id: metaId, client_name: 'X' }; });
  await reject('http redirect_uris in the document', () => { stubDoc = { client_id: metaId, client_name: 'X', redirect_uris: ['http://claude.ai/cb'] }; });
  await reject('a client_secret in the document', () => { stubDoc = { client_id: metaId, client_name: 'X', redirect_uris: [CLAUDE_CB], client_secret: 's3cret' }; });
  await reject('client_secret_post auth method', () => { stubDoc = { client_id: metaId, client_name: 'X', redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: 'client_secret_post' }; });
  await reject('a JSON array', () => { stubDoc = [1]; });
  await reject('invalid JSON', () => { stubDoc = '{not json'; });
  await reject('a non-JSON content type', () => { stubDoc = { client_id: metaId, client_name: 'X', redirect_uris: [CLAUDE_CB] }; stubContentType = 'text/html'; });
  await reject('HTTP 404', () => { stubDoc = { client_id: metaId, client_name: 'X', redirect_uris: [CLAUDE_CB] }; stubStatus = 404; });
  await reject('a redirect (not followed)', () => { stubDoc = { client_id: metaId, client_name: 'X', redirect_uris: [CLAUDE_CB] }; }, 'invalid_client', `${stubBase}/redirect`);
  await reject('a document over 64 KB', () => {}, 'invalid_client', `${stubBase}/huge.json`);
  await reject('userinfo in client_id', () => {}, 'invalid_client', `http://user:pw@127.0.0.1:${stub.address().port}/meta.json`);
  await reject('a fragment in client_id', () => {}, 'invalid_client', `${metaId}#frag`);
  await reject('a client_id without a path', () => {}, 'invalid_client', `${stubBase}/`);
  await reject('dot segments in client_id', () => {}, 'invalid_client', `${stubBase}/../meta.json`);
  oauth.resetOAuthStateForTests();
  stubDoc = { client_id: metaId, client_name: 'Claude', redirect_uris: [CLAUDE_CB] };
  r = await lookupCimd();
  check(r.statusCode === 200, 'the stub is healthy again after the rejection cases');
}

// ---- timeout: the fetch gives up after CIMD_TIMEOUT_MS, even when bytes trickle in ----
{
  oauth.resetOAuthStateForTests();
  const started = Date.now();
  const attempt = async (path) => { try { await cimd.fetchClientMetadata(`${stubBase}/${path}`); return null; } catch (e) { return e; } };
  const [hang, drip] = await Promise.all([attempt('slow.json'), attempt('drip.json')]);
  check(hang instanceof oauth.OAuthError && hang.code === 'invalid_client', `a hanging document → invalid_client (got ${hang && hang.message})`);
  check(drip instanceof oauth.OAuthError && drip.code === 'invalid_client' && /did not load in time/.test(drip.message), `a trickling document → invalid_client timeout (got ${drip && drip.message})`);
  const took = Date.now() - started;
  // Node's socket timeout list fires a little early; the bound that matters is the upper one.
  check(took >= 1000 && took < cimd.CIMD_TIMEOUT_MS + 2000, `both fetches gave up within the ${cimd.CIMD_TIMEOUT_MS} ms budget (took ${took})`);
}

// ---- a socket dropped mid-body is the client's fault, not a server_error ----
{
  oauth.resetOAuthStateForTests();
  let err = null;
  try { await cimd.fetchClientMetadata(`${stubBase}/cut.json`); } catch (e) { err = e; }
  check(err instanceof oauth.OAuthError && err.code === 'invalid_client', `a connection cut mid-body → invalid_client (got ${err && err.constructor.name}: ${err && err.message})`);
  const r = await lookupCimd(`${stubBase}/cut.json`);
  check(r.statusCode === 400 && r.json().error === 'invalid_client', `the endpoint answers 400 invalid_client, not 500 (got ${r.statusCode})`);
}

// ---- the metadata cache is bounded ----
{
  oauth.resetOAuthStateForTests();
  const ids = [];
  for (let i = 0; i <= cimd.CIMD_CACHE_MAX; i++) ids.push(`${stubBase}/many/${i}.json`);
  for (const id of ids) await cimd.fetchClientMetadata(id);
  check(cimd.cimdCacheSizeForTests() === cimd.CIMD_CACHE_MAX, `${ids.length} distinct client_ids keep the cache at ${cimd.CIMD_CACHE_MAX} entries (got ${cimd.cimdCacheSizeForTests()})`);
  let hits = stubHits;
  await cimd.fetchClientMetadata(ids[ids.length - 1]);
  check(stubHits === hits, 'the newest document is still served from the cache');
  hits = stubHits;
  await cimd.fetchClientMetadata(ids[0]);
  check(stubHits === hits + 1, 'the oldest document was evicted and is fetched again');
  oauth.resetOAuthStateForTests();
}

// ---- SSRF policy WITHOUT the test flag: loopback/private/metadata refused, https only ----
{
  delete process.env.ALDINE_TEST_ALLOW_LOOPBACK_CIMD;
  oauth.resetOAuthStateForTests();
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'not-an-ip']) {
    check(cimd.isBlockedAddress(ip) === true, `${ip} is blocked by default`);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
    check(cimd.isBlockedAddress(ip) === false, `${ip} is a public address`);
  }
  let r = await lookupCimd(metaId);
  check(r.statusCode === 400 && r.json().error === 'invalid_client', 'an http client_id is refused without the flag');
  r = await lookupCimd('https://169.254.169.254/latest/meta-data');
  check(r.statusCode === 400 && r.json().error === 'invalid_client' && /public address/.test(r.json().error_description), `the cloud metadata address is refused (got ${r.body})`);
  r = await lookupCimd('https://127.0.0.1/meta.json');
  check(r.statusCode === 400 && /public address/.test(r.json().error_description), 'https to loopback is refused');
  r = await lookupCimd('https://[::1]/meta.json');
  check(r.statusCode === 400 && /public address/.test(r.json().error_description), 'https to IPv6 loopback is refused');
  r = await lookupCimd('https://10.0.0.5/meta.json');
  check(r.statusCode === 400 && /public address/.test(r.json().error_description), 'https to a private address is refused');
  r = await lookupCimd('https://client.example:8443/meta.json');
  check(r.statusCode === 400 && /default https port/.test(r.json().error_description), 'a non-default port is refused');
  r = await lookupCimd('https://user@client.example/meta.json');
  check(r.statusCode === 400 && /credentials/.test(r.json().error_description), 'userinfo is refused');
  check(stubHits > 0, 'sanity: the stub was used earlier');
  const hitsBefore = stubHits;
  await lookupCimd(metaId);
  check(stubHits === hitsBefore, 'a refused client_id never reaches the network');
  process.env.ALDINE_TEST_ALLOW_LOOPBACK_CIMD = '1';
}

// ---- /api/oauth/client limiter (per IP) ----
{
  const ip = freshIp();
  const codes = [];
  for (let i = 0; i < 44; i++) {
    const r = await app.inject({ method: 'GET', url: `/api/oauth/client?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`, remoteAddress: ip });
    codes.push(r.statusCode);
  }
  check(codes.slice(0, 40).every((c) => c === 200), `client lookups inside the burst succeed (got ${codes.join(',')})`);
  check(codes.slice(40).every((c) => c === 429), `lookups beyond the burst → 429 (got ${codes.slice(38).join(',')})`);
}

stub.close();
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('OAuth (auth on): ALL PASSED');

// ---- auth-off leg in a child process (AUTH_ENABLED is read at module load) ----
{
  const self = fileURLToPath(import.meta.url);
  const env = { ...process.env, ALDINE_OAUTH_TEST_MODE: 'off' };
  delete env.AUTH_ENABLED;
  const out = execFileSync(process.execPath, [...process.execArgv, self], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  check(out.includes('OAuth (auth off): ALL PASSED'), `auth-off leg passed (output: ${out.trim().slice(-200)})`);
}
console.log('OAuth: ALL PASSED');
// Project creation scheduled autocommit timers; exit instead of idling on them.
process.exit(0);
