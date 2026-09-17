/**
 * Mock GitLab REST v4 for e2e. Projects are real bare git repos under
 * .data-e2e-gitlab so the app's clone/push/fetch run against them; the HTTP
 * side answers just the calls apps/server/src/gitlab.ts makes. Seeded with
 * grp/sub/paper (a three-segment path) so nested groups get exercised.
 * Any bearer token works except `bad` (401) — that is how a spec provokes the
 * token-invalid path.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.E2E_GITLAB_PORT || 4921);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data-e2e-gitlab');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const git = (cmd, cwd = root) => execSync(`git ${cmd}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

/** @type {Map<string, { id: number; fullName: string; bare: string; visibility: string; createdAt: string }>} */
const projects = new Map();
let nextId = 100;
const groups = new Map([
  ['grp', { id: 1, full_path: 'grp', name: 'grp' }],
  ['grp/sub', { id: 2, full_path: 'grp/sub', name: 'sub' }],
  // provisioning root and its subtree (34-provisioning), plus a sibling that
  // shares the prefix and must never be accepted as "inside" the root
  ['research', { id: 10, full_path: 'research', name: 'research' }],
  ['research/latex', { id: 11, full_path: 'research/latex', name: 'latex' }],
  ['research/latex/team-a', { id: 12, full_path: 'research/latex/team-a', name: 'team-a' }],
  ['research/latex-archive', { id: 13, full_path: 'research/latex-archive', name: 'latex-archive' }],
]);
let nextGroupId = 100;
const mergeRequests = [];
/** Test switches: /__fail?on=1 makes POST /projects answer 503; delayed deletion marks first, purges on the second call. */
let failCreates = false;
let delayedDeletion = true;
const deleted = [];

function createProject(fullName, visibility = 'private', seed = null) {
  const bare = path.join(root, `${fullName}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(`init --bare -q -b main "${bare}"`);
  if (seed) {
    const work = path.join(root, `_seed-${nextId}`);
    git(`clone -q "${bare}" "${work}"`);
    for (const [rel, content] of Object.entries(seed)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), content);
    }
    git('add -A', work);
    git('-c user.email=e2e@aldine.dev -c user.name=e2e commit -q -m "seed"', work);
    git('push -q origin main', work);
    fs.rmSync(work, { recursive: true, force: true });
  }
  const p = { id: nextId++, fullName, bare, visibility, createdAt: new Date().toISOString(), markedForDeletionOn: null };
  projects.set(fullName, p);
  return p;
}

function projectJson(p) {
  const parts = p.fullName.split('/');
  return {
    id: p.id,
    name: parts[parts.length - 1],
    path: parts[parts.length - 1],
    path_with_namespace: p.fullName,
    namespace: { full_path: parts.slice(0, -1).join('/') },
    visibility: p.visibility,
    ...(p.markedForDeletionOn ? { marked_for_deletion_on: p.markedForDeletionOn } : {}),
    default_branch: 'main',
    http_url_to_repo: `file://${p.bare}`,
    web_url: `http://localhost:${port}/${p.fullName}`,
    last_activity_at: p.createdAt,
  };
}

createProject('grp/sub/paper', 'private', {
  'main.tex': '\\documentclass{article}\n\\begin{document}\nHello from GitLab\n\\end{document}\n',
  'README.md': '# paper\n',
});

