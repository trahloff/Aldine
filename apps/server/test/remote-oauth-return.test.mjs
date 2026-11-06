/**
 * "Connect with <host>" started inside a project comes back to that project:
 * the start route keeps a `return` of the form /p/<id> in the state cookie and
 * the callback redirects there. Anything else (another origin, a scheme, a
 * path outside /p/<id>, traversal) is dropped on the way in and again on the
 * way out, so the cookie can never become an open redirect; such a connect
 * falls back to Home's import dialog as before. A `reopen` naming the dialog
 * the connect started from (publish or access, nothing else) rides along and
 * comes back as `?remote=<host>&reopen=<dialog>`. The status route names the
 * instance a token connect without a URL reaches, for the token-page link.
 *
 * GitLab OAuth against a loopback stub (GITLAB_URL for authorize and token,
 * GITLAB_API_BASE for /user); GitHub's start route only, which needs no
 * network. Auth is off. Env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const stub = http.createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'POST' && req.url === '/oauth/token') return json(200, { access_token: 'gl-oauth-token' });
  if (req.method === 'GET' && req.url === '/api/v4/user') return json(200, { username: 'oauth-user', name: 'OAuth User' });
  json(404, { message: 'Not Found' });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const GITLAB = `http://127.0.0.1:${stub.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-remote-oauth-'));
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.GITLAB_URL = GITLAB;
process.env.GITLAB_API_BASE = `${GITLAB}/api/v4`;
process.env.GITLAB_CLIENT_ID = 'gl-client';
process.env.GITLAB_CLIENT_SECRET = 'gl-secret';
process.env.GITHUB_CLIENT_ID = 'gh-client';
process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PUBLIC_URL', 'ALDINE_BASE_PATH', 'REMOTE_PROVIDERS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

/** Start a connect; returns the state cookie's value (still encoded) and the state sent to the host. */
async function start(url) {
  const r = await app.inject({ method: 'GET', url });
  eq(r.statusCode, 302, `${url} redirects to the host`);
  const set = String(r.headers['set-cookie']);
  const value = /aldine_remote_state=([^;]*)/.exec(set)?.[1] ?? '';
  const state = new URL(r.headers.location).searchParams.get('state');
  return { value, state, location: r.headers.location };
}
const callback = (state, value) => app.inject({ method: 'GET', url: `/api/remotes/gitlab/oauth/callback?code=c0de&state=${state}`, headers: { cookie: `aldine_remote_state=${value}` } });

// ---- started in a project: back to that project ----
{
  const s = await start('/api/remotes/gitlab/oauth?return=%2Fp%2Fabc123');
  check(s.location.startsWith(`${GITLAB}/oauth/authorize?`), `authorize on the configured instance (${s.location})`);
  eq(s.value, `gitlab.${s.state}.${encodeURIComponent('/p/abc123')}`, 'the cookie carries the return path');
  const r = await callback(s.state, s.value);
  eq(r.statusCode, 302, `callback redirects (${r.body})`);
  eq(r.headers.location, '/p/abc123', 'to the project the connect started in');
}

// ---- started in a dialog: back to the project, which reopens it ----
for (const dialog of ['publish', 'access']) {
  const s = await start(`/api/remotes/gitlab/oauth?return=%2Fp%2Fabc123&reopen=${dialog}`);
  eq(s.value, `gitlab.${s.state}.${encodeURIComponent('/p/abc123')}.${dialog}`, `the cookie carries the dialog (${dialog})`);
  const r = await callback(s.state, s.value);
  eq(r.headers.location, `/p/abc123?remote=gitlab&reopen=${dialog}`, `the callback names host and dialog (${dialog})`);
}

