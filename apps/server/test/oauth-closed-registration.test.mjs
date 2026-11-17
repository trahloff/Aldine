/**
 * ALDINE_OAUTH_REGISTRATION=closed: /oauth/register refuses with 403, the
 * discovery document stops advertising registration and metadata documents,
 * a metadata-document client_id is refused without any outbound fetch, and a
 * client added with the oauth:add-client CLI (a separate process on the same
 * datastore) completes the whole consent + token flow.
 *
 * The mode is read per request, so one process covers open and closed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const ISSUER = 'https://aldine.test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-oauth-closed-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = ISSUER;
process.env.ALDINE_TEST_ALLOW_LOOPBACK_CIMD = '1';
delete process.env.DATABASE_URL;
delete process.env.ALDINE_DATASTORE;
delete process.env.REDIS_URL;
delete process.env.ALDINE_MCP_TOKEN;
delete process.env.ALDINE_OAUTH_REGISTRATION;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerMcp } = await import('../src/mcp/server.ts');
const oauth = await import('../src/oauth/index.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);
await registerMcp(app);

let ipCounter = 0;
const freshIp = () => `10.7.0.${1 + ipCounter++}`;
const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const setMode = (v) => { if (v === undefined) delete process.env.ALDINE_OAUTH_REGISTRATION; else process.env.ALDINE_OAUTH_REGISTRATION = v; };
const asMetadata = async () => (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
const register = () => app.inject({ method: 'POST', url: '/oauth/register', remoteAddress: freshIp(), payload: { redirect_uris: [CLAUDE_CB], client_name: 'Anyone' } });
const lookup = (clientId, redirect) => app.inject({
  method: 'GET', remoteAddress: freshIp(),
  url: `/api/oauth/client?${new URLSearchParams({ response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256', client_id: clientId, redirect_uri: redirect })}`,
});

// ---- the setting ----
{
  eq(oauth.registrationMode({}), 'open', 'unset → open');
  eq(oauth.registrationMode({ ALDINE_OAUTH_REGISTRATION: 'Open ' }), 'open', '"Open " → open');
  eq(oauth.registrationMode({ ALDINE_OAUTH_REGISTRATION: 'closed' }), 'closed', 'closed → closed');
  eq(oauth.registrationMode({ ALDINE_OAUTH_REGISTRATION: 'off' }), 'closed', 'an unknown value → closed');
  eq(oauth.registrationConfigWarnings({ ALDINE_OAUTH_REGISTRATION: 'closed' }), [], 'closed → no warning');
  check(oauth.registrationConfigWarnings({ ALDINE_OAUTH_REGISTRATION: 'off' })[0]?.includes('using "closed"'), 'an unknown value is warned about');
}

// ---- open (default): unchanged ----
{
  setMode(undefined);
  const as = await asMetadata();
  eq(as.registration_endpoint, `${ISSUER}/oauth/register`, 'open: registration_endpoint advertised');
  eq(as.client_id_metadata_document_supported, true, 'open: CIMD advertised');
  const r = await register();
  check(r.statusCode === 201, `open: register → 201 (got ${r.statusCode})`);
}

// ---- closed: registration refused, discovery honest ----
const before = await db().countOAuthClients();
{
  setMode('closed');
  const as = await asMetadata();
  check(!('registration_endpoint' in as), 'closed: registration_endpoint omitted');
  eq(as.client_id_metadata_document_supported, false, 'closed: CIMD reported unsupported');
  eq(as.token_endpoint, `${ISSUER}/oauth/token`, 'closed: the rest of the document is unchanged');
  const r = await register();
  check(r.statusCode === 403, `closed: register → 403 (got ${r.statusCode})`);
  eq(r.json().error, 'access_denied', 'closed: RFC 7591 error code');
  check(/registration is closed on this server/i.test(r.json().error_description), `closed: the description says why (got ${r.json().error_description})`);
  check(r.headers['cache-control'] === 'no-store', 'closed: the refusal is no-store');
  eq(await db().countOAuthClients(), before, 'closed: nothing was stored');
}

// ---- closed: a metadata-document client_id is refused before any fetch ----
{
  let hits = 0;
  const stub = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ client_id: `http://127.0.0.1:${stub.address().port}/meta.json`, client_name: 'Claude', redirect_uris: [CLAUDE_CB] }));
  });
  await new Promise((res) => stub.listen(0, '127.0.0.1', res));
  const metaId = `http://127.0.0.1:${stub.address().port}/meta.json`;
  let r = await lookup(metaId, CLAUDE_CB);
  check(r.statusCode === 400 && r.json().error === 'unauthorized_client', `closed: CIMD id → unauthorized_client (got ${r.statusCode} ${r.body})`);
  eq(hits, 0, 'closed: the metadata document was never fetched');
  setMode('open');
  r = await lookup(metaId, CLAUDE_CB);
  check(r.statusCode === 200 && hits === 1, `open: the same CIMD id resolves (got ${r.statusCode}, ${hits} fetch)`);
  setMode('closed');
  stub.close();
}

// ---- closed: an administrator adds Claude with the CLI ----
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli/oauth-add-client.ts');
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));
const runCli = (args) => spawnSync(process.execPath, [tsx, cli, ...args], { env: process.env, encoding: 'utf8' });
let clientId;
{
  let r = runCli(['--name', 'Claude']);
  check(r.status === 2 && /--redirect-uri/.test(r.stderr), `CLI without a redirect → exit 2 (got ${r.status}: ${r.stderr})`);
  r = runCli(['--name', 'Claude', '--redirect-uri', 'http://evil.example/cb']);
  check(r.status === 1 && /https URL or a loopback/.test(r.stderr), `CLI refuses a plain-http redirect (got ${r.status}: ${r.stderr})`);
  r = runCli(['--name', 'Claude', '--redirect-uri', CLAUDE_CB, '--redirect-uri', 'http://localhost/callback', '--json']);
  check(r.status === 0, `CLI → exit 0 (got ${r.status}: ${r.stderr})`);
  const out = JSON.parse(r.stdout);
  clientId = out.client_id;
  check(/^aldc_/.test(clientId), `CLI prints an aldc_ client_id (got ${clientId})`);
  eq(out.redirect_uris, [CLAUDE_CB, 'http://localhost/callback'], 'CLI stores every redirect');
  r = runCli(['--name', 'Claude Code', '--redirect-uri', 'http://localhost/callback']);
  check(r.status === 0 && /client_id: aldc_/.test(r.stdout) && !/still register/.test(r.stdout), `CLI human output (got ${r.stdout})`);
  check(r.stdout.split('\n').every((l) => !l.startsWith('[aldine]')), 'CLI keeps boot lines off stdout');
}

// ---- closed: the pre-registered client completes the flow ----
{
  const stored = await db().getOAuthClient(clientId);
  eq(stored?.name, 'Claude', 'the server process sees the CLI\'s client');
  let r = await lookup(clientId, CLAUDE_CB);
  check(r.statusCode === 200, `lookup of the pre-registered client → 200 (got ${r.statusCode} ${r.body})`);
  eq(r.json().name, 'Claude', 'consent page names it');
  r = await lookup(clientId, 'http://localhost:53122/callback');
  check(r.statusCode === 200, 'its loopback redirect matches on any port');

  const user = await auth.register('ada@example.com', 'password123', 'Ada');
  const cookie = `aldine_session=${await auth.createSession(user.id)}`;
  const { verifier, challenge } = pkce();
  r = await app.inject({
    method: 'POST', url: '/api/oauth/consent', remoteAddress: freshIp(), headers: { cookie },
    payload: { client_id: clientId, redirect_uri: CLAUDE_CB, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'projects', resource: `${ISSUER}/mcp`, decision: 'allow', projectIds: null },
  });
  check(r.statusCode === 200, `consent → 200 (got ${r.statusCode} ${r.body})`);
  const code = new URL(r.json().redirectTo).searchParams.get('code');
  check(code, 'consent issued a code');
  r = await app.inject({
    method: 'POST', url: '/oauth/token', remoteAddress: freshIp(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CB, resource: `${ISSUER}/mcp` }).toString(),
  });
  check(r.statusCode === 200 && r.json().access_token, `token exchange → 200 (got ${r.statusCode} ${r.body})`);
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('OAuth closed registration: ALL PASSED');
process.exit(0);
