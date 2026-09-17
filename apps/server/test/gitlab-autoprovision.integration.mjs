/**
 * Auto-provisioning (#51 Stage B) over the routes, against the in-process
 * GitLab mock: a new project lands in GITLAB_DEFAULT_GROUP with the configured
 * visibility and its first push, a chosen subgroup is honoured, a sibling of
 * the root is refused (project still created), slug collisions get a suffix,
 * an unreachable GitLab leaves `remotePending` that `link` retries, ZIP import
 * provisions after the binaries commit, sync falls through to the service
 * token while listing never does, namespaces/subgroups, the autopush toggle
 * and "off unless both env vars are set".
 *
 * Every env var below must be set before the routes are imported.
 */
import { check, eq } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildZip } from './zip.mjs';
import { startGitlabMock, refs, show, lsTree } from './mock-gitlab-api.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-glprov-'));
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
const { provisioningEnabled } = await import('../src/provision.ts');
const { autopushStats } = await import('../src/autopush.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };
const projectDir = (id) => path.join(process.env.DATA_DIR, 'projects', id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return fn(); };
const bareOf = (fullName) => mock.project(fullName)?.bare;

check(provisioningEnabled() === true, 'provisioning is on with GITLAB_TOKEN + GITLAB_DEFAULT_GROUP');

// ---------- (1) happy path: root group, configured visibility, first push ----------
let r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'My Paper' } });
check(r.statusCode === 200, 'create → 200: ' + r.body);
const p1 = J(r);
check(p1.remote?.provider === 'gitlab' && p1.remote?.fullName === 'research/latex/my-paper', 'provisioned into the root group: ' + JSON.stringify(p1.remote));
check(p1.remote?.createdByAldine === true && p1.remote?.owner === 'research/latex' && p1.remote?.repo === 'my-paper', 'link marks createdByAldine: ' + JSON.stringify(p1.remote));
check(p1.autopush === true, 'autopush defaults to on for a provisioned project');
check(!('remoteError' in p1) && !p1.remotePending, 'no remoteError / remotePending on success: ' + r.body);
const created1 = mock.recorded.created.at(-1);
check(created1.visibility === 'internal' && created1.namespace_id === 2 && created1.path === 'my-paper', 'POST /projects body: ' + JSON.stringify(created1));
check(refs(bareOf('research/latex/my-paper')).includes('main') && show(bareOf('research/latex/my-paper'), 'main:main.tex').includes('documentclass'), 'first push landed main:main.tex');

// ---------- (2) chosen subgroup ----------
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Sub', namespace: 'research/latex/team-a' } });
check(r.statusCode === 200 && J(r).remote?.fullName === 'research/latex/team-a/sub', 'subgroup honoured: ' + r.body);
check(mock.recorded.created.at(-1).namespace_id === 3, 'created under team-a (namespace_id 3)');

// ---------- (3) a sibling of the root is refused, the project still exists ----------
const createdBefore = mock.recorded.created.length;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Sneaky', namespace: 'research/latex-archive' } });
check(r.statusCode === 200 && J(r).id, 'outside root → project still created: ' + r.body);
check(/outside/.test(J(r).remoteError || ''), 'remoteError names the boundary: ' + J(r).remoteError);
check(J(r).remote === null, 'no link: ' + JSON.stringify(J(r).remote));
check(J(r).remotePending?.provider === 'gitlab' && J(r).remotePending?.namespace === 'research/latex', 'remotePending falls back to the root: ' + JSON.stringify(J(r).remotePending));
check(mock.recorded.created.length === createdBefore, 'no POST /projects for a namespace outside the root');
check(!mock.project('research/latex-archive/sneaky'), 'nothing appeared in the sibling group');

// ---------- (4) slug collision ----------
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'My Paper' } });
check(r.statusCode === 200 && J(r).remote?.fullName === 'research/latex/my-paper-2', 'second "My Paper" → my-paper-2: ' + r.body);
check(mock.project('research/latex/my-paper') && mock.project('research/latex/my-paper-2'), 'both projects exist on the mock');