/** `:id` in a URL is a numeric id or a percent-encoded full path. */
function findProject(seg) {
  const key = decodeURIComponent(seg);
  if (/^\d+$/.test(key)) return [...projects.values()].find((p) => p.id === Number(key)) || null;
  return projects.get(key) || null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // test-only switches, no auth
  if (url.pathname === '/__fail') { failCreates = url.searchParams.get('on') === '1'; return send(200, { failCreates }); }
  if (url.pathname === '/__delayed') { delayedDeletion = url.searchParams.get('on') !== '0'; return send(200, { delayedDeletion }); }
  if (url.pathname === '/__deleted') return send(200, deleted);
  if (url.pathname === '/__projects') return send(200, [...projects.values()].map(projectJson));
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || token === 'bad') return send(401, { message: '401 Unauthorized' });

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { handle(); } catch (err) { send(500, { message: String(err?.message || err) }); }
  });
  function handle() {
    const body = raw ? JSON.parse(raw) : {};
    const segs = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/user') return send(200, { id: 7, username: 'e2e-user', name: 'E2E User' });

    if (url.pathname === '/projects' && req.method === 'GET') {
      return send(200, [...projects.values()].map(projectJson));
    }
    if (url.pathname === '/projects' && req.method === 'POST') {
      if (failCreates) return send(503, { message: '503 Service Unavailable (test switch)' });
      const ns = body.namespace_id ? [...groups.values()].find((g) => g.id === body.namespace_id)?.full_path : 'e2e-user';
      const fullName = `${ns}/${body.path || body.name}`;
      if (projects.has(fullName)) return send(400, { message: { name: ['has already been taken'] } });
      return send(201, projectJson(createProject(fullName, body.visibility || 'private')));
    }
    if (segs[0] === 'groups' && segs.length === 2 && req.method === 'GET') {
      const g = groups.get(decodeURIComponent(segs[1]));
      return g ? send(200, g) : send(404, { message: '404 Group Not Found' });
    }
    if (segs[0] === 'groups' && segs.length === 3 && segs[2] === 'descendant_groups' && req.method === 'GET') {
      const root = decodeURIComponent(segs[1]);
      if (!groups.has(root)) return send(404, { message: '404 Group Not Found' });
      return send(200, [...groups.values()].filter((g) => g.full_path.startsWith(`${root}/`)));
    }
    if (url.pathname === '/groups' && req.method === 'POST') {
      const parent = [...groups.values()].find((g) => g.id === body.parent_id);
      if (!parent) return send(404, { message: '404 Group Not Found' });
      const full_path = `${parent.full_path}/${body.path}`;
      if (groups.has(full_path)) return send(400, { message: { path: ['has already been taken'] } });
      const g = { id: nextGroupId++, full_path, name: body.name || body.path };
      groups.set(full_path, g);
      return send(201, g);
    }
    if (segs[0] === 'projects' && segs.length >= 2) {
      const p = findProject(segs[1]);
      if (!p) return send(404, { message: '404 Project Not Found' });
      if (segs.length === 2 && req.method === 'GET') return send(200, projectJson(p));
      if (segs.length === 2 && req.method === 'DELETE') {
        const purge = url.searchParams.get('permanently_remove') === 'true';
        if (delayedDeletion && !p.markedForDeletionOn && !purge) {
          // GitLab renames the path and keeps the project until the retention period ends
          projects.delete(p.fullName);
          p.markedForDeletionOn = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
          p.fullName = `${p.fullName}-deleted-${p.id}`;
          projects.set(p.fullName, p);
          return send(202, { message: '202 Accepted' });
        }
        if (delayedDeletion && p.markedForDeletionOn && !purge) return send(400, { message: 'Project already marked for deletion' });
        if (purge && url.searchParams.get('full_path') !== p.fullName) return send(400, { message: '`full_path` is incorrect' });
        fs.rmSync(p.bare, { recursive: true, force: true });
        projects.delete(p.fullName);
        deleted.push(p.fullName.replace(/-deleted-\d+$/, ''));
        return send(202, { message: '202 Accepted' });
      }
      if (segs[2] === 'repository' && segs[3] === 'branches' && req.method === 'GET') {
        const names = git(`--git-dir="${p.bare}" for-each-ref --format="%(refname:short)" refs/heads`).split('\n').filter(Boolean);
        return send(200, names.map((name) => ({ name, default: name === 'main' })));
      }
      if (segs[2] === 'merge_requests' && req.method === 'POST') {
        const iid = mergeRequests.length + 1;
        mergeRequests.push({ project: p.fullName, iid, ...body });
        return send(201, { iid, web_url: `http://localhost:${port}/${p.fullName}/-/merge_requests/${iid}`, title: body.title });
      }
    }
    // test-only inspection: what merge requests were opened
    if (url.pathname === '/__merge_requests') return send(200, mergeRequests);
    send(404, { message: `404 Not Found: ${req.method} ${url.pathname}` });
  }
});

server.listen(port, () => console.log(`[mock-gitlab] on :${port}, repos under ${root}`));
