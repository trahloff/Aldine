import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { execSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-gl-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');

// A bare repo with content = the "GitLab project". This works because
// injectToken passes non-http URLs through untouched.
const bare = path.join(tmp, 'paper.git'); execSync(`git init --bare -b main "${bare}"`);
const seed = path.join(tmp, 'seed'); execSync(`git clone "${bare}" "${seed}" 2>/dev/null`);
fs.writeFileSync(path.join(seed, 'main.tex'), '\\documentclass{article}\\begin{document}From GitLab\\end{document}\n');
fs.writeFileSync(path.join(seed, 'README.md'), '# paper\n');
execSync(`cd "${seed}" && git add -A && git -c user.email=a@b.c -c user.name=t commit -q -m init && git push -q origin main`);

const FULL = 'grp/sub/paper';
const ENC = encodeURIComponent(FULL);
const project = {
  path_with_namespace: FULL, path: 'paper', namespace: { full_path: 'grp/sub' },
  visibility: 'private', default_branch: 'main', http_url_to_repo: `file://${bare}`,
  last_activity_at: '2026-01-01T00:00:00Z',
};

const mock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const u = req.url;
  if (u === '/api/v4/user') return res.end(JSON.stringify({ username: 'tester', name: 'Tester' }));
  if (u.startsWith('/api/v4/projects?')) return res.end(JSON.stringify([project]));
  if (u === `/api/v4/projects/${ENC}`) return res.end(JSON.stringify(project));
  if (u.startsWith(`/api/v4/projects/${ENC}/repository/branches`)) {
    const names = execSync(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`)
      .toString().trim().split('\n').filter(Boolean);
    return res.end(JSON.stringify(names.map((n) => ({ name: n }))));
  }
  if (u === `/api/v4/projects/${ENC}/merge_requests` && req.method === 'POST') {
    return res.end(JSON.stringify({ web_url: 'https://gitlab.com/grp/sub/paper/-/merge_requests/3', iid: 3 }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => mock.listen(0, r));
// Mirrors GITHUB_API_BASE: normaliseBaseUrl requires https, so a local mock
// cannot be reached through a connection's baseUrl.
process.env.GITLAB_API_BASE = `http://localhost:${mock.address().port}/api/v4`;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };

let r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/connect', payload: { token: 'fake' } });
check(r.statusCode === 200 && J(r).login === 'tester', 'connect ok: ' + r.body);

r = await app.inject({ url: '/api/remotes' });
check(J(r).some((p) => p.id === 'gitlab') && J(r).some((p) => p.id === 'github'), 'both providers listed: ' + r.body);

r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/connect', payload: { token: 'fake', baseUrl: 'http://insecure.example.com' } });
check(r.statusCode === 400, 'non-https base url rejected');

r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/connect', payload: { token: 'fake', baseUrl: 'nonsense' } });
check(r.statusCode === 400, 'unparseable base url rejected');

r = await app.inject({ url: '/api/remotes/gitlab/status' });
check(J(r).connected === true && J(r).login === 'tester', 'status connected: ' + r.body);

r = await app.inject({ url: '/api/remotes/gitlab/repos' });
check(Array.isArray(J(r)) && J(r)[0].fullName === FULL, 'repos list: ' + r.body);

r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/import', payload: { fullName: FULL } });
check(r.statusCode === 200, 'import: ' + r.body);
const id = J(r).id;
check(J(r).remote?.provider === 'gitlab' && J(r).remote?.fullName === FULL, 'remote recorded: ' + r.body);
check(J(r).rootFile === 'main.tex', 'root file detected');
check(fs.readFileSync(path.join(process.env.DATA_DIR, 'projects', id, 'main.tex'), 'utf8').includes('From GitLab'), 'content cloned');
check(!execSync(`git -C "${path.join(process.env.DATA_DIR, 'projects', id)}" remote -v`).toString().includes('oauth2:'), 'token never persisted to origin');

r = await app.inject({ url: `/api/projects/${id}/remote/status` });
check(J(r).linked === true && J(r).ahead === 0 && J(r).behind === 0, 'status: ' + r.body);

fs.writeFileSync(path.join(process.env.DATA_DIR, 'projects', id, 'main.tex'), '\\documentclass{article}\\begin{document}Edited\\end{document}\n');
r = await app.inject({ method: 'POST', url: `/api/projects/${id}/remote/push`, payload: { message: 'edit' } });
check(J(r).ok === true, 'push: ' + r.body);
check(execSync(`git --git-dir="${bare}" show main:main.tex`).toString().includes('Edited'), 'remote has the edit');
check(execSync(`git --git-dir="${bare}" log -1 --format=%s main`).toString().includes('edit'), 'commit message used');

r = await app.inject({ url: `/api/projects/${id}/remote/branches` });
check(J(r).branches.includes('main') && J(r).current === 'main' && J(r).default === 'main', 'branches: ' + r.body);

r = await app.inject({ method: 'POST', url: `/api/projects/${id}/remote/create-branch`, payload: { name: 'draft' } });
check(J(r).branch === 'draft', 'create branch: ' + r.body);
r = await app.inject({ url: `/api/projects/${id}` });
check(J(r).remote.remoteBranch === 'draft', 'tracked branch persisted: ' + r.body);

r = await app.inject({ method: 'POST', url: `/api/projects/${id}/remote/change-request`, payload: { title: 'Draft' } });
check(J(r).number === 3 && J(r).url.includes('merge_requests'), 'merge request: ' + r.body);

r = await app.inject({ method: 'POST', url: `/api/projects/${id}/remote/switch-branch`, payload: { branch: 'main' } });
check(J(r).branch === 'main', 'switch back: ' + r.body);

r = await app.inject({ method: 'POST', url: `/api/projects/${id}/remote/pull` });
check(J(r).ok === true, 'pull: ' + r.body);

// An unknown provider must 404 rather than falling through to a default.
r = await app.inject({ url: '/api/remotes/bitbucket/status' });
check(r.statusCode === 404, 'unknown provider 404s');
r = await app.inject({ method: 'POST', url: '/api/remotes/bitbucket/import', payload: { fullName: 'a/b' } });
check(r.statusCode === 404, 'unknown provider cannot import');

// A legacy meta.github project must still resolve its provider through the shim.
const legacyId = 'legacyproj0001';
const legacyDir = path.join(process.env.DATA_DIR, 'projects', legacyId);
execSync(`git clone -q "${bare}" "${legacyDir}"`);
const store = await import('../src/store.ts');
await store.writeMeta({
  id: legacyId, name: 'legacy', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(),
  github: { fullName: 'octocat/hello', owner: 'octocat', repo: 'hello', remoteBranch: 'main', cloneUrl: `file://${bare}` },
});
// Only a GitLab connection exists, so asking for a *GitHub* one proves the
// provider was resolved from the stored link rather than defaulted or taken
// from the request path.
r = await app.inject({ url: `/api/projects/${legacyId}/remote/status` });
check(r.statusCode === 400 && /Connect GitHub/.test(J(r).error), 'legacy github project resolves its provider through the shim: ' + r.body);

r = await app.inject({ method: 'POST', url: '/api/remotes/gitlab/disconnect' });
check(J(r).ok === true, 'disconnect');
r = await app.inject({ url: '/api/remotes/gitlab/status' });
check(J(r).connected === false, 'disconnected');

mock.close(); await app.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log('GitLab integration (connect→import→push→branches→MR→switch→pull): ALL PASSED');
