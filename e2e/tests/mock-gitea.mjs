/**
 * Mock Gitea/Forgejo REST v1 for e2e. Repositories are real bare git repos
 * under .data-e2e-gitea so the app's clone/push/fetch run against them; the
 * HTTP side answers just the calls apps/server/src/gitea.ts makes, in the
 * shapes of https://gitea.com/swagger.v1.json. Seeded with e2e-user/paper.
 * Any `Authorization: token …` works except `bad` (401) — that is how a spec
 * provokes the token-invalid path; a Bearer header is refused because that is
 * not Gitea's shape.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.E2E_GITEA_PORT || 4923);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data-e2e-gitea');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const git = (cmd, cwd = root) => execSync(`git ${cmd}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

const LOGIN = 'e2e-user';
const orgs = new Set(['e2e-org']);
/** @type {Map<string, { id: number; fullName: string; owner: string; name: string; bare: string; private: boolean; createdAt: string }>} */
const repos = new Map();
let nextId = 100;
const pulls = [];

function createRepo(fullName, priv = true, seed = null) {
  const [owner, name] = fullName.split('/');
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
  const r = { id: nextId++, fullName, owner, name, bare, private: priv, createdAt: new Date().toISOString() };
  repos.set(fullName, r);
  return r;
}

const userJson = (login) => ({ id: login === LOGIN ? 7 : 8, login, full_name: login === LOGIN ? 'E2E User' : '' });
const repoJson = (r) => ({
  id: r.id, name: r.name, full_name: r.fullName, owner: userJson(r.owner), private: r.private,
  default_branch: 'main', clone_url: `file://${r.bare}`, html_url: `http://localhost:${port}/${r.fullName}`,
  created_at: r.createdAt, updated_at: r.createdAt,
});

createRepo('e2e-user/paper', true, {
  'main.tex': '\\documentclass{article}\n\\begin{document}\nHello from Forgejo\n\\end{document}\n',
  'README.md': '# paper\n',
});

const paginate = (list, url) => {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 50);
  const page = Math.max(Number(url.searchParams.get('page')) || 1, 1);
  return list.slice((page - 1) * limit, page * limit);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // test-only inspection, no auth
  if (url.pathname === '/__pulls') return send(200, pulls);
  if (url.pathname === '/__repos') return send(200, [...repos.values()].map(repoJson));
  if (url.pathname.startsWith('/__delete/')) {
    const key = decodeURIComponent(url.pathname.slice('/__delete/'.length));
    const r = repos.get(key);
    if (r) { fs.rmSync(r.bare, { recursive: true, force: true }); repos.delete(key); }
    return send(200, { deleted: !!r });
  }
  const m = /^token (\S+)$/.exec(req.headers.authorization || '');
  if (!m || m[1] === 'bad') return send(401, { message: 'token is required' });

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { handle(); } catch (err) { send(500, { message: String(err?.message || err) }); }
  });
  function handle() {
    const body = raw ? JSON.parse(raw) : {};
    const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (req.method === 'GET' && url.pathname === '/user') return send(200, userJson(LOGIN));
    if (segs[0] === 'user' && segs[1] === 'repos' && req.method === 'GET') return send(200, paginate([...repos.values()].map(repoJson), url));
    if (segs[0] === 'user' && segs[1] === 'repos' && req.method === 'POST') return create(LOGIN, body);
    if (segs[0] === 'orgs' && segs[2] === 'repos' && req.method === 'POST') {
      if (!orgs.has(segs[1])) return send(404, { message: 'organization does not exist' });
      return create(segs[1], body);
    }
    if (segs[0] === 'repos' && segs.length >= 3) {
      const r = repos.get(`${segs[1]}/${segs[2]}`);
      if (!r) return send(404, { message: 'The target couldn\'t be found.' });
      if (segs.length === 3 && req.method === 'GET') return send(200, repoJson(r));
      if (segs[3] === 'branches' && req.method === 'GET') {
        const names = git(`--git-dir="${r.bare}" for-each-ref --format="%(refname:short)" refs/heads`).split('\n').filter(Boolean);
        return send(200, paginate(names.map((name) => ({ name })), url));
      }
      if (segs[3] === 'pulls' && req.method === 'POST') {
        const number = pulls.length + 1;
        pulls.push({ repo: r.fullName, number, ...body });
        return send(201, { id: number, number, html_url: `http://localhost:${port}/${r.fullName}/pulls/${number}`, title: body.title });
      }
    }
    send(404, { message: `404 Not Found: ${req.method} ${url.pathname}` });

    function create(owner, opts) {
      const fullName = `${owner}/${opts.name}`;
      if (repos.has(fullName)) return send(409, { message: 'The repository with the same name already exists.' });
      return send(201, repoJson(createRepo(fullName, !!opts.private)));
    }
  }
});

server.listen(port, () => console.log(`[mock-gitea] on :${port}, repos under ${root}`));
