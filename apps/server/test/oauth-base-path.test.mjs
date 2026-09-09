/**
 * OAuth discovery and the MCP connector under a URL prefix with auth ON
 * (ALDINE_BASE_PATH=/x, ALDINE_PUBLIC_URL=https://aldine.test): the discovery
 * documents answer at the origin-root, path-inserted locations MCP clients
 * probe first (RFC 8414 §3.1 / RFC 9728 §3.1) and at the app-relative ones,
 * byte-identical, with issuer/resource/endpoints carrying the prefix; the
 * /mcp challenge names the path-inserted document; the unprefixed root forms
 * are not ours; and a full DCR → consent → token → /mcp round trip works
 * through the prefix.
 *
 * Boots through buildApp() (unlike oauth.test.mjs) so rewriteUrl is in play.
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-oauth-base-path-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_BASE_PATH = '/x';
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.ALDINE_MCP = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
delete process.env.ALDINE_MCP_TOKEN;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

// A built SPA, so the consent page has an index.html to fall back to.
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html>\n<html><head><title>Aldine</title></head><body><div id="root"></div></body></html>\n');

const ISSUER = 'https://aldine.test/x';
const PRM_URL = 'https://aldine.test/.well-known/oauth-protected-resource/x/mcp';
const REDIRECT = 'http://127.0.0.1:4321/callback';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const rpcPing = { jsonrpc: '2.0', method: 'ping', id: 1 };

const { config } = await import('../src/config.ts');
eq(config.basePath, '/x', 'ALDINE_BASE_PATH is the base path');
eq(config.publicUrl, ISSUER, 'ALDINE_PUBLIC_URL origin + ALDINE_BASE_PATH is the issuer');

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const auth = await import('../src/auth.ts');
const app = await buildApp();

let ipCounter = 0;
/** A fresh client address per request so per-IP limiters never interfere. */
const freshIp = () => `10.8.0.${1 + (ipCounter++ % 250)}`;
const get = (url, headers = {}) => app.inject({ method: 'GET', url, remoteAddress: freshIp(), headers });
const isJson404 = (res, url) => {
  eq(res.statusCode, 404, `${url} is 404`);
  check(res.headers['content-type'].startsWith('application/json'), `${url} 404 is json`);
  check(!res.body.includes('aldine-base-path'), `${url} does not leak the app`);
};

// ---------- discovery: path-inserted at the origin root, app-relative under the prefix, identical ----------
{
  const r = await get('/.well-known/oauth-authorization-server/x');
  eq(r.statusCode, 200, 'path-inserted AS metadata → 200');
  check(r.headers['content-type'].startsWith('application/json'), 'AS metadata is json');
  const as = r.json();
  eq(as.issuer, ISSUER, 'AS metadata: issuer carries the prefix');
  eq(as.authorization_endpoint, `${ISSUER}/oauth/authorize`, 'AS metadata: authorization_endpoint under the prefix');
  eq(as.token_endpoint, `${ISSUER}/oauth/token`, 'AS metadata: token_endpoint under the prefix');
  eq(as.registration_endpoint, `${ISSUER}/oauth/register`, 'AS metadata: registration_endpoint under the prefix');
  eq(as.revocation_endpoint, `${ISSUER}/oauth/revoke`, 'AS metadata: revocation_endpoint under the prefix');
  const rel = await get('/x/.well-known/oauth-authorization-server');
  eq(rel.statusCode, 200, 'app-relative AS metadata → 200');
  eq(rel.body, r.body, 'both AS metadata forms are byte-identical');
}
for (const [rootForm, relForm] of [
  ['/.well-known/oauth-protected-resource/x/mcp', '/x/.well-known/oauth-protected-resource/mcp'],
  ['/.well-known/oauth-protected-resource/x', '/x/.well-known/oauth-protected-resource'],
]) {
  const r = await get(rootForm);
  eq(r.statusCode, 200, `${rootForm} → 200`);
  const prm = r.json();
  eq(prm.resource, `${ISSUER}/mcp`, `${rootForm}: resource is <issuer>/mcp with the prefix`);
  eq(prm.authorization_servers, [ISSUER], `${rootForm}: authorization_servers is the prefixed issuer`);
  const rel = await get(relForm);
  eq(rel.statusCode, 200, `${relForm} → 200`);
  eq(rel.body, r.body, `${rootForm} and ${relForm} are byte-identical`);
}
{
  // Host-header spoofing must not leak into the documents.
  const spoof = { host: 'evil.example', 'x-forwarded-host': 'evil.example' };
  eq((await get('/.well-known/oauth-authorization-server/x', spoof)).json().issuer, ISSUER, 'AS metadata: forwarded host is ignored');
  eq((await get('/.well-known/oauth-protected-resource/x/mcp', spoof)).json().resource, `${ISSUER}/mcp`, 'PRM: forwarded host is ignored');
}