// ---------- (5) unreachable GitLab → local + remotePending → retry via link ----------
mock.flags.failNextCreate = true;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Offline' } });
check(r.statusCode === 200 && J(r).id, 'GitLab down → project still created: ' + r.body);
const offline = J(r);
check(typeof offline.remoteError === 'string' && /503/.test(offline.remoteError), 'remoteError carries the failure: ' + offline.remoteError);
check(offline.remote === null && offline.remotePending?.namespace === 'research/latex' && offline.remotePending?.provider === 'gitlab', 'remotePending set: ' + JSON.stringify(offline.remotePending));
check(!offline.autopush, 'autopush not switched on without a link');
check(mock.flags.failNextCreate === false, 'the mock consumed its one failure');
r = await app.inject({ method: 'POST', url: `/api/projects/${offline.id}/remote/link`, payload: {} });
check(r.statusCode === 200 && J(r).ok === true && J(r).remote?.fullName === 'research/latex/offline' && J(r).remote?.createdByAldine === true, 'link {} re-provisions: ' + r.body);
r = await app.inject({ url: `/api/projects/${offline.id}` });
check(J(r).remote?.fullName === 'research/latex/offline' && !J(r).remotePending && J(r).autopush === true, 'summary after retry: ' + r.body);
check(refs(bareOf('research/latex/offline')).includes('main'), 'retry pushed main');
r = await app.inject({ method: 'POST', url: `/api/projects/${offline.id}/remote/link`, payload: {} });
check(r.statusCode === 400 && /already linked/.test(J(r).error), 'a second link → 400: ' + r.body);

// ---------- (6) ZIP import provisions after the binaries commit ----------
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00])]);
const zip = buildZip({ 'main.tex': '\\documentclass{article}\\begin{document}\\includegraphics{fig.png}\\end{document}\n', 'fig.png': png });
r = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'Zipped', zipBase64: zip.toString('base64') } });
check(r.statusCode === 200, 'import → 200: ' + r.body);
const zipped = J(r);
check(zipped.remote?.fullName === 'research/latex/zipped' && zipped.remote?.createdByAldine === true && !zipped.remoteError, 'imported project provisioned: ' + JSON.stringify(zipped.remote));
const zipFiles = lsTree(bareOf('research/latex/zipped'));
check(zipFiles.includes('main.tex') && zipFiles.includes('fig.png'), 'pushed tree has main.tex AND the binary: ' + zipFiles.join(','));

// ---------- (7) sync with only the service token; listing never uses it ----------
r = await app.inject({ url: '/api/remotes/gitlab/status' });
check(r.statusCode === 200 && J(r).connected === false, 'no user connection for local: ' + r.body);
r = await app.inject({ url: `/api/projects/${p1.id}/remote/status` });
check(r.statusCode === 200 && J(r).linked === true && J(r).provider === 'gitlab', 'sync status via the service token: ' + r.body);
check(typeof J(r).ahead === 'number' && typeof J(r).behind === 'number' && J(r).ahead === 0 && J(r).behind === 0, 'ahead/behind computed: ' + r.body);
r = await app.inject({ url: `/api/projects/${p1.id}/remote/branches` });
check(r.statusCode === 200 && J(r).branches.includes('main'), 'branches via the service token: ' + r.body);
r = await app.inject({ url: '/api/remotes/gitlab/repos' });
check(r.statusCode === 400 && /not connected/i.test(J(r).error), 'repos without a user connection → 400 (service token never lists): ' + r.body);
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/import', payload: { fullName: 'research/latex/my-paper' } });
check(r.statusCode === 400, 'import without a user connection → 400 (service token never imports): ' + r.body);

// ---------- (8) namespaces and subgroups ----------
r = await app.inject({ url: '/api/remotes/gitlab/namespaces' });
check(r.statusCode === 200 && J(r).root === 'research/latex', 'namespaces root: ' + r.body);
eq(J(r).namespaces.map((n) => n.fullPath), ['research/latex', 'research/latex/team-a'], 'namespaces = root first, then descendants (never the sibling)');
check(J(r).namespaces.every((n) => typeof n.name === 'string' && n.name), 'each namespace has a name');
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { name: 'Team B' } });
check(r.statusCode === 200 && J(r).fullPath === 'research/latex/team-b' && J(r).name === 'Team B', 'subgroup under the root: ' + r.body);
check(mock.recorded.groupsCreated.at(-1).parent_id === 2 && mock.recorded.groupsCreated.at(-1).path === 'team-b', 'POST /groups body: ' + JSON.stringify(mock.recorded.groupsCreated.at(-1)));
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { parentPath: 'research/latex/team-a', name: 'Nested' } });
check(r.statusCode === 200 && J(r).fullPath === 'research/latex/team-a/nested', 'subgroup under a descendant: ' + r.body);
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { parentPath: 'research', name: 'Escape' } });
check(r.statusCode === 400 && /outside/.test(J(r).error), 'parentPath above the root → 400: ' + r.body);
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { parentPath: 'research/latex-archive', name: 'Escape' } });
check(r.statusCode === 400 && /outside/.test(J(r).error), 'sibling parentPath → 400: ' + r.body);
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { name: '' } });
check(r.statusCode === 400, 'subgroup without a name → 400');
r = await app.inject({ url: '/api/remotes/gitlab/namespaces' });
eq(J(r).namespaces.map((n) => n.fullPath).sort(), ['research/latex', 'research/latex/team-a', 'research/latex/team-a/nested', 'research/latex/team-b'], 'new subgroups listed');
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'In B', namespace: 'research/latex/team-b' } });
check(r.statusCode === 200 && J(r).remote?.fullName === 'research/latex/team-b/in-b', 'a project lands in the new subgroup: ' + r.body);

