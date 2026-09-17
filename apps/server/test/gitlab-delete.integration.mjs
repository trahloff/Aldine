/**
 * Deleting a provisioned project removes it on GitLab (#51 Stage B): the
 * immediate and the delayed-deletion flavours (rename to `<path>-deleted-<id>`,
 * then a purge by numeric id with the renamed full_path), a refused purge
 * that reports `scheduledFor`, an imported repository that is never deleted,
 * restore re-creating the project in its old namespace, and the trash sweep
 * retrying a deletion that failed when the project was trashed.
 *
 * Every env var below must be set before the routes are imported.
 */
import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execSync } from 'node:child_process';
import { startGitlabMock } from './mock-gitlab-api.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-gldel-'));
process.env.DATA_DIR = path.join(tmp, 'data'); process.env.META_DIR = path.join(tmp, 'secrets');
delete process.env.REMOTE_PROVIDERS;
process.env.GITLAB_TOKEN = 'service-token';
process.env.GITLAB_DEFAULT_GROUP = 'research/latex';
process.env.GITLAB_DEFAULT_VISIBILITY = 'internal';
process.env.AUTOPUSH_DEBOUNCE_MS = '50';

const mock = await startGitlabMock({ tmp });
process.env.GITLAB_API_BASE = mock.url;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const { deprovisionProject } = await import('../src/provision.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };

const create = async (name) => {
  const r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
  check(r.statusCode === 200 && J(r).remote?.createdByAldine === true && !J(r).remoteError, `create "${name}" provisioned: ` + r.body);
  return J(r);
};
const deletesFor = (fullName) => mock.recorded.deleted.filter((d) => d.fullName === fullName || d.fullName.startsWith(`${fullName}-deleted-`));

// ---------- (1) immediate deletion ----------
mock.flags.delayed = false;
let p = await create('Doomed');
check(mock.project('research/latex/doomed'), 'mock holds research/latex/doomed');
let r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(r.statusCode === 200 && J(r).ok === true && !J(r).remoteError && !J(r).remoteScheduledFor, 'trash → 200 clean: ' + r.body);
check(!mock.project('research/latex/doomed') && !mock.project(p.remote.fullName), 'mock no longer has the project');
check(deletesFor('research/latex/doomed').length === 1 && deletesFor('research/latex/doomed')[0].permanently === false, 'one plain DELETE: ' + JSON.stringify(deletesFor('research/latex/doomed')));
let meta = await store.readMeta(p.id);
check(meta.deletedAt && !meta.remote && !meta.github, 'trashed meta has no link: ' + JSON.stringify(meta));
check(meta.remotePending?.provider === 'gitlab' && meta.remotePending?.namespace === 'research/latex', 'remotePending keeps the namespace for restore: ' + JSON.stringify(meta.remotePending));
r = await app.inject({ url: `/api/projects/${p.id}/remote/status` });
check(r.statusCode === 404 || r.statusCode === 400, 'a trashed project no longer syncs: ' + r.statusCode);

// ---------- (2) delayed deletion: mark, re-check by id, purge with the renamed full_path ----------
mock.flags.delayed = true;
p = await create('Slow');
const slowId = mock.project('research/latex/slow').id;
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(r.statusCode === 200 && J(r).ok === true && !J(r).remoteError && !J(r).remoteScheduledFor, 'delayed delete → 200 clean: ' + r.body);
const slowDeletes = deletesFor('research/latex/slow');
check(slowDeletes.length === 2, 'two DELETE calls: ' + JSON.stringify(slowDeletes));
check(slowDeletes[0].permanently === false && slowDeletes[0].target === 'research/latex/slow', 'first DELETE by path: ' + JSON.stringify(slowDeletes[0]));
check(slowDeletes[1].permanently === true && slowDeletes[1].target === String(slowId) && slowDeletes[1].fullPath === `research/latex/slow-deleted-${slowId}`, 'second DELETE by numeric id with the renamed full_path: ' + JSON.stringify(slowDeletes[1]));
check(!mock.project(slowId) && !mock.project('research/latex/slow') && !mock.project(`research/latex/slow-deleted-${slowId}`), 'project purged from the mock');
meta = await store.readMeta(p.id);
check(!meta.remote && meta.remotePending?.namespace === 'research/latex', 'link cleared, remotePending set');

// ---------- (3) refused purge: scheduledFor reported, link cleared ----------
mock.flags.refusePurge = true;
p = await create('Sticky');
const stickyId = mock.project('research/latex/sticky').id;
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(r.statusCode === 200 && J(r).ok === true, 'refused purge still deletes locally: ' + r.body);
check(/^\d{4}-\d{2}-\d{2}/.test(J(r).remoteScheduledFor || ''), 'remoteScheduledFor is the GitLab date: ' + r.body);
check(/400/.test(J(r).remoteError || ''), 'the refusal rides along as remoteError: ' + r.body);
check(mock.project(stickyId)?.markedForDeletionOn && mock.project(stickyId).fullName === `research/latex/sticky-deleted-${stickyId}`, 'mock keeps it scheduled under the renamed path');
meta = await store.readMeta(p.id);
check(!meta.remote && meta.remotePending?.namespace === 'research/latex', 'link cleared after a refused purge: ' + JSON.stringify(meta));
mock.flags.refusePurge = false;
mock.flags.delayed = false;

// ---------- (4) an imported repository is never deleted ----------
const bare = path.join(tmp, 'imported.git'); execSync(`git init -q --bare -b main "${bare}"`);
const seed = path.join(tmp, 'imported-seed'); execSync(`git clone -q "${bare}" "${seed}" 2>/dev/null`);
fs.writeFileSync(path.join(seed, 'main.tex'), '\\documentclass{article}\\begin{document}Imported\\end{document}\n');
execSync(`cd "${seed}" && git add -A && git -c user.email=a@b.c -c user.name=t commit -q -m init && git push -q origin main`);
mock.addProject('research/latex/imported', bare);
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/connect', payload: { token: 'user-token' } });
check(r.statusCode === 200 && J(r).login === 'tester', 'user connects a PAT: ' + r.body);
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/import', payload: { fullName: 'research/latex/imported' } });
check(r.statusCode === 200 && J(r).remote?.fullName === 'research/latex/imported' && !J(r).remote?.createdByAldine, 'imported link is not createdByAldine: ' + r.body);
check(!J(r).autopush, 'autopush stays off for an imported project');
const importedId = J(r).id;
const deletesBefore = mock.recorded.deleted.length;
r = await app.inject({ method: 'DELETE', url: `/api/projects/${importedId}?permanent=1` });
check(r.statusCode === 200 && J(r).ok === true && !J(r).remoteError, 'permanent delete of an imported project: ' + r.body);
check(mock.project('research/latex/imported') && fs.existsSync(bare), 'GitLab project untouched');
check(mock.recorded.deleted.length === deletesBefore, 'no DELETE was sent to GitLab');
await store.readMeta(importedId).then(() => check(false, 'imported project should be gone locally'), () => {});
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/disconnect' });
check(r.statusCode === 200, 'user disconnects again');

// ---------- (5) restore re-creates the GitLab project ----------
p = await create('Phoenix');
const firstId = mock.project('research/latex/phoenix').id;
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(r.statusCode === 200 && !mock.project('research/latex/phoenix'), 'trash removed it on GitLab');
const createdBefore = mock.recorded.created.length;
r = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/restore` });
check(r.statusCode === 200 && J(r).ok === true && !J(r).remoteError, 'restore → 200: ' + r.body);
meta = await store.readMeta(p.id);
check(!meta.deletedAt && meta.remote?.fullName === 'research/latex/phoenix' && meta.remote?.createdByAldine === true && !meta.remotePending, 'restored meta is linked again: ' + JSON.stringify(meta.remote));
check(meta.autopush === true, 'autopush back on after restore');
check(mock.recorded.created.length === createdBefore + 1 && mock.project('research/latex/phoenix').id !== firstId, 'a new project on the mock');
check(execSync(`git --git-dir="${mock.project('research/latex/phoenix').bare}" ls-tree --name-only main`).toString().includes('main.tex'), 'restore pushed main again');

// ---------- (6) the trash sweep retries a deletion GitLab refused earlier ----------
p = await create('Stale');
mock.flags.failDelete = true;
r = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
check(r.statusCode === 200 && J(r).ok === true && /503/.test(J(r).remoteError || ''), 'GitLab down: trashed locally, remoteError reported: ' + r.body);
meta = await store.readMeta(p.id);
check(meta.deletedAt && meta.remote?.fullName === 'research/latex/stale' && meta.remote?.createdByAldine === true, 'link kept so the sweep can retry: ' + JSON.stringify(meta.remote));
check(mock.project('research/latex/stale'), 'still on the mock');
meta.deletedAt = new Date(Date.now() - 40 * 86400_000).toISOString();
await store.writeMeta(meta);
mock.flags.failDelete = false;
const before = mock.recorded.deleted.length;
const purged = await store.purgeExpiredTrash(30, deprovisionProject);
check(purged.includes(p.id) && purged.length === 1, 'only the 40-day-old project purged: ' + JSON.stringify(purged));
await store.readMeta(p.id).then(() => check(false, 'purged project should be gone locally'), () => {});
check(!mock.project('research/latex/stale'), 'the sweep deleted it on GitLab');
check(mock.recorded.deleted.length === before + 1 && mock.recorded.deleted.at(-1).fullName === 'research/latex/stale', 'the sweep sent the DELETE: ' + JSON.stringify(mock.recorded.deleted.at(-1)));
// the other trashed projects are younger than 30 days and still here
for (const id of (await store.listProjects()).filter((m) => m.deletedAt).map((m) => m.id)) check(await store.readMeta(id), `trashed ${id} survived the sweep`);

await app.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log('GitLab deletion integration (immediate→delayed→refused purge→imported untouched→restore→sweep retry): ALL PASSED');
