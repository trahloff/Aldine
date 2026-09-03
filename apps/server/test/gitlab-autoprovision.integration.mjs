import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { execSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-glap-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
const BARES = path.join(tmp, 'bares'); fs.mkdirSync(BARES, { recursive: true });

const GROUPS = {
  'research/latex': { id: 100, full_path: 'research/latex', name: 'latex' },
  'research/latex/theses': { id: 102, full_path: 'research/latex/theses', name: 'theses' },
};
const byId = (id) => Object.values(GROUPS).find((g) => g.id === id);

/** Paths GitLab already has — drives the collision path. */
const takenPaths = new Set();
const created = [];
const deletedPaths = [];
const projects = {};
let nextId = 10;
let mockDown = false;
let createCalls = 0;

function bareFor(full) {
  const bare = path.join(BARES, `${full.replace(/\//g, '__')}.git`);
  if (!fs.existsSync(bare)) execSync(`git init --bare -b main "${bare}"`, { stdio: 'ignore' });
  return `file://${bare}`;
}

const mock = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (mockDown) return send(503, { message: 'gitlab is down' });
  const p = req.url;
  if (p === '/api/v4/user') return send(200, { username: 'tester', name: 'Tester' });

  const g = p.match(/^\/api\/v4\/groups\/([^/?]+)$/);
  if (g && req.method === 'GET') {
    const found = GROUPS[decodeURIComponent(g[1])];
    return found ? send(200, found) : send(404, { message: '404 Group Not Found' });
  }
  const d = p.match(/^\/api\/v4\/groups\/([^/?]+)\/descendant_groups/);
  if (d) {
    const root = decodeURIComponent(d[1]);
    return send(200, Object.values(GROUPS).filter((x) => x.full_path.startsWith(`${root}/`)));
  }

  if (p === '/api/v4/projects' && req.method === 'POST') {
    createCalls++;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const group = byId(body.namespace_id);
      if (!group) return send(400, { message: 'no such namespace' });
      if (takenPaths.has(body.path)) return send(400, { message: { path: ['has already been taken'] } });
      const full = `${group.full_path}/${body.path}`;
      created.push({ ...body, full });
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

  // Faithful to GitLab: the first DELETE only marks the project and renames it
  // to free the path; removing it takes a second DELETE with permanently_remove.
  // A mock that deletes on the first call keeps this path green while real
  // instances hold the repo for their retention period.
  const pm = p.match(/^\/api\/v4\/projects\/([^/?]+)(\?.*)?$/);
  if (pm) {
    const key = decodeURIComponent(pm[1]);
    const proj = projects[key] || Object.values(projects).find((x) => String(x.id) === key);
    if (req.method === 'DELETE') {
      if (!proj) return send(404, { message: '404 Project Not Found' });
      const q = new URLSearchParams(pm[2] ? pm[2].slice(1) : '');
      delete projects[proj.path_with_namespace];
      if (q.get('permanently_remove') === 'true') {
        deletedPaths.push(proj.originalPath || proj.path_with_namespace);
        return send(202, {});
      }
      proj.originalPath = proj.path_with_namespace;
      proj.marked_for_deletion_on = '2026-10-01';
      proj.path_with_namespace = `${proj.path_with_namespace}-deleted-${proj.id}`;
      projects[proj.path_with_namespace] = proj;
      return send(202, {});
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
const headOf = (full) => execSync(`git --git-dir="${path.join(BARES, `${full.replace(/\//g, '__')}.git`)}" rev-parse main`).toString().trim();

// --- the happy path ---
let r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'My Paper' } });
check(r.statusCode === 200, 'create: ' + r.body);
check(J(r).remote?.provider === 'gitlab', 'linked to gitlab: ' + r.body);
check(J(r).remote.fullName === 'research/latex/my-paper', 'slug lands in the root group: ' + J(r).remote?.fullName);
check(!J(r).remoteError, 'no error reported');
check(J(r).autopush === true, 'autopush defaults on for provisioned projects');
check(created.some((c) => c.path === 'my-paper' && c.visibility === 'private'), 'gitlab saw a private create');
check(created.at(-1).initialize_with_readme === false, 'no GitLab-side initial commit, which would block the first push');
check(headOf('research/latex/my-paper').length === 40, 'initial content pushed');

// --- into a chosen subgroup ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Thesis', namespace: 'research/latex/theses' } });
check(J(r).remote.fullName === 'research/latex/theses/thesis', 'lands in the subgroup: ' + J(r).remote?.fullName);

// --- a namespace outside the root is refused, and the project is still created ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Sneaky', namespace: 'evil/group' } });
check(r.statusCode === 200, 'creation still succeeds');
check(!J(r).remote, 'not linked');
check(J(r).remotePending?.provider === 'gitlab', 'marked pending');
check(/inside research\/latex/.test(J(r).remoteError || ''), 'explains why: ' + J(r).remoteError);
check(fs.existsSync(path.join(process.env.DATA_DIR, 'projects', J(r).id, 'main.tex')), 'local project intact');

// --- slug collision gets a suffix ---
takenPaths.add('duplicate');
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Duplicate' } });
check(J(r).remote?.fullName === 'research/latex/duplicate-2', 'collision suffixed: ' + J(r).remote?.fullName);

// --- GitLab unreachable degrades to local-only ---
mockDown = true;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Offline Paper' } });
check(r.statusCode === 200, 'creation never blocks on GitLab: ' + r.body);
check(!J(r).remote, 'no remote link');
check(J(r).remotePending?.provider === 'gitlab', 'pending recorded');
check(typeof J(r).remoteError === 'string', 'error surfaced to the client');
const offlineId = J(r).id;
check(fs.existsSync(path.join(process.env.DATA_DIR, 'projects', offlineId, 'main.tex')), 'local project intact');

// --- retry once the mock recovers ---
mockDown = false;
r = await app.inject({ method: 'POST', url: `/api/projects/${offlineId}/remote/link`, payload: {} });
check(J(r).ok === true, 'retry links: ' + r.body);
r = await app.inject({ url: `/api/projects/${offlineId}` });
check(J(r).remote?.provider === 'gitlab', 'retry stored the link: ' + r.body);
check(J(r).remote.fullName === 'research/latex/offline-paper', 'retry used the intended namespace: ' + J(r).remote?.fullName);
check(!J(r).remotePending, 'pending cleared');

// --- retry on open, guarded to once per process ---
mockDown = true;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Reopen Me' } });
const rid = J(r).id;
mockDown = false;
await app.inject({ url: `/api/projects/${rid}` });
await new Promise((res) => setTimeout(res, 400));
r = await app.inject({ url: `/api/projects/${rid}` });
check(J(r).remote?.provider === 'gitlab', 'retried on open: ' + r.body);
check(!J(r).remotePending, 'pending cleared after a successful retry');

mockDown = true;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Still Down' } });
const sid = J(r).id;
const before = createCalls;
await app.inject({ url: `/api/projects/${sid}` });
await app.inject({ url: `/api/projects/${sid}` });
await app.inject({ url: `/api/projects/${sid}` });
await new Promise((res) => setTimeout(res, 400));
check(createCalls - before <= 1, `one retry per project per process, not one per open (saw ${createCalls - before})`);
mockDown = false;

// --- renaming stays local: a GitLab path change breaks existing clone URLs ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Keeper' } });
const keeperId = J(r).id;
const keeperPath = J(r).remote.fullName;
await app.inject({ method: 'PATCH', url: `/api/projects/${keeperId}`, payload: { name: 'Renamed Keeper' } });
r = await app.inject({ url: `/api/projects/${keeperId}` });
check(J(r).remote.fullName === keeperPath, 'a local rename does not rename in GitLab');

// --- trashing deletes the GitLab project Aldine created ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Doomed', namespace: 'research/latex/theses' } });
const doomedId = J(r).id;
const doomedPath = J(r).remote.fullName;
check(J(r).remote.createdByAldine === true, 'an auto-provisioned project is marked as created by Aldine');
await app.inject({ method: 'DELETE', url: `/api/projects/${doomedId}` });
check(deletedPaths.includes(doomedPath), `trashing deletes the GitLab project, saw ${JSON.stringify(deletedPaths)}`);
r = await app.inject({ url: '/api/projects/trash' });
check(J(r).some((t) => t.id === doomedId), 'the project is still in Aldine trash and restorable');

// --- restore puts it back in GitLab, in the same group ---
const beforeRestore = created.length;
r = await app.inject({ method: 'POST', url: `/api/projects/${doomedId}/restore` });
check(J(r).ok === true, 'restore: ' + r.body);
check(created.length === beforeRestore + 1, 'restore re-created the GitLab project');
r = await app.inject({ url: `/api/projects/${doomedId}` });
check(J(r).remote?.owner === 'research/latex/theses', 'restored into the same group: ' + JSON.stringify(J(r).remote));

// --- an IMPORTED repo is never deleted: Aldine did not create it ---
const importedId = 'importedproj01';
const importedDir = path.join(process.env.DATA_DIR, 'projects', importedId);
execSync(`git init -q -b main "${importedDir}"`);
execSync(`cd "${importedDir}" && git -c user.email=a@b.c -c user.name=t commit -q --allow-empty -m init`);
const storeMod = await import('../src/store.ts');
await storeMod.writeMeta({
  id: importedId, name: 'Imported', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(),
  remote: { provider: 'gitlab', fullName: 'someone/theirs', owner: 'someone', repo: 'theirs', remoteBranch: 'main', cloneUrl: 'https://x/someone/theirs.git' },
});
const beforeImportDelete = deletedPaths.length;
await app.inject({ method: 'DELETE', url: `/api/projects/${importedId}` });
check(deletedPaths.length === beforeImportDelete, 'an imported repo is left alone');

// --- deleting forever also removes it from GitLab ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Purge Me' } });
const purgeId = J(r).id;
const purgePath = J(r).remote.fullName;
await app.inject({ method: 'DELETE', url: `/api/projects/${purgeId}?permanent=1` });
check(deletedPaths.includes(purgePath), 'permanent delete removes the GitLab project too');

// --- a GitLab that refuses the delete must not block trashing ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Stubborn' } });
const stubbornId = J(r).id;
mockDown = true;
r = await app.inject({ method: 'DELETE', url: `/api/projects/${stubbornId}` });
check(r.statusCode === 200, 'trashing succeeds even when GitLab refuses: ' + r.body);
mockDown = false;
r = await app.inject({ url: '/api/projects/trash' });
check(J(r).some((t) => t.id === stubbornId), 'the project still reached the trash');

// --- sync works with only the service token: nobody connected GitLab personally ---
// This is the whole point of a GITLAB_TOKEN deployment. Requiring a personal
// connection here made every sync button 400 while creation and autopush,
// which fall back to the same token, kept working.
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Service Sync' } });
const svcId = J(r).id;
check(!J(r).remoteError, 'provisioned with the service token: ' + r.body);
r = await app.inject({ url: `/api/projects/${svcId}/remote/status` });
check(r.statusCode === 200, 'sync status needs no personal connection: ' + r.body);
check(J(r).linked === true, 'reports the link: ' + r.body);
r = await app.inject({ method: 'POST', url: `/api/projects/${svcId}/remote/push`, payload: { message: 'from the service account' } });
check(r.statusCode === 200, 'push needs no personal connection: ' + r.body);

// --- but GitHub has no service account to fall back to ---
await storeMod.writeMeta({
  id: 'ghnoconn0001', name: 'GH', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(),
  remote: { provider: 'github', fullName: 'someone/gh', owner: 'someone', repo: 'gh', remoteBranch: 'main', cloneUrl: 'https://github.com/someone/gh.git' },
});
r = await app.inject({ url: '/api/projects/ghnoconn0001/remote/status' });
check(r.statusCode === 400 && /Connect GitHub to sync/.test(r.body), 'GitHub still asks for a connection: ' + r.body);

// --- a ZIP import is provisioned too, binaries included ---
// A minimal ZIP built by hand: stored (uncompressed) entries, so no zlib needed.
function zipOf(files) {
  const chunks = []; const central = []; let offset = 0;
  const dosTime = 0, dosDate = 0x2100;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name); const body = Buffer.from(data);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xFFFFFFFF;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    chunks.push(local, nameBuf, body); central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const zip = zipOf({
  'main.tex': '\\documentclass{article}\\begin{document}From a ZIP\\end{document}\n',
  'fig.png': Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02, 0x03]),
});
r = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'Zipped Paper', zipBase64: zip.toString('base64') } });
check(r.statusCode === 200, 'zip import: ' + r.body);
check(J(r).remote?.provider === 'gitlab', 'a ZIP import is provisioned to GitLab: ' + r.body);
check(J(r).remote.fullName === 'research/latex/zipped-paper', 'lands in the group: ' + J(r).remote?.fullName);
// The push must happen after the binaries are committed, or the mirror is short a file.
const zipBare = path.join(BARES, 'research__latex__zipped-paper.git');
const listed = execSync(`git --git-dir="${zipBare}" ls-tree -r --name-only main`).toString();
check(listed.includes('main.tex') && listed.includes('fig.png'), 'binaries reached the mirror: ' + listed.replace(/\n/g, ' '));

r = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'Sub Zip', zipBase64: zip.toString('base64'), namespace: 'research/latex/theses' } });
check(J(r).remote?.fullName === 'research/latex/theses/sub-zip', 'a ZIP import honours the namespace: ' + J(r).remote?.fullName);

mockDown = true;
r = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'Offline Zip', zipBase64: zip.toString('base64') } });
check(r.statusCode === 200 && !J(r).remote && J(r).remotePending, 'a ZIP import degrades to local-only: ' + r.body);
mockDown = false;

// --- off unless configured ---
delete process.env.GITLAB_TOKEN;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Plain' } });
check(r.statusCode === 200 && !J(r).remote && !J(r).remotePending, 'no provisioning when unconfigured: ' + r.body);

mock.close(); await app.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log('gitlab-autoprovision: ALL PASSED');
