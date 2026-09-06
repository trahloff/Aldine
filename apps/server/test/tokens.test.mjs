/**
 * Personal access tokens + contentVersion exposure: digest lookup, expiry,
 * revocation, the lastUsedAt throttle, the preHandler scope check, the
 * token-routes-are-session-only rule, and the PUT /file version_conflict path.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore — env must be set before any src import, since AUTH_ENABLED and
 * the data/meta roots are read at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-pat-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const user = await auth.register('ada@example.com', 'password123', 'Ada');
const other = await auth.register('bob@example.com', 'password123', 'Bob');
const cookie = `aldine_session=${await auth.createSession(user.id)}`;

// ---- digest lookup ----
const { token, record } = await auth.createAccessToken(user.id, 'CI agent', null, null);
check(token.startsWith('aldn_'), 'token carries the aldn_ prefix');
const hit = await auth.userFromToken(`Bearer ${token}`);
check(hit?.user.id === user.id, 'digest lookup resolves the owning user');
check(hit?.tokenScope.projectIds === null, 'unscoped token has projectIds null');
check(hit?.tokenScope.tokenId === record.id, 'tokenScope names the token');
check((await auth.userFromToken(`Bearer aldn_${'x'.repeat(43)}`)) === null, 'unknown token resolves to null');
check((await auth.userFromToken(`Bearer ${token.slice(0, -1)}`)) === null, 'near-miss token resolves to null');
check((await auth.userFromToken('Bearer not-a-token')) === null, 'non-aldn bearer resolves to null');
check((await auth.userFromToken(undefined)) === null, 'missing header resolves to null');

// ---- lastUsedAt throttle ----
const afterFirst = (await db().getToken(record.id)).lastUsedAt;
check(afterFirst !== null, 'first use stamps lastUsedAt');
await auth.userFromToken(`Bearer ${token}`);
check((await db().getToken(record.id)).lastUsedAt === afterFirst, 'second use within a minute does not rewrite lastUsedAt');
const backdated = new Date(Date.now() - 90_000).toISOString();
await db().updateToken({ ...(await db().getToken(record.id)), lastUsedAt: backdated });
await auth.userFromToken(`Bearer ${token}`);
check((await db().getToken(record.id)).lastUsedAt !== backdated, 'use after the throttle window re-stamps lastUsedAt');

// ---- expiry ----
const expired = await auth.createAccessToken(user.id, 'Expired', null, new Date(Date.now() - 1000).toISOString());
check((await auth.userFromToken(`Bearer ${expired.token}`)) === null, 'expired token is rejected');
const future = await auth.createAccessToken(user.id, 'Future', null, new Date(Date.now() + 3600_000).toISOString());
check((await auth.userFromToken(`Bearer ${future.token}`)) !== null, 'unexpired token is accepted');

// ---- revocation ----
const doomed = await auth.createAccessToken(user.id, 'Doomed', null, null);
check((await auth.revokeAccessToken(other.id, doomed.record.id)) === false, 'another user cannot revoke the token');
check((await auth.revokeAccessToken(user.id, doomed.record.id)) === true, 'the owner revokes the token');
check((await auth.userFromToken(`Bearer ${doomed.token}`)) === null, 'revoked token is rejected');
check(!(await auth.listAccessTokens(user.id)).some((t) => t.id === doomed.record.id), 'revoked token leaves the listing');

// ---- routes: bearer auth + scope check ----
const projA = await store.createProject('A', { 'main.tex': 'aaa' }, user.id);
const projB = await store.createProject('B', { 'main.tex': 'bbb' }, user.id);
const scoped = await auth.createAccessToken(user.id, 'Scoped', [projA.id], null);
const bearer = { authorization: `Bearer ${scoped.token}` };

let res = await app.inject({ method: 'GET', url: `/api/projects/${projA.id}/files?branch=main`, headers: bearer });
check(res.statusCode === 200, `in-scope project readable via bearer (got ${res.statusCode})`);
check(typeof res.json().contentVersion === 'number', '/files listing carries contentVersion');
check(Array.isArray(res.json().files), '/files listing carries the files array');

res = await app.inject({ method: 'GET', url: `/api/projects/${projB.id}/files?branch=main`, headers: bearer });
check(res.statusCode === 403, `out-of-scope project rejected with 403 (got ${res.statusCode})`);

res = await app.inject({ method: 'GET', url: `/api/projects/${projA.id}/files?branch=main`, headers: { authorization: 'Bearer aldn_bogusbogusbogus', cookie } });
check(res.statusCode === 401, `invalid bearer stays anonymous — no cookie fallback (got ${res.statusCode})`);

// ---- bearer tokens stay off account surfaces ----
// changePassword skips current-password verification when the stored hash is
// empty (OAuth accounts), so a leaked token must never reach /api/auth/password.
const sso = await auth.register('sso@example.com', '', 'Sso', 'github');
const ssoTok = await auth.createAccessToken(sso.id, 'Leaked', null, null);
res = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { authorization: `Bearer ${ssoTok.token}` }, payload: { currentPassword: 'x', newPassword: 'attacker-pw' } });
check(res.statusCode === 403, `bearer cannot set an account password (got ${res.statusCode})`);
check(res.headers['set-cookie'] === undefined, 'refused password change mints no session cookie');
check((await db().findUserByEmail('sso@example.com')).hash === '', 'the OAuth account still has no password');

const fullTok = await auth.createAccessToken(user.id, 'Full', null, null);
const fullBearer = { authorization: `Bearer ${fullTok.token}` };
for (const [method, url, payload] of [
  ['GET', '/api/github/repos', undefined],
  ['POST', '/api/github/connect', { token: 'ghp_x' }],
  ['POST', '/api/github/disconnect', undefined],
  ['POST', '/api/github/import', { fullName: 'a/b' }],
]) {
  res = await app.inject({ method, url, headers: fullBearer, ...(payload ? { payload } : {}) });
  check(res.statusCode === 403, `${method} ${url} via bearer → 403 (got ${res.statusCode})`);
}

// A project-scoped token must not enumerate projects beyond its scope; an
// all-projects token may list them (that IS its scope). Identity stays readable.
res = await app.inject({ method: 'GET', url: '/api/projects', headers: bearer });
check(res.statusCode === 403, `scoped bearer cannot list projects (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: '/api/projects', headers: fullBearer });
check(res.statusCode === 200, `unscoped bearer lists the user's projects (got ${res.statusCode})`);
res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer });
check(res.statusCode === 200 && res.json().user.id === user.id, 'bearer can read /api/auth/me');

// ---- token routes are session-cookie only ----
for (const [method, url, payload] of [
  ['GET', '/api/tokens', undefined],
  ['POST', '/api/tokens', { name: 'x' }],
  ['DELETE', `/api/tokens/${record.id}`, undefined],
]) {
  res = await app.inject({ method, url, headers: bearer, ...(payload ? { payload } : {}) });
  check(res.statusCode === 403, `${method} ${url} with a bearer token → 403 (got ${res.statusCode})`);
}
res = await app.inject({ method: 'GET', url: '/api/tokens' });
check(res.statusCode === 401, 'token routes without any credential → 401');

res = await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie } });
check(res.statusCode === 200, 'cookie session lists tokens');
check(res.json().every((t) => t.hash === undefined && t.token === undefined), 'listing never leaks digests or secrets');

res = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'Minted', projectIds: [projA.id] } });
check(res.statusCode === 200 && res.json().token.startsWith('aldn_'), 'POST /api/tokens returns the plaintext once');
const minted = res.json();
res = await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie } });
check(res.json().some((t) => t.id === minted.id && t.token === undefined), 'minted token listed without its secret');
res = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: '' } });
check(res.statusCode === 400, 'empty token name → 400');
res = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'x', expiresAt: 'yesterday-ish' } });
check(res.statusCode === 400, 'unparseable expiresAt → 400');
res = await app.inject({ method: 'DELETE', url: `/api/tokens/${minted.id}`, headers: { cookie } });
check(res.statusCode === 200 && res.json().ok === true, 'DELETE revokes via the route');
res = await app.inject({ method: 'DELETE', url: `/api/tokens/${minted.id}`, headers: { cookie } });
check(res.statusCode === 404, 'revoking an already-revoked token → 404');

// ---- contentVersion header + the version_conflict path ----
res = await app.inject({ method: 'GET', url: `/api/projects/${projA.id}/file?branch=main&path=main.tex`, headers: { cookie } });
check(res.statusCode === 200, 'GET /file works');
const v = Number(res.headers['x-aldine-content-version']);
check(Number.isFinite(v), 'GET /file returns x-aldine-content-version');

res = await app.inject({ method: 'PUT', url: `/api/projects/${projA.id}/file`, headers: { cookie }, payload: { branch: 'main', path: 'main.tex', content: 'CLOBBER', baseVersion: v + 1 } });
check(res.statusCode === 409, `stale baseVersion → 409 (got ${res.statusCode})`);
{
  const body = res.json();
  check(body.error === 'version_conflict' && body.currentVersion === v && typeof body.fileVersion === 'number', '409 body names currentVersion and fileVersion');
}
check(store.readFile(projA.id, 'main', 'main.tex').toString('utf8') === 'aaa', 'conflicting write left disk untouched');

res = await app.inject({ method: 'PUT', url: `/api/projects/${projA.id}/file`, headers: { cookie }, payload: { branch: 'main', path: 'main.tex', content: 'updated', baseVersion: v } });
check(res.statusCode === 200, 'matching baseVersion writes');
check(store.readFile(projA.id, 'main', 'main.tex').toString('utf8') === 'updated', 'matching write reached disk');
res = await app.inject({ method: 'GET', url: `/api/projects/${projA.id}/file?branch=main&path=main.tex`, headers: { cookie } });
check(Number(res.headers['x-aldine-content-version']) > v, 'a write bumps the served version');

res = await app.inject({ method: 'PUT', url: `/api/projects/${projA.id}/file`, headers: { cookie }, payload: { branch: 'main', path: 'main.tex', content: 'no version given' } });
check(res.statusCode === 200, 'PUT without baseVersion still writes (opt-in concurrency)');

// ---- conflicts are per file: a sibling write does not stale main.tex ----
res = await app.inject({ method: 'GET', url: `/api/projects/${projA.id}/file?branch=main&path=main.tex`, headers: { cookie } });
const v2 = Number(res.headers['x-aldine-content-version']);
const fv2 = Number(res.headers['x-aldine-file-version']);
check(Number.isFinite(fv2), 'GET /file returns x-aldine-file-version');
check(fv2 <= v2, 'the file version never exceeds the branch version');
res = await app.inject({ method: 'PUT', url: `/api/projects/${projA.id}/file`, headers: { cookie }, payload: { branch: 'main', path: 'notes-sibling.tex', content: 'a sibling file' } });
check(res.statusCode === 200, 'sibling write lands');
res = await app.inject({ method: 'PUT', url: `/api/projects/${projA.id}/file`, headers: { cookie }, payload: { branch: 'main', path: 'main.tex', content: 'after sibling', baseVersion: v2 } });
check(res.statusCode === 200, `a sibling write does not stale main.tex baseVersion → 200 (got ${res.statusCode})`);
check(store.readFile(projA.id, 'main', 'main.tex').toString('utf8') === 'after sibling', 'the per-file check let the write through');
res = await app.inject({ method: 'PUT', url: `/api/projects/${projA.id}/file`, headers: { cookie }, payload: { branch: 'main', path: 'main.tex', content: 'stale again', baseVersion: v2 } });
check(res.statusCode === 409 && res.json().fileVersion > v2, 'the same base is stale once main.tex itself changed');

// ---- collab onAuthenticate: a presented bearer is authoritative ----
const { hocuspocus } = await import('../src/collab.ts');
const onAuth = (documentName, requestHeaders) => hocuspocus.configuration.onAuthenticate({ documentName, requestHeaders });
const doc = `${projA.id}::main::main.tex`;
const wsTok = await auth.createAccessToken(user.id, 'Ws', [projA.id], null);
await onAuth(doc, { authorization: `Bearer ${wsTok.token}` });
check(true, 'collab accepts a live bearer');
await onAuth(doc, { cookie });
check(true, 'collab accepts a session cookie');
let refused = false;
try { await onAuth(`${projB.id}::main::main.tex`, { authorization: `Bearer ${wsTok.token}`, cookie }); } catch { refused = true; }
check(refused, 'collab refuses an out-of-scope bearer even alongside a valid cookie');
await auth.revokeAccessToken(user.id, wsTok.record.id);
refused = false;
try { await onAuth(doc, { authorization: `Bearer ${wsTok.token}`, cookie }); } catch { refused = true; }
check(refused, 'collab refuses a revoked bearer — no cookie fallback');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Tokens + contentVersion: ALL PASSED');
// The PUT routes scheduled 20 s auto-commit debounce timers (not unref'd);
// exit instead of idling until they fire against the deleted temp dir.
process.exit(0);
