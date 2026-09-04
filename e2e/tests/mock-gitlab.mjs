/**
 * Mock GitLab REST API (/api/v4) for e2e tests, backed by real bare repos on
 * disk so clone and push actually work. Listens on a fixed port so
 * playwright.config.ts can point GITLAB_API_BASE at it.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const PORT = 4921;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data-e2e-gitlab');

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

/** Create a bare repo and return its file:// URL. Seeded repos get a paper in them. */
function makeBare(name, seedTex, extra) {
  const bare = path.join(ROOT, `${name.replace(/\//g, '__')}.git`);
  if (fs.existsSync(bare)) return `file://${bare}`;
  execSync(`git init --bare -b main "${bare}"`, { stdio: 'ignore' });
  if (seedTex) {
    const work = path.join(ROOT, `seed-${name.replace(/\//g, '__')}`);
    execSync(`git clone -q "${bare}" "${work}"`, { stdio: 'ignore' });
    fs.writeFileSync(path.join(work, 'main.tex'), seedTex);
    fs.writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
    for (const [rel, content] of Object.entries(extra || {})) fs.writeFileSync(path.join(work, rel), content);
    execSync(`cd "${work}" && git add -A && git -c user.email=e@e.e -c user.name=e commit -q -m init && git push -q origin main`, { stdio: 'ignore' });
  }
  return `file://${bare}`;
}

const SEEDED = 'grp/sub/paper';
const seedUrl = makeBare(SEEDED, '\\documentclass{article}\n\\begin{document}\nImported from GitLab.\n\\end{document}\n');

const GROUPS = {
  'research/latex': { id: 100, full_path: 'research/latex', name: 'latex' },
  'research/latex/papers': { id: 101, full_path: 'research/latex/papers', name: 'papers' },
  'research/latex/theses': { id: 102, full_path: 'research/latex/theses', name: 'theses' },
  'research/latex/templates': { id: 103, full_path: 'research/latex/templates', name: 'templates' },
  'grp/sub': { id: 200, full_path: 'grp/sub', name: 'sub' },
};
const byId = (id) => Object.values(GROUPS).find((g) => g.id === id);

/** Projects the mock knows about, keyed by full path. */
const projects = {
  [SEEDED]: {
    id: 1, path_with_namespace: SEEDED, path: 'paper', namespace: GROUPS['grp/sub'],
    visibility: 'private', default_branch: 'main', http_url_to_repo: seedUrl,
    last_activity_at: '2026-01-01T00:00:00Z',
  },
};

/**
 * A template project, offered in the New project dialog when the app server has
 * GITLAB_TEMPLATE_GROUP set. Its main.tex carries a placeholder so the test can
 * prove substitution happened.
 */
const TEMPLATE = 'research/latex/templates/poster';
projects[TEMPLATE] = {
  id: 90, path_with_namespace: TEMPLATE, path: 'poster', namespace: GROUPS['research/latex/templates'],
  visibility: 'private', default_branch: 'main', name: 'poster', description: 'A0 conference poster',
  http_url_to_repo: makeBare(
    TEMPLATE,
    '\\documentclass{a0poster}\n\\begin{document}\nPOSTER TEMPLATE for {{PROJECT_NAME}}\n\\end{document}\n',
    { 'template.json': JSON.stringify({ name: 'Conference poster', icon: '🖼', order: 1 }) },
  ),
  last_activity_at: '2026-02-01T00:00:00Z',
};

