/**
 * The global guard's rules for routes without a project id (sign-in for the
 * project list, create, import and trash; the short list of routes an access
 * token may use off the project surface) and its trash exemptions hold
 * however the path is spelled. The router decodes percent-encoded segments
 * before it picks the route, so the guard decides on the matched route
 * pattern, never on the raw URL. A project is never created without an owner
 * while accounts are on.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { buildZip } from './zip.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-encoded-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const user = await auth.register('ada@example.com', 'password123', 'Ada');
const cookie = `aldine_session=${await auth.createSession(user.id)}`;
const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const zipBase64 = buildZip({ 'main.tex': doc }).toString('base64');
const projectCount = async () => (await store.listProjects()).length;

try {
  // ---- anonymous: list, create, import and trash need a session ----
  const before = await projectCount();
  const anonymous = [
    ['GET', '/api/projects'], ['GET', '/api/pr%6Fjects'], ['GET', '/%61pi/projects'], ['GET', '/api/%70rojects'],
    ['POST', '/api/projects'], ['POST', '/api/pr%6Fjects'], ['POST', '/%61pi/projects'],
    ['POST', '/api/projects/import'], ['POST', '/api/projects/%69mport'], ['POST', '/api/pr%6Fjects/import'],
    ['GET', '/api/projects/trash'], ['GET', '/api/projects/tr%61sh'],
  ];
  for (const [method, url] of anonymous) {
    const payload = method === 'POST' ? (url.includes('mport') ? { name: 'Z', zipBase64 } : { name: 'P' }) : undefined;
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    eq(res.statusCode, 401, `anonymous ${method} ${url} → 401`);
  }
  // Refused before the body is parsed: a multipart body without a boundary
  // would fail in the parser (400) if it were read first.
  for (const url of ['/api/projects/import', '/api/projects/%69mport']) {
    const res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'multipart/form-data' }, payload: Buffer.alloc(1024 * 1024, 0x41) });
    eq(res.statusCode, 401, `anonymous multipart ${url} → 401 before the body is read`);
  }
  eq(await projectCount(), before, 'no project was created without a session');
  check(!(await store.listProjects()).some((m) => !m.ownerId), 'no ownerless project exists');

  // ---- signed in: the same routes work, and what they create has an owner ----
  let res = await app.inject({ method: 'POST', url: '/api/pr%6Fjects', headers: { cookie }, payload: { name: 'Mine' } });
  eq(res.statusCode, 200, 'signed-in create through an encoded path → 200');
  eq(res.json().ownerId, user.id, 'the created project is owned by the caller');
  res = await app.inject({ method: 'POST', url: '/api/projects/import', headers: { cookie }, payload: { name: 'Zipped', zipBase64 } });
  eq(res.statusCode, 200, 'signed-in import → 200');
  eq(res.json().ownerId, user.id, 'the imported project is owned by the caller');

  // ---- access tokens: off the project surface, only the listed routes ----
  const { token } = await auth.createAccessToken(user.id, 'Agent', null, null);
  const scoped = await auth.createAccessToken(user.id, 'Scoped', [res.json().id], null);
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  for (const url of ['/api/auth/password', '/%61pi/auth/password', '/api/auth/p%61ssword']) {
    res = await app.inject({ method: 'POST', url, headers: bearer(token), payload: { currentPassword: 'password123', newPassword: 'hijacked123' } });
    eq(res.statusCode, 403, `a token on ${url} → 403`);
  }
  check((await auth.login('ada@example.com', 'password123').catch(() => null)) !== null, 'the password is unchanged');
  for (const url of ['/api/tokens', '/%61pi/tokens']) {
    res = await app.inject({ method: 'GET', url, headers: bearer(token) });
    eq(res.statusCode, 403, `a token on ${url} → 403`);
  }
  for (const url of ['/api/projects', '/api/pr%6Fjects', '/%61pi/projects']) {
    res = await app.inject({ method: 'GET', url, headers: bearer(scoped.token) });
    eq(res.statusCode, 403, `a project-scoped token listing ${url} → 403`);
  }
  for (const url of ['/api/auth/me', '/%61pi/auth/me']) {
    res = await app.inject({ method: 'GET', url, headers: bearer(token) });
    eq(res.statusCode, 200, `a token on the neutral ${url} → 200`);
  }
  res = await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(token) });
  eq(res.statusCode, 200, 'an unscoped token lists projects');

  // ---- trash: only restore and purge reach a trashed project ----
  const trashed = await store.createProject('Old', { 'main.tex': doc }, user.id);
  await store.softDeleteProject(trashed.id);
  res = await app.inject({ method: 'DELETE', url: `/api/projects/${trashed.id}/comments/restore`, headers: { cookie } });
  eq(res.statusCode, 404, 'a route that merely ends in /restore treats a trashed project as gone');
  res = await app.inject({ method: 'GET', url: `/api/projects/${trashed.id}/files`, headers: { cookie } });
  eq(res.statusCode, 404, 'a trashed project lists no files');
  res = await app.inject({ method: 'POST', url: `/api/projects/${trashed.id}/rest%6Fre`, headers: { cookie } });
  eq(res.statusCode, 200, 'restore reaches a trashed project');
  check(!(await store.readMeta(trashed.id)).deletedAt, 'the project is restored');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('encoded-route-guards: all assertions passed');
process.exit(0);
