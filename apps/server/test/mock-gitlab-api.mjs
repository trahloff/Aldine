/**
 * In-process GitLab v4 mock for the provisioning suites. Projects are backed
 * by real bare repositories under `tmp` (clone URL `file://<bare>`) so pushes
 * land somewhere the tests can inspect with git.
 *
 * Deviations from GitLab that the tests rely on are deliberate and small:
 *  - `/projects/:id` resolves a numeric id or a percent-encoded path;
 *  - delayed deletion (flags.delayed) renames the path to `<path>-deleted-<id>`
 *    and sets `marked_for_deletion_on`; the old path 404s, the id still works;
 *  - `?permanently_remove=true` must carry the renamed `full_path`;
 *  - flags.failNextCreate / failDelete answer 503, flags.refusePurge answers 400.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
export const refs = (bare) => sh(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`).trim().split('\n').filter(Boolean);
export const show = (bare, spec) => sh(`git --git-dir="${bare}" show ${spec}`);
export const lsTree = (bare, branch = 'main') => sh(`git --git-dir="${bare}" ls-tree -r --name-only ${branch}`).trim().split('\n').filter(Boolean);

export async function startGitlabMock({ tmp, serviceToken = 'service-token' }) {
  const groups = new Map();
  let nextGroupId = 1;
  const addGroup = (fullPath) => {
    const parent = fullPath.includes('/') ? groups.get(fullPath.split('/').slice(0, -1).join('/')) : null;
    const g = { id: nextGroupId++, full_path: fullPath, path: fullPath.split('/').at(-1), name: fullPath.split('/').at(-1), parent_id: parent?.id ?? null };
    groups.set(fullPath, g);
    return g;
  };
  for (const g of ['research', 'research/latex', 'research/latex/team-a', 'research/latex-archive']) addGroup(g);
  const groupJson = (g) => ({ id: g.id, full_path: g.full_path, path: g.path, name: g.name, parent_id: g.parent_id });

  const projects = new Map(); // current path_with_namespace → record
  let nextProjectId = 100;
  const projectJson = (p) => ({
    id: p.id, path_with_namespace: p.fullName, path: p.path, name: p.name,
    namespace: { id: p.namespaceId, full_path: p.fullName.split('/').slice(0, -1).join('/') },
    visibility: p.visibility, default_branch: 'main', http_url_to_repo: `file://${p.bare}`,
    last_activity_at: '2026-02-02T00:00:00Z',
    ...(p.markedForDeletionOn ? { marked_for_deletion_on: p.markedForDeletionOn } : {}),
  });
  const findProject = (seg) => (/^\d+$/.test(seg) ? [...projects.values()].find((p) => p.id === Number(seg)) || null : projects.get(seg) || null);
  /** Register an already existing repository (an "imported" project). */
  const addProject = (fullName, bare, extra = {}) => {
    const segs = fullName.split('/');
    const p = { id: nextProjectId++, fullName, path: segs.at(-1), name: extra.name || segs.at(-1), namespaceId: groups.get(segs.slice(0, -1).join('/'))?.id ?? null, visibility: extra.visibility || 'private', bare, markedForDeletionOn: null };
    projects.set(fullName, p);
    return p;
  };

  const flags = { failNextCreate: false, failDelete: false, delayed: false, refusePurge: false };
  const recorded = { created: [], deleted: [], groupsCreated: [], merge: null };
  const revoked = new Set();
  const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });

  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const send = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token || revoked.has(token)) return send(401, { message: '401 Unauthorized' });
    const u = new URL(req.url, 'http://mock');
    const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (segs[0] === 'user') return send(200, token === serviceToken ? { username: 'aldine-service', name: 'Aldine service' } : { username: 'tester', name: 'Tester' });

    if (segs[0] === 'groups') {
      if (segs.length === 1 && req.method === 'POST') {
        const body = await readBody(req);
        const parent = [...groups.values()].find((g) => g.id === body.parent_id);
        if (!parent) return send(404, { message: '404 Group Not Found' });
        const fullPath = `${parent.full_path}/${body.path}`;
        if (groups.has(fullPath)) return send(400, { message: { path: ['has already been taken'] } });
        const g = addGroup(fullPath); g.name = body.name || g.name;
        recorded.groupsCreated.push({ ...body, full_path: fullPath });
        return send(201, groupJson(g));
      }
      const g = groups.get(segs[1]);
      if (!g) return send(404, { message: '404 Group Not Found' });
      if (segs.length === 2) return send(200, groupJson(g));
      if (segs[2] === 'descendant_groups') return send(200, [...groups.values()].filter((x) => x.full_path.startsWith(`${g.full_path}/`)).map(groupJson));
    }

    if (segs[0] === 'projects' && segs.length === 1) {
      if (req.method === 'POST') {
        if (flags.failNextCreate) { flags.failNextCreate = false; return send(503, { message: '503 Service Unavailable' }); }
        const body = await readBody(req);
        const ns = [...groups.values()].find((g) => g.id === body.namespace_id);
        const nsPath = ns ? ns.full_path : 'aldine-service';
        const fullName = `${nsPath}/${body.path}`;
        if (projects.has(fullName)) return send(400, { message: { path: ['has already been taken'], name: ['has already been taken'] } });
        const id = nextProjectId++;
        const bare = path.join(tmp, 'gl-repos', `${id}-${body.path}.git`);
        fs.mkdirSync(path.dirname(bare), { recursive: true });
        execSync(`git init -q --bare -b main "${bare}"`);
        const p = { id, fullName, path: body.path, name: body.name, namespaceId: ns?.id ?? null, visibility: body.visibility || 'private', bare, markedForDeletionOn: null };
        projects.set(fullName, p);
        recorded.created.push({ ...body, fullName, id });
        return send(201, projectJson(p));
      }
      return send(200, [...projects.values()].filter((p) => !p.markedForDeletionOn).map(projectJson));
    }

    if (segs[0] === 'projects' && segs.length >= 2) {
      const p = findProject(segs[1]);
      if (!p) return send(404, { message: '404 Project Not Found' });
      if (segs.length === 2 && req.method === 'GET') return send(200, projectJson(p));
      if (segs.length === 2 && req.method === 'DELETE') {
        const permanently = u.searchParams.get('permanently_remove') === 'true';
        const fullPath = u.searchParams.get('full_path');
        recorded.deleted.push({ target: segs[1], id: p.id, fullName: p.fullName, permanently, fullPath });
        if (flags.failDelete) return send(503, { message: '503 Service Unavailable' });
        if (permanently) {
          if (!p.markedForDeletionOn) return send(400, { message: 'Project is not marked for deletion' });
          if (fullPath !== p.fullName) return send(400, { message: '`full_path` is incorrect' });
          if (flags.refusePurge) return send(400, { message: 'Permanent removal is disabled' });
        } else if (flags.delayed && !p.markedForDeletionOn) {
          projects.delete(p.fullName);
          p.markedForDeletionOn = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
          p.fullName = `${p.fullName}-deleted-${p.id}`;
          projects.set(p.fullName, p);
          return send(202, { message: '202 Accepted' });
        }
        projects.delete(p.fullName);
        fs.rmSync(p.bare, { recursive: true, force: true });
        return send(202, { message: '202 Accepted' });
      }
      if (segs[2] === 'repository' && segs[3] === 'branches') return send(200, refs(p.bare).map((n) => ({ name: n })));
      if (segs[2] === 'merge_requests' && req.method === 'POST') {
        recorded.merge = await readBody(req);
        return send(201, { iid: 1, web_url: `https://gitlab.example.org/${p.fullName}/-/merge_requests/1` });
      }
    }

    console.error('gitlab mock: unhandled', req.method, req.url);
    send(404, {});
  });
  await new Promise((r) => server.listen(0, r));
  return {
    url: `http://localhost:${server.address().port}`,
    flags, recorded, revoked, groups, projects, addProject, findProject,
    /** Records the mock holds under `fullName` (or numeric id), null when absent. */
    project: (key) => findProject(String(key)),
    close: () => new Promise((r) => server.close(r)),
  };
}
