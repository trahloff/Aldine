import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-glns-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');

const { withinRoot } = await import('../src/gitlab.ts');

// --- the privilege boundary, unit-tested first ---
check(withinRoot('research/latex', 'research/latex') === true, 'root is within itself');
check(withinRoot('research/latex', 'research/latex/papers') === true, 'child is within root');
check(withinRoot('research/latex', 'research/latex/a/b') === true, 'grandchild is within root');
// The '/' boundary matters: without it this passes and lets a caller create
// groups outside the configured root.
check(withinRoot('research/latex', 'research/latex-archive') === false, 'prefix sibling is NOT within root');
check(withinRoot('research/latex', 'research') === false, 'the parent is not within root');
check(withinRoot('research/latex', 'other/latex') === false, 'an unrelated group is not within root');
check(withinRoot('research/latex', '') === false, 'empty is not within root');
check(withinRoot('', 'anything') === false, 'no root configured means nothing is within it');
check(withinRoot('research/latex', '/research/latex/x/') === true, 'surrounding slashes are tolerated');

// --- routes ---
const GROUPS = {
  'research/latex': { id: 100, full_path: 'research/latex', name: 'latex' },
  'research/latex/papers': { id: 101, full_path: 'research/latex/papers', name: 'papers' },
  'research/latex/theses': { id: 102, full_path: 'research/latex/theses', name: 'theses' },
  'research/latex-archive': { id: 900, full_path: 'research/latex-archive', name: 'latex-archive' },
};
const created = [];
let nextId = 500;

const mock = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
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
  if (p === '/api/v4/groups' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const parent = Object.values(GROUPS).find((x) => x.id === body.parent_id);
      if (!parent) return send(400, { message: 'no such parent' });
      created.push(body);
      const full = `${parent.full_path}/${body.path}`;
      const ng = { id: nextId++, full_path: full, name: body.name };
      GROUPS[full] = ng;
      send(201, ng);
    });
    return;
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

let r = await app.inject({ url: '/api/remotes/gitlab/namespaces' });
check(r.statusCode === 200, 'namespaces ok: ' + r.body);
check(J(r).root === 'research/latex', 'reports the configured root');
const paths = J(r).namespaces.map((n) => n.fullPath);
check(paths.includes('research/latex'), 'includes the root group');
check(paths.includes('research/latex/papers') && paths.includes('research/latex/theses'), 'includes descendants: ' + paths);
check(!paths.includes('research/latex-archive'), 'a prefix sibling is not a descendant: ' + paths);

r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { parentPath: 'research/latex', name: 'Theses 2026' } });
check(r.statusCode === 200, 'creates a subgroup: ' + r.body);
check(J(r).fullPath === 'research/latex/theses-2026', 'slugified path: ' + r.body);
check(created.at(-1).parent_id === 100, 'created under the right parent');

// Without the boundary check these two would create groups anywhere on the instance.
const before = created.length;
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { parentPath: 'research/latex-archive', name: 'x' } });
check(r.statusCode === 400 && /inside research\/latex/.test(J(r).error), 'prefix-sibling parent rejected: ' + r.body);
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { parentPath: 'evil', name: 'x' } });
check(r.statusCode === 400, 'unrelated parent rejected');
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { parentPath: 'research', name: 'x' } });
check(r.statusCode === 400, 'parent of the root rejected');
check(created.length === before, 'no group reached GitLab from a rejected request');

// Defaults to the root when no parent is given.
r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { name: 'Defaulted' } });
check(J(r).fullPath === 'research/latex/defaulted', 'defaults the parent to the root: ' + r.body);

r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/subgroups', payload: { parentPath: 'research/latex', name: '   ' } });
check(r.statusCode === 400, 'a blank name is rejected');

// Group nesting has no GitHub analogue.
r = await app.inject({ url: '/api/remotes/github/namespaces' });
check(r.statusCode === 404, 'namespaces are GitLab-only');

// Unconfigured => the endpoints report that rather than half-working.
delete process.env.GITLAB_DEFAULT_GROUP;
r = await app.inject({ url: '/api/remotes/gitlab/namespaces' });
check(r.statusCode === 404, 'no default group configured => 404');

mock.close(); await app.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log('gitlab-namespaces: ALL PASSED');
