import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { execSync } from 'node:child_process';

/**
 * Deleting a project must take its GitLab project with it.
 *
 * The mock here reproduces GitLab's *real* deletion semantics, which the older
 * mocks did not: a DELETE only marks a project for deletion and keeps it in the
 * group for a retention period (default on every tier since GitLab 18.0), and
 * purging it needs a second DELETE with permanently_remove. A mock that removes
 * the project on the first call makes this whole path look green while the repo
 * is still sitting in the group weeks later.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-gldel-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
const BARES = path.join(tmp, 'bares'); fs.mkdirSync(BARES, { recursive: true });

const GROUPS = { 'research/latex': { id: 100, full_path: 'research/latex', name: 'latex' } };
const byId = (id) => Object.values(GROUPS).find((g) => g.id === id);

const projects = {};
let nextId = 10;
let mockDown = false;
/** null = an instance that deletes immediately; a date = delayed deletion. */
let retention = null;
/** GitLab frees the path when it marks a project, so the old path 404s. */
let renameOnMark = false;
let allowPurge = true;
let calls = [];

function bareFor(full) {
  const bare = path.join(BARES, `${full.replace(/\//g, '__')}.git`);
  if (!fs.existsSync(bare)) execSync(`git init --bare -b main "${bare}"`, { stdio: 'ignore' });
  return `file://${bare}`;
}
const find = (key) => projects[key] || Object.values(projects).find((p) => String(p.id) === key);

const mock = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (mockDown) return send(503, { message: 'gitlab is down' });
  const u = new URL(req.url, 'http://mock');
  const p = u.pathname;
  if (p === '/api/v4/user') return send(200, { username: 'tester', name: 'Tester' });

  const g = p.match(/^\/api\/v4\/groups\/([^/]+)$/);
  if (g && req.method === 'GET') {
    const found = GROUPS[decodeURIComponent(g[1])];
    return found ? send(200, found) : send(404, { message: '404 Group Not Found' });
  }

  if (p === '/api/v4/projects' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const group = byId(body.namespace_id);
      if (!group) return send(400, { message: 'no such namespace' });
      const full = `${group.full_path}/${body.path}`;
      const proj = {
        id: nextId++, path_with_namespace: full, path: body.path, namespace: group,
        visibility: body.visibility, default_branch: 'main',
        http_url_to_repo: bareFor(full), last_activity_at: new Date().toISOString(),
      };
      projects[full] = proj;
      send(201, proj);
    });
    return;
  }

  const pm = p.match(/^\/api\/v4\/projects\/([^/]+)$/);
  if (pm) {
    const key = decodeURIComponent(pm[1]);
    const proj = find(key);
    if (req.method === 'DELETE') {
      if (u.searchParams.get('permanently_remove') === 'true') {
        calls.push({ kind: 'purge', full: u.searchParams.get('full_path') });
        if (!allowPurge) return send(403, { message: '403 Forbidden: immediate deletion is restricted' });
        if (!proj) return send(404, { message: '404 Project Not Found' });
        if (!proj.marked_for_deletion_on) return send(400, { message: 'Project must be marked for deletion first' });
        delete projects[proj.path_with_namespace];
        return send(202, { message: '202 Accepted' });
      }
      if (!proj) return send(404, { message: '404 Project Not Found' });
      calls.push({ kind: 'mark', full: proj.path_with_namespace });
      delete projects[proj.path_with_namespace];
      if (!retention) return send(202, { message: '202 Accepted' });
      proj.marked_for_deletion_on = retention;
      if (renameOnMark) proj.path_with_namespace = `${proj.path_with_namespace}-deleted-${proj.id}`;
      projects[proj.path_with_namespace] = proj;
      return send(202, { message: '202 Accepted' });
    }
    return proj ? send(200, proj) : send(404, { message: '404 Project Not Found' });
  }
  send(404, { message: 'not mocked' });
});
await new Promise((r) => mock.listen(0, r));
process.env.GITLAB_API_BASE = `http://localhost:${mock.address().port}/api/v4`;
process.env.GITLAB_TOKEN = 'svc';
process.env.GITLAB_DEFAULT_GROUP = 'research/latex';

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };

const metaPath = (id) => path.join(process.env.META_DIR, 'meta', `${id}.json`);
const metaOf = (id) => JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
const patchMeta = (id, fn) => { const m = metaOf(id); fn(m); fs.writeFileSync(metaPath(id), JSON.stringify(m)); };
const gone = (full) => !Object.values(projects).some((p) => p.path_with_namespace.startsWith(full));

async function makeProject(name) {
  const r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
  check(r.statusCode === 200 && J(r).remote?.fullName, `provisioned ${name}: ${r.body}`);
  calls = [];
  return J(r);
}