let nextId = 2;
let failing = false;
/** Paths this mock has been asked to delete, so tests can assert on them. */
const deleted = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Test control: flip the whole API into failure so the degraded path can be driven.
  if (p === '/__fail') { failing = url.searchParams.get('on') === '1'; return send(200, { failing }); }
  if (p === '/__deleted') return send(200, deleted);
  if (failing) return send(500, { message: 'mock gitlab is down' });

  if (p === '/api/v4/user') return send(200, { username: 'e2e-user', name: 'E2E User' });

  if (p === '/api/v4/projects' && req.method === 'GET') return send(200, Object.values(projects));

  if (p === '/api/v4/projects' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const group = byId(body.namespace_id) || GROUPS['research/latex'];
      const full = `${group.full_path}/${body.path}`;
      if (projects[full]) return send(400, { message: { path: ['has already been taken'] } });
      const proj = {
        id: nextId++, path_with_namespace: full, path: body.path, namespace: group,
        visibility: body.visibility || 'private', default_branch: 'main',
        http_url_to_repo: makeBare(full, null), last_activity_at: new Date().toISOString(),
      };
      projects[full] = proj;
      send(201, proj);
    });
    return;
  }

  const groupMatch = p.match(/^\/api\/v4\/groups\/([^/]+)$/);
  if (groupMatch) {
    const g = GROUPS[decodeURIComponent(groupMatch[1])];
    return g ? send(200, g) : send(404, { message: '404 Group Not Found' });
  }

  const groupProjects = p.match(/^\/api\/v4\/groups\/([^/]+)\/projects$/);
  if (groupProjects) {
    const root = decodeURIComponent(groupProjects[1]);
    return send(200, Object.values(projects).filter((x) => x.path_with_namespace.startsWith(`${root}/`)));
  }

  const descMatch = p.match(/^\/api\/v4\/groups\/([^/]+)\/descendant_groups$/);
  if (descMatch) {
    const root = decodeURIComponent(descMatch[1]);
    return send(200, Object.values(GROUPS).filter((g) => g.full_path.startsWith(`${root}/`)));
  }

  if (p === '/api/v4/groups' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const parent = byId(body.parent_id);
      if (!parent) return send(400, { message: 'no such parent' });
      const full = `${parent.full_path}/${body.path}`;
      const g = { id: nextId++, full_path: full, name: body.name };
      GROUPS[full] = g;
      send(201, g);
    });
    return;
  }

  const projMatch = p.match(/^\/api\/v4\/projects\/([^/]+)(\/.*)?$/);
  if (projMatch) {
    // Addressable by numeric id as well as by path: a project marked for
    // deletion is renamed, so its id is the only stable handle.
    const key = decodeURIComponent(projMatch[1]);
    const proj = projects[key] || Object.values(projects).find((x) => String(x.id) === key);
    if (!proj) return send(404, { message: '404 Project Not Found' });
    const full = proj.path_with_namespace;
    const rest = projMatch[2] || '';
    // GitLab only marks a project on the first DELETE (and renames it to free
    // the path); the purge is a second DELETE with permanently_remove. Mocking
    // it as an immediate delete hides the follow-up Aldine has to make.
    if (!rest && req.method === 'DELETE') {
      delete projects[proj.path_with_namespace];
      if (url.searchParams.get('permanently_remove') === 'true') {
        deleted.push(proj.originalPath || full);
        return send(202, {});
      }
      proj.originalPath = full;
      proj.marked_for_deletion_on = '2026-10-01';
      proj.path_with_namespace = `${full}-deleted-${proj.id}`;
      projects[proj.path_with_namespace] = proj;
      return send(202, {});
    }
    if (!rest) return send(200, proj);
    if (rest.startsWith('/repository/branches')) {
      const bare = proj.http_url_to_repo.replace('file://', '');
      const names = execSync(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`)
        .toString().trim().split('\n').filter(Boolean);
      return send(200, names.map((n) => ({ name: n })));
    }
    const rawFile = rest.match(/^\/repository\/files\/([^/]+)\/raw$/);
    if (rawFile) {
      const bare = proj.http_url_to_repo.replace('file://', '');
      const ref = url.searchParams.get('ref') || 'main';
      try {
        const body = execSync(`git --git-dir="${bare}" show ${ref}:${decodeURIComponent(rawFile[1])}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(body);
      } catch {
        return send(404, { message: '404 File Not Found' });
      }
    }
    if (rest === '/merge_requests' && req.method === 'POST') {
      return send(201, { web_url: `https://gitlab.example.com/${full}/-/merge_requests/1`, iid: 1 });
    }
  }

  send(404, { message: 'not mocked' });
});

server.listen(PORT, () => console.log(`[mock-gitlab] listening on ${PORT}`));