// ---- a dialog name outside the list, or without a project, is dropped ----
for (const bad of ['settings', 'publish.access', 'PUBLISH', '"><script>', '']) {
  const s = await start(`/api/remotes/gitlab/oauth?return=%2Fp%2Fabc123&reopen=${encodeURIComponent(bad)}`);
  eq(s.value, `gitlab.${s.state}.${encodeURIComponent('/p/abc123')}`, `reopen ${JSON.stringify(bad)} is not stored`);
  eq((await callback(s.state, s.value)).headers.location, '/p/abc123', `and the project opens without it (${JSON.stringify(bad)})`);
}
{
  const s = await start('/api/remotes/gitlab/oauth?reopen=publish');
  eq(s.value, `gitlab.${s.state}`, 'a dialog without a project to open it in is not stored');
  eq((await callback(s.state, s.value)).headers.location, '/?remote=gitlab', 'Home, as before');
}
// a forged cookie can name a listed dialog at most, and nothing past it
for (const [forged, location] of [['/p/abc.settings', '/p/abc'], ['/p/abc.publish.x', '/?remote=gitlab'], ['/p/abc.access', '/p/abc?remote=gitlab&reopen=access']]) {
  const s = await start('/api/remotes/gitlab/oauth');
  const r = await callback(s.state, `gitlab.${s.state}.${encodeURIComponent(forged)}`);
  eq(r.headers.location, location, `forged ${JSON.stringify(forged)}`);
}

// ---- no return: Home's import dialog, as before ----
{
  const s = await start('/api/remotes/gitlab/oauth');
  eq(s.value, `gitlab.${s.state}`, 'the cookie carries only provider and state');
  const r = await callback(s.state, s.value);
  eq(r.headers.location, '/?remote=gitlab', 'callback opens the import dialog on Home');
}

// ---- anything but /p/<id> is dropped on the way in ----
for (const bad of ['//evil.example', 'https://evil.example/p/abc', '/\\evil.example', '/p/abc/../../admin', '/p/abc?x=1', '/p/', '/x', 'p/abc', '/p/abc%2F..']) {
  const s = await start(`/api/remotes/gitlab/oauth?return=${encodeURIComponent(bad)}`);
  eq(s.value, `gitlab.${s.state}`, `return ${JSON.stringify(bad)} is not stored`);
  const r = await callback(s.state, s.value);
  eq(r.headers.location, '/?remote=gitlab', `and the callback goes to Home (${JSON.stringify(bad)})`);
}

// ---- and again on the way out: a cookie set by anyone else cannot redirect elsewhere ----
for (const forged of ['//evil.example', 'https://evil.example', '/p/abc/../x']) {
  const s = await start('/api/remotes/gitlab/oauth');
  const r = await callback(s.state, `gitlab.${s.state}.${encodeURIComponent(forged)}`);
  eq(r.statusCode, 302, `a forged return ${JSON.stringify(forged)} still connects`);
  eq(r.headers.location, '/?remote=gitlab', `but is not followed (${JSON.stringify(forged)})`);
}

// ---- the state still has to match ----
{
  const s = await start('/api/remotes/gitlab/oauth?return=%2Fp%2Fabc123');
  eq((await callback('0000', s.value)).statusCode, 400, 'a different state is refused');
  eq((await app.inject({ method: 'GET', url: `/api/remotes/github/oauth/callback?code=c&state=${s.state}`, headers: { cookie: `aldine_remote_state=${s.value}` } })).statusCode, 400, "another provider's cookie is refused");
}

// ---- GitHub's start route, generic and legacy paths, keeps the return the same way ----
for (const url of ['/api/remotes/github/oauth?return=%2Fp%2Fgh1', '/api/github/oauth?return=%2Fp%2Fgh1']) {
  const s = await start(url);
  check(s.location.startsWith('https://github.com/login/oauth/authorize?'), `GitHub authorize (${url})`);
  eq(s.value, `github.${s.state}.${encodeURIComponent('/p/gh1')}`, `the cookie carries the return path (${url})`);
}

// ---- the status names the instance a token connect without a URL reaches ----
{
  const r = await app.inject({ method: 'GET', url: '/api/remotes/gitlab/status' });
  eq(r.json().instanceUrl, GITLAB, 'GitLab: the configured instance');
  eq((await app.inject({ method: 'GET', url: '/api/remotes/github/status' })).json().instanceUrl, 'https://github.com', 'GitHub: github.com (GITHUB_URL unset)');
}

await app.close();
stub.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('remote-oauth-return: all assertions passed');
process.exit(0);
