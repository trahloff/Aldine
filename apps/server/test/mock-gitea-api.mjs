/**
 * In-process Gitea/Forgejo v1 mock for the gitea-sync suite. Repositories
 * are backed by real bare repositories under `tmp` (clone_url `file://<bare>`)
 * so pushes land somewhere the tests can inspect with git.
 *
 * Shapes follow https://gitea.com/swagger.v1.json. Deviations the tests rely
 * on are deliberate and small:
 *  - `flags.maxItems` plays the server's MAX_RESPONSE_ITEMS: `limit` is
 *    clamped to it, the way a small instance clamps to fewer than 50; list
 *    responses carry `X-Total-Count` like the real server unless
 *    `flags.totalCount` is off;
 *  - `revoked` tokens answer 401 like an expired token; a `Bearer` header is
 *    refused too, since that is the GitLab/GitHub shape and not Gitea's;
 *  - orgs are a fixed set (`research`), `POST /orgs/{org}/repos` 404s for
 *    anything else, and `GET /user/orgs` lists them;
 *  - a second pull request with the same head and base answers 409, as
 *    Gitea does, and `GET /repos/{owner}/{repo}/pulls` lists the open ones;
 *  - `flags.forbidden` names a repository that answers 403, and `flags.down`
 *    closes every connection unanswered, for the import failures.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
export const refs = (bare) => sh(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`).trim().split('\n').filter(Boolean);
export const show = (bare, spec) => sh(`git --git-dir="${bare}" show ${spec}`);

export async function startGiteaMock({ tmp, login = 'tester' }) {
  const orgs = new Set(['research']);
  const repos = new Map(); // full_name → record
  let nextId = 100;
  const userJson = (name) => ({ id: name === login ? 7 : 8, login: name, full_name: name === login ? 'Tester' : '' });
  const repoJson = (r) => ({
    id: r.id, name: r.name, full_name: r.fullName, owner: userJson(r.owner), private: r.private,
    default_branch: 'main', clone_url: `file://${r.bare}`, html_url: `https://forge.example.org/${r.fullName}`,
    created_at: r.createdAt, updated_at: r.updatedAt,
  });
  /** Register an already existing repository (an "imported" one). */
  const addRepo = (fullName, bare, extra = {}) => {
    const [owner, name] = fullName.split('/');
    const r = { id: nextId++, fullName, owner, name, private: extra.private ?? true, bare, createdAt: '2026-01-01T00:00:00Z', updatedAt: extra.updatedAt || '2026-02-02T00:00:00Z' };
    repos.set(fullName, r);
    return r;
  };

  // `forbidden`: a repository path that answers 403; `down`: every call gets its socket closed, no answer.
  const flags = { maxItems: 50, failNextCreate: false, totalCount: true, forbidden: '', down: false };
  const recorded = { created: [], pulls: [], requests: [] };
  const revoked = new Set();
  const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });
  const paginate = (res, list, u) => {
    const limit = Math.min(Number(u.searchParams.get('limit')) || 30, flags.maxItems);
    const page = Math.max(Number(u.searchParams.get('page')) || 1, 1);
    if (flags.totalCount) res.setHeader('x-total-count', String(list.length));
    return list.slice((page - 1) * limit, page * limit);
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const send = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
    const u = new URL(req.url, 'http://mock');
    recorded.requests.push(`${req.method} ${u.pathname}${u.search}`);
    if (flags.down) return req.socket.destroy();
    const m = /^token (\S+)$/.exec(req.headers.authorization || '');
    const token = m?.[1];
    if (!token || revoked.has(token)) return send(401, { message: 'token is required', url: 'https://forge.example.org/api/swagger' });
    const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (segs[0] === 'user' && segs.length === 1) return send(200, userJson(login));
    if (segs[0] === 'user' && segs[1] === 'orgs' && req.method === 'GET') return send(200, paginate(res, [...orgs].map((name, i) => ({ id: 50 + i, name, username: name })), u));
    if (segs[0] === 'user' && segs[1] === 'repos') {
      if (req.method === 'POST') return create(login, await readBody(req));
      return send(200, paginate(res, [...repos.values()].map(repoJson), u));
    }
    if (segs[0] === 'orgs' && segs[2] === 'repos' && req.method === 'POST') {
      if (!orgs.has(segs[1])) return send(404, { message: 'organization does not exist' });
      return create(segs[1], await readBody(req));
    }
    if (segs[0] === 'repos' && segs.length >= 3) {
      if (flags.forbidden === `${segs[1]}/${segs[2]}`) return send(403, { message: 'user should have read access to this repository' });
      const r = repos.get(`${segs[1]}/${segs[2]}`);
      if (!r) return send(404, { message: 'The target couldn\'t be found.' });
      if (segs.length === 3 && req.method === 'GET') return send(200, repoJson(r));
      if (segs[3] === 'branches' && req.method === 'GET') return send(200, paginate(res, refs(r.bare).map((name) => ({ name })), u));
      if (segs[3] === 'pulls' && req.method === 'GET') {
        const open = recorded.pulls.filter((p) => p.repo === r.fullName).map((p) => ({ number: p.number, html_url: `https://forge.example.org/${r.fullName}/pulls/${p.number}`, head: { ref: p.head }, base: { ref: p.base } }));
        return send(200, paginate(res, open, u));
      }
      if (segs[3] === 'pulls' && req.method === 'POST') {
        const body = await readBody(req);
        const dup = recorded.pulls.find((p) => p.repo === r.fullName && p.head === body.head && p.base === body.base);
        if (dup) return send(409, { message: `pull request already exists for these targets [id: ${dup.number}, issue_id: ${dup.number}, head_repo_id: ${r.id}, base_repo_id: ${r.id}, head_branch: ${body.head}, base_branch: ${body.base}]` });
        const number = recorded.pulls.length + 1;
        recorded.pulls.push({ repo: r.fullName, number, ...body });
        return send(201, { id: number, number, html_url: `https://forge.example.org/${r.fullName}/pulls/${number}`, title: body.title });
      }
    }

    console.error('gitea mock: unhandled', req.method, req.url);
    send(404, { message: 'unhandled' });

    function create(owner, body) {
      if (flags.failNextCreate) { flags.failNextCreate = false; return send(500, { message: 'internal error (test switch)' }); }
      const fullName = `${owner}/${body.name}`;
      if (repos.has(fullName)) return send(409, { message: 'The repository with the same name already exists.' });
      const bare = path.join(tmp, 'gitea-repos', `${owner}-${body.name}.git`);
      fs.mkdirSync(path.dirname(bare), { recursive: true });
      execSync(`git init -q --bare -b main "${bare}"`);
      const r = addRepo(fullName, bare, { private: !!body.private, updatedAt: new Date().toISOString() });
      recorded.created.push({ owner, ...body, fullName });
      return send(201, repoJson(r));
    }
  });
  await new Promise((r) => server.listen(0, r));
  return {
    url: `http://localhost:${server.address().port}`,
    flags, recorded, revoked, orgs, repos, addRepo,
    close: () => new Promise((r) => server.close(r)),
  };
}