// ---------- outside the base path: nothing else at the origin root is ours ----------
for (const url of [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server/x/',
  '/.well-known/oauth-authorization-server/xy',
  '/.well-known/openid-configuration/x',
  '/mcp',
]) {
  isJson404(await get(url), url);
}
isJson404(await app.inject({ method: 'POST', url: '/oauth/token', remoteAddress: freshIp(), headers: FORM, payload: form({ grant_type: 'password' }) }), 'POST /oauth/token');

// ---------- /mcp challenge under the prefix ----------
{
  let r = await app.inject({ method: 'POST', url: '/x/mcp', remoteAddress: freshIp(), payload: rpcPing });
  eq(r.statusCode, 401, '/x/mcp without a credential → 401');
  const w = r.headers['www-authenticate'];
  check(typeof w === 'string' && w.startsWith('Bearer '), `challenge is a Bearer challenge (got ${w})`);
  check(w.includes(`resource_metadata="${PRM_URL}"`), `challenge names the path-inserted document (got ${w})`);
  check(w.includes('scope="projects"'), 'challenge names the scope');
  check(!w.includes('invalid_token'), 'no credential → no error="invalid_token"');
  r = await app.inject({ method: 'POST', url: '/x/mcp', remoteAddress: freshIp(), headers: { authorization: 'Bearer aldn_wrongwrongwrongwrong' }, payload: rpcPing });
  check(r.statusCode === 401 && r.headers['www-authenticate'].includes('error="invalid_token"'), 'rejected credential → error="invalid_token"');
  check(r.headers['www-authenticate'].includes(`resource_metadata="${PRM_URL}"`), 'rejected credential → the same path-inserted document');
}

// ---------- the endpoints the AS document names are reachable under the prefix ----------
{
  let r = await get('/x/oauth/authorize?client_id=x');
  eq(r.statusCode, 200, '/x/oauth/authorize serves the consent page');
  check(r.headers['content-type'].startsWith('text/html'), 'consent page is html');
  check(r.body.includes('aldine-base-path'), 'consent page is the rendered SPA under the prefix');
  isJson404(await get('/oauth/authorize?client_id=x'), '/oauth/authorize');
  r = await app.inject({ method: 'POST', url: '/x/oauth/token', remoteAddress: freshIp(), headers: FORM, payload: form({ grant_type: 'password' }) });
  eq(r.statusCode, 400, '/x/oauth/token answers under the prefix');
  eq(r.json().error, 'unsupported_grant_type', '/x/oauth/token is the token endpoint');
}

// ---------- DCR → consent → token → /mcp, all through the prefix ----------
{
  const user = await auth.register('ada@example.com', 'password123', 'Ada');
  const cookie = `aldine_session=${await auth.createSession(user.id)}`;
  let r = await app.inject({ method: 'POST', url: '/x/oauth/register', remoteAddress: freshIp(), payload: { redirect_uris: [REDIRECT], client_name: 'Prefix connector', token_endpoint_auth_method: 'none' } });
  eq(r.statusCode, 201, `register under the prefix → 201 (${r.body})`);
  const clientId = r.json().client_id;

  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st4te', scope: 'projects' };
  const consent = (extra) => app.inject({ method: 'POST', url: '/x/api/oauth/consent', remoteAddress: freshIp(), headers: { cookie }, payload: { ...params, decision: 'allow', projectIds: null, ...extra } });

  r = await consent({ resource: `${ISSUER}/mcp` });
  eq(r.statusCode, 200, `consent under the prefix → 200 (${r.body})`);
  let redirect = new URL(r.json().redirectTo);
  check(redirect.origin + redirect.pathname === REDIRECT, 'consent redirects to the registered redirect_uri');
  const code = redirect.searchParams.get('code');
  check(code, 'consent issued a code');
  eq(redirect.searchParams.get('iss'), ISSUER, 'iss carries the prefix');

  r = await consent({ resource: 'https://aldine.test/mcp' });
  redirect = new URL(r.json().redirectTo);
  eq(redirect.searchParams.get('error'), 'invalid_target', 'the unprefixed resource is not ours');

  r = await app.inject({ method: 'POST', url: '/x/oauth/token', remoteAddress: freshIp(), headers: FORM, payload: form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${ISSUER}/mcp` }) });
  eq(r.statusCode, 200, `exchange under the prefix → 200 (${r.body})`);
  const token = r.json().access_token;
  check(typeof token === 'string' && token.startsWith('aldn_'), 'access token minted');
  r = await get('/x/mcp', { authorization: `Bearer ${token}` });
  eq(r.statusCode, 405, 'the OAuth token authenticates on /x/mcp (GET → 405)');
  isJson404(await get('/mcp', { authorization: `Bearer ${token}` }), '/mcp with a valid token');
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('oauth base-path: ok');