// --- an instance that deletes immediately: one call is enough ---
retention = null;
let p = await makeProject('Instant');
let r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(r.statusCode === 200, 'delete ok: ' + r.body);
check(J(r).remoteDelete?.deleted === true, 'reports the remote as deleted: ' + r.body);
check(gone('research/latex/instant'), 'the GitLab project is gone');
check(calls.filter((c) => c.kind === 'purge').length === 0, 'no purge needed when the instance deleted it outright');

// --- delayed deletion: the second delete is what actually removes it ---
retention = '2026-10-02';
p = await makeProject('Delayed');
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(J(r).remoteDelete?.deleted === true, 'reports the remote as deleted: ' + r.body);
check(gone('research/latex/delayed'), 'the GitLab project is really gone, not just scheduled');
check(calls.some((c) => c.kind === 'purge' && c.full === 'research/latex/delayed'),
  'purged by full path: ' + JSON.stringify(calls));

// --- GitLab renames the project when it marks it, so the old path 404s ---
renameOnMark = true;
p = await makeProject('Renamed');
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(J(r).remoteDelete?.deleted === true, 'a renamed pending project is still found: ' + r.body);
check(gone('research/latex/renamed'), 'the renamed GitLab project is gone');
check(calls.some((c) => c.kind === 'purge' && /-deleted-\d+$/.test(c.full || '')),
  'purge used the path GitLab moved it to: ' + JSON.stringify(calls));
renameOnMark = false;

// --- a purge the instance refuses is reported, with the date GitLab will do it ---
allowPurge = false;
p = await makeProject('Stubborn');
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(r.statusCode === 200, 'the local delete still goes through: ' + r.body);
check(J(r).remoteDelete?.deleted === false, 'not claimed as deleted');
check(J(r).remoteDelete?.scheduledFor === '2026-10-02', 'says when GitLab will remove it: ' + r.body);
check(/2026-10-02/.test(J(r).remoteDelete?.reason || ''), 'the reason names the date: ' + J(r).remoteDelete?.reason);
check((await app.inject({ method: 'GET', url: '/api/projects/trash' })).body.includes(p.id), 'project is in the trash');
allowPurge = true;

// --- the regression: a link written before provenance was recorded ---
// Projects auto-provisioned before createdByAldine existed carry no flag, and
// were silently treated as imports — their GitLab project outlived them.
p = await makeProject('Legacy');
patchMeta(p.id, (m) => { delete m.remote.createdByAldine; });
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(J(r).remoteDelete?.deleted === true, 'an unflagged link inside the configured group is Aldine\'s: ' + r.body);
check(gone('research/latex/legacy'), 'its GitLab project is gone too');

// --- but an unflagged link OUTSIDE the group is an import, and stays ---
p = await makeProject('Outsider');
patchMeta(p.id, (m) => { delete m.remote.createdByAldine; m.remote.fullName = 'someone/else/paper'; });
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(J(r).remoteDelete?.deleted === false, 'left alone');
check(/import/i.test(J(r).remoteDelete?.reason || ''), 'says why: ' + J(r).remoteDelete?.reason);
check(calls.length === 0, 'GitLab was not called at all: ' + JSON.stringify(calls));

// --- an explicitly imported repo is never deleted ---
p = await makeProject('Imported');
patchMeta(p.id, (m) => { m.remote.createdByAldine = false; });
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(J(r).remoteDelete?.deleted === false, 'an imported repo is left alone');
check(calls.length === 0, 'no GitLab calls for an import: ' + JSON.stringify(calls));
check(!gone('research/latex/imported'), 'the imported repo still exists');

// --- a project with no remote says nothing about one ---
delete process.env.GITLAB_TOKEN;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Local Only' } });
const localId = J(r).id;
process.env.GITLAB_TOKEN = 'svc';
calls = [];
r = await app.inject({ method: 'DELETE', url: `/api/projects/${localId}` });
check(r.statusCode === 200 && !J(r).remoteDelete, 'no remote, no remoteDelete: ' + r.body);
check(calls.length === 0, 'no GitLab calls for a local-only project');

// --- an unreachable GitLab never blocks the delete, and says what happened ---
p = await makeProject('Offline');
mockDown = true;
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
mockDown = false;
check(r.statusCode === 200, 'delete still succeeds: ' + r.body);
check(J(r).remoteDelete?.deleted === false && J(r).remoteDelete?.reason, 'reports the failure: ' + r.body);
check(metaOf(p.id).remote?.fullName === 'research/latex/offline', 'the link is kept so the purge sweep can retry');

// --- the purge sweep retries the ones that failed ---
const store = await import('../src/store.ts');
const { deleteRemoteRepo } = await import('../src/provision.ts');
patchMeta(p.id, (m) => { m.deletedAt = '2020-01-01T00:00:00.000Z'; });
calls = [];
const purged = await store.purgeExpiredTrash(30, async (m) => { await deleteRemoteRepo(m); });
check(purged.includes(p.id), 'the sweep purged the expired project');
check(gone('research/latex/offline'), 'and finally removed its GitLab project');

await app.close();
mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('gitlab-delete.integration: OK');