// ---------- (9) autopush toggle ----------
const p1bare = bareOf('research/latex/my-paper');
r = await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/remote/autopush`, payload: { enabled: false } });
check(r.statusCode === 200 && J(r).autopush === false && J(r).ok === true, 'autopush off: ' + r.body);
r = await app.inject({ url: `/api/projects/${p1.id}` });
check(J(r).autopush === false, 'summary shows autopush off');
fs.writeFileSync(path.join(projectDir(p1.id), 'main.tex'), '\\documentclass{article}\\begin{document}AUTOPUSH OFF\\end{document}\n');
r = await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/commit`, payload: { message: 'edit while off' } });
check(r.statusCode === 200 && J(r).committed === true, 'commit while off: ' + r.body);
await sleep(300);
check(!show(p1bare, 'main:main.tex').includes('AUTOPUSH OFF'), 'nothing pushed while autopush is off');
check(autopushStats(p1.id).pending === false && autopushStats(p1.id).attempts === 0, 'no retry loop entered while off: ' + JSON.stringify(autopushStats(p1.id)));
r = await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/remote/autopush`, payload: { enabled: true } });
check(r.statusCode === 200 && J(r).autopush === true, 'autopush on: ' + r.body);
fs.writeFileSync(path.join(projectDir(p1.id), 'main.tex'), '\\documentclass{article}\\begin{document}AUTOPUSH ON\\end{document}\n');
r = await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/commit`, payload: { message: 'edit while on' } });
check(r.statusCode === 200 && J(r).committed === true, 'commit while on: ' + r.body);
check(await until(() => show(p1bare, 'main:main.tex').includes('AUTOPUSH ON')), 'the debounced autopush pushed the edit');
check(await until(() => !autopushStats(p1.id).pending && !autopushStats(p1.id).running), 'autopush idle after the push');
r = await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/remote/autopush`, payload: { enabled: 'yes' } });
check(r.statusCode === 400, 'non-boolean enabled → 400: ' + r.body);
r = await app.inject({ method: 'POST', url: `/api/projects/${offline.id}/remote/autopush`, payload: { enabled: true } });
check(r.statusCode === 200, 'toggle on a re-provisioned project works: ' + r.body);
r = await app.inject({ method: 'POST', url: `/api/projects/${J(await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Nolink', namespace: 'research/latex-archive' } })).id}/remote/autopush`, payload: { enabled: true } });
check(r.statusCode === 400 && /not linked/.test(J(r).error), 'toggle on an unlinked project → 400: ' + r.body);

// ---------- (10) off unless both vars are set ----------
const savedGroup = process.env.GITLAB_DEFAULT_GROUP;
delete process.env.GITLAB_DEFAULT_GROUP;
check(provisioningEnabled() === false, 'provisioning off without GITLAB_DEFAULT_GROUP');
const createdBeforeOff = mock.recorded.created.length;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Plain' } });
check(r.statusCode === 200 && J(r).remote === null && !('remoteError' in J(r)) && !J(r).remotePending && !J(r).autopush, 'no remote, no error, no pending when off: ' + r.body);
check(mock.recorded.created.length === createdBeforeOff, 'no GitLab call when off');
r = await app.inject({ url: '/api/remotes/gitlab/namespaces' });
check(r.statusCode === 404, 'namespaces → 404 when off: ' + r.body);
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { name: 'X' } });
check(r.statusCode === 404, 'subgroups → 404 when off: ' + r.body);
process.env.GITLAB_DEFAULT_GROUP = savedGroup;
const savedToken = process.env.GITLAB_TOKEN;
delete process.env.GITLAB_TOKEN;
check(provisioningEnabled() === false, 'provisioning off without GITLAB_TOKEN');
r = await app.inject({ url: '/api/remotes/gitlab/namespaces' });
check(r.statusCode === 404, 'namespaces → 404 without the token');
process.env.GITLAB_TOKEN = savedToken;
check(provisioningEnabled() === true, 'provisioning back on');
process.env.REMOTE_PROVIDERS = 'github';
check(provisioningEnabled() === false, 'provisioning off when gitlab is not an allowed provider');
delete process.env.REMOTE_PROVIDERS;

await app.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log('GitLab provisioning integration (create→subgroup→outside root→collision→retry→import→service-token sync→namespaces→autopush toggle→off): ALL PASSED');
