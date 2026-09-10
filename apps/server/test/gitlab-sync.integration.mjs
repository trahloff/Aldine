/**
 * GitLab as a remote provider, end to end over the routes: PAT connect with a
 * self-hosted base URL, import of a three-segment path, push/pull/conflict,
 * branches and a merge request, publish (`link`) into a group, the legacy
 * `github` meta shim and every pre-GitLab `/api/github/*` alias.
 *
 * Two bare repos stand in for the hosts (clone_url is `file://<bare>`); two
 * `node:http` mocks answer the REST calls behind GITLAB_API_BASE and
 * GITHUB_API_BASE. Both env vars must be set before the routes are imported.
 */
import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { execSync } from 'node:child_process';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-gl-'));
process.env.DATA_DIR = path.join(tmp, 'data'); process.env.META_DIR = path.join(tmp, 'secrets');
delete process.env.REMOTE_PROVIDERS;

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const refs = (bare) => sh(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`).trim().split('\n').filter(Boolean);
function seedBare(name, content) {
  const bare = path.join(tmp, `${name}.git`); execSync(`git init -q --bare -b main "${bare}"`);
  const seed = path.join(tmp, `${name}-seed`); execSync(`git clone -q "${bare}" "${seed}" 2>/dev/null`);
  fs.writeFileSync(path.join(seed, 'main.tex'), content);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`);
  execSync(`cd "${seed}" && git add -A && git -c user.email=a@b.c -c user.name=t commit -q -m init && git push -q origin main`);
  return { bare, seed };
}
const gl = seedBare('paper', '\\documentclass{article}\\begin{document}From GitLab\\end{document}\n');
const gh = seedBare('hello', '\\documentclass{article}\\begin{document}From GitHub\\end{document}\n');

// ---------- GitLab v4 mock ----------
const glProject = (fullName, bare, extra = {}) => {
  const segs = fullName.split('/');
  return {
    id: 100 + segs.length, path_with_namespace: fullName, path: segs.at(-1), name: extra.name || segs.at(-1),
    namespace: { full_path: segs.slice(0, -1).join('/') }, visibility: 'private', default_branch: 'main',
    http_url_to_repo: `file://${bare}`, last_activity_at: '2026-02-02T00:00:00Z', ...extra,
  };
};
const glProjects = new Map([['grp/sub/paper', { json: glProject('grp/sub/paper', gl.bare), bare: gl.bare }]]);
const revoked = new Set(['bad']);
const recorded = { created: [] };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const glMock = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token || revoked.has(token)) { res.statusCode = 401; return res.end('{"message":"401 Unauthorized"}'); }
  const u = new URL(req.url, 'http://mock');
  // percent-encoded path segments: `grp%2Fsub%2Fpaper` is ONE segment on the wire
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segs[0] === 'user') return res.end(JSON.stringify({ username: 'tester', name: 'Tester' }));
  if (segs[0] === 'groups' && segs[1] === 'grp/sub') return res.end(JSON.stringify({ id: 42, full_path: 'grp/sub' }));
  if (segs[0] === 'projects' && segs.length === 1) {
    if (req.method === 'POST') {
      const body = await readBody(req); recorded.created.push(body);
      const ns = body.namespace_id === 42 ? 'grp/sub' : 'tester';
      const fullName = `${ns}/${body.path}`;
      const bare = path.join(tmp, 'created', `${body.path}.git`); fs.mkdirSync(path.dirname(bare), { recursive: true });
      execSync(`git init -q --bare -b main "${bare}"`);
      const json = glProject(fullName, bare, { name: body.name, visibility: body.visibility });
      glProjects.set(fullName, { json, bare });
      res.statusCode = 201; return res.end(JSON.stringify(json));
    }
    check(u.searchParams.get('membership') === 'true', 'listRepos asks for membership only');
    return res.end(JSON.stringify([...glProjects.values()].map((p) => p.json)));
  }
  if (segs[0] === 'projects' && segs.length >= 2) {
    const p = glProjects.get(segs[1]);
    if (!p) { res.statusCode = 404; return res.end('{"message":"404 Project Not Found"}'); }
    if (segs.length === 2) return res.end(JSON.stringify(p.json));
    if (segs[2] === 'repository' && segs[3] === 'branches') return res.end(JSON.stringify(refs(p.bare).map((n) => ({ name: n }))));
    if (segs[2] === 'merge_requests' && req.method === 'POST') {
      const body = await readBody(req); recorded.mr = body;
      res.statusCode = 201; return res.end(JSON.stringify({ iid: 3, web_url: `https://gitlab.example.org/gl/${segs[1]}/-/merge_requests/3` }));
    }
  }
  console.error('gitlab mock: unhandled', req.method, req.url);
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => glMock.listen(0, r)); process.env.GITLAB_API_BASE = `http://localhost:${glMock.address().port}`;

// ---------- GitHub mock (only what the legacy-shim and alias checks need) ----------
const ghRepo = { full_name: 'octocat/hello', name: 'hello', default_branch: 'main', clone_url: `file://${gh.bare}`, owner: { login: 'octocat' }, private: false, updated_at: '2026-01-01' };
const ghMock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/user') return res.end(JSON.stringify({ login: 'ghtester', name: 'GH Tester' }));
  if (req.url.startsWith('/user/repos')) return res.end(JSON.stringify([ghRepo]));
  if (req.url === '/repos/octocat/hello') return res.end(JSON.stringify(ghRepo));
  if (req.url.startsWith('/repos/octocat/hello/branches')) return res.end(JSON.stringify(refs(gh.bare).map((n) => ({ name: n }))));
  if (req.url === '/repos/octocat/hello/pulls' && req.method === 'POST') return res.end(JSON.stringify({ html_url: 'https://github.com/octocat/hello/pull/7', number: 7 }));
  console.error('github mock: unhandled', req.method, req.url);
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => ghMock.listen(0, r)); process.env.GITHUB_API_BASE = `http://localhost:${ghMock.address().port}`;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { newId } = await import('../src/util.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };
const projectDir = (id) => path.join(process.env.DATA_DIR, 'projects', id);

// ---------- account level ----------
let r = await app.inject({url: '/api/remotes'});
const listed = J(r);
check(r.statusCode === 200 && listed.map((p) => p.id).sort().join() === 'github,gitlab', 'both providers listed: ' + r.body);
check(listed.find((p) => p.id === 'gitlab').changeRequestLabel === 'merge request', 'gitlab noun is merge request');
check(listed.find((p) => p.id === 'github').changeRequestLabel === 'pull request', 'github noun is pull request');
check(listed.find((p) => p.id === 'gitlab').selfHosted === true, 'gitlab is self-hostable');

r = await app.inject({url: '/api/remotes/nope/status'});
check(r.statusCode === 404 && J(r).error === 'Unknown remote provider', 'unknown provider 404: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/nope/connect', payload: {token: 'good'}});
check(r.statusCode === 404, 'unknown provider connect 404');

r = await app.inject({url: '/api/remotes/gitlab/status'});
check(r.statusCode === 200 && J(r).connected === false, 'gitlab not connected yet: ' + r.body);
r = await app.inject({url: '/api/remotes/gitlab/repos'});
check(r.statusCode === 400, 'repos before connect → 400');

// a malformed base URL never reaches the network (the https check itself is bypassed under GITLAB_API_BASE)
r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/connect', payload: {token: 'good', baseUrl: 'not a url'}});
check(r.statusCode === 400 && /https/.test(J(r).error), 'malformed baseUrl → 400: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/connect', payload: {token: 'good', baseUrl: 'https://gitlab.example.org/?x=1'}});
check(r.statusCode === 400 && /query/.test(J(r).error), 'baseUrl with query → 400: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/github/connect', payload: {token: 'good', baseUrl: 'https://ghe.example.org'}});
check(r.statusCode === 400 && /no configurable URL/.test(J(r).error), 'github rejects baseUrl: ' + r.body);

r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/connect', payload: {token: 'bad'}});
check(r.statusCode === 400 && /rejected/.test(J(r).error), 'bad token → 400: ' + r.body);
r = await app.inject({url: '/api/remotes/gitlab/status'});
check(J(r).connected === false, 'a rejected token stores no connection');

r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/connect', payload: {token: 'good', baseUrl: 'https://gitlab.example.org/gl/'}});
check(r.statusCode === 200 && J(r).login === 'tester' && J(r).baseUrl === 'https://gitlab.example.org/gl', 'PAT connect with sub-path base: ' + r.body);
r = await app.inject({url: '/api/remotes/gitlab/status'});
check(J(r).connected === true && J(r).login === 'tester' && J(r).baseUrl === 'https://gitlab.example.org/gl', 'status shows normalised baseUrl: ' + r.body);

r = await app.inject({url: '/api/remotes/gitlab/repos'});
check(r.statusCode === 200 && Array.isArray(J(r)) && J(r)[0].fullName === 'grp/sub/paper', 'repos list: ' + r.body);
check(J(r)[0].owner === 'grp/sub' && J(r)[0].private === true && J(r)[0].cloneUrl === `file://${gl.bare}`, 'repo mapped from v4 shape: ' + r.body);

// ---------- import a three-segment path ----------
r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/import', payload: {fullName: 'nope'}});
check(r.statusCode === 400, 'import without a slash → 400');
r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/import', payload: {fullName: 'grp/sub/missing'}});
check(r.statusCode === 400 && /not found/.test(J(r).error), 'import of an unknown project → 400: ' + r.body);

r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/import', payload: {fullName: 'grp/sub/paper'}});
check(r.statusCode === 200, 'import status ' + r.body);
const pid = J(r).id; check(pid, 'got project id');
check(J(r).remote?.provider === 'gitlab' && J(r).remote?.fullName === 'grp/sub/paper', 'summary carries the gitlab link: ' + r.body);
check(J(r).remote?.owner === 'grp/sub' && J(r).remote?.repo === 'paper' && J(r).remote?.remoteBranch === 'main', 'link fields: ' + JSON.stringify(J(r).remote));
check(!('github' in J(r)) || J(r).github == null, 'no legacy github field for a gitlab link: ' + r.body);
check(fs.existsSync(path.join(projectDir(pid), 'main.tex')), 'imported main.tex present');
check(fs.readFileSync(path.join(projectDir(pid), 'main.tex'), 'utf8').includes('From GitLab'), 'imported the GitLab content');
const glMeta = await store.readMeta(pid);
check(glMeta.remote?.provider === 'gitlab' && !glMeta.github, 'stored meta uses `remote`, not `github`');

// ---------- push / pull / conflict ----------
fs.writeFileSync(path.join(projectDir(pid), 'main.tex'), '\\documentclass{article}\\begin{document}EDITED IN ALDINE\\end{document}\n');
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/push`});
check(r.statusCode === 200, 'push status ' + r.body);
check(sh(`git --git-dir="${gl.bare}" show main:main.tex`).includes('EDITED IN ALDINE'), 'push reached the GitLab bare repo');

execSync(`cd "${gl.seed}" && git pull -q && printf 'EXTERNAL\\n' >> main.tex && git -c user.email=a@b.c -c user.name=t commit -qam ext && git push -q`);
r = await app.inject({url: `/api/projects/${pid}/remote/status`});
check(r.statusCode === 200 && J(r).linked === true && J(r).provider === 'gitlab' && J(r).behind === 1, 'behind 1 after external push: ' + r.body);
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/pull`});
check(r.statusCode === 200, 'pull ok ' + r.body);
check(fs.readFileSync(path.join(projectDir(pid), 'main.tex'), 'utf8').includes('EXTERNAL'), 'pulled external change');

execSync(`cd "${gl.seed}" && git pull -q && printf 'REMOTE VERSION\\n' > main.tex && git -c user.email=a@b.c -c user.name=t commit -qam remoteedit && git push -q`);
fs.writeFileSync(path.join(projectDir(pid), 'main.tex'), 'LOCAL VERSION\n');
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/pull`});
check(r.statusCode === 409, 'pull conflicts with 409 (got ' + r.statusCode + ')');
check(Array.isArray(J(r).conflicts) && J(r).conflicts.includes('main.tex'), 'conflict lists main.tex');
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/reset-to-remote`});
check(r.statusCode === 200, 'reset-to-remote ok ' + r.body);
check(fs.readFileSync(path.join(projectDir(pid), 'main.tex'), 'utf8').trim() === 'REMOTE VERSION', 'took the remote version');

// ---------- branches + merge request ----------
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/change-request`, payload: {title: 'Too early'}});
check(r.statusCode === 400 && /default branch/.test(J(r).error), 'MR from the default branch → 400: ' + r.body);

r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/create-branch`, payload: {name: 'feature-y'}});
check(r.statusCode === 200 && J(r).branch === 'feature-y', 'create-branch ' + r.body);
check(refs(gl.bare).includes('feature-y'), 'GitLab bare repo has feature-y');
r = await app.inject({url: `/api/projects/${pid}/remote/branches`});
check(J(r).current === 'feature-y' && J(r).default === 'main' && J(r).branches.includes('main') && J(r).branches.includes('feature-y'), 'branches list + current: ' + r.body);

r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/change-request`, payload: {title: 'My MR'}});
check(r.statusCode === 200 && J(r).number === 3 && J(r).url.endsWith('/grp/sub/paper/-/merge_requests/3'), 'MR opened: ' + r.body);
check(recorded.mr?.source_branch === 'feature-y' && recorded.mr?.target_branch === 'main' && recorded.mr?.title === 'My MR', 'MR body uses GitLab field names: ' + JSON.stringify(recorded.mr));

r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/switch-branch`, payload: {branch: 'main'}});
check(r.statusCode === 200 && J(r).branch === 'main', 'switch back to main ' + r.body);
r = await app.inject({url: `/api/projects/${pid}/remote/branches`});
check(J(r).current === 'main', 'current is main after switch');

// ---------- provider comes from the link, never from the URL ----------
r = await app.inject({method: 'POST', url: '/api/github/connect', payload: {token: 'gh-token'}});
check(r.statusCode === 200 && J(r).login === 'ghtester', 'legacy /api/github/connect: ' + r.body);
r = await app.inject({url: '/api/github/status'});
check(r.statusCode === 200 && J(r).connected === true && J(r).login === 'ghtester', 'legacy /api/github/status: ' + r.body);
r = await app.inject({url: '/api/github/repos'});
check(r.statusCode === 200 && J(r)[0].fullName === 'octocat/hello', 'legacy /api/github/repos: ' + r.body);
r = await app.inject({url: '/api/remotes/gitlab/status'});
check(J(r).connected === true && J(r).login === 'tester', 'gitlab connection untouched by the github one');

fs.writeFileSync(path.join(projectDir(pid), 'main.tex'), 'BOTH CONNECTED\n');
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/github/push`, payload: {message: 'via legacy alias'}});
check(r.statusCode === 200, 'push through the /github/ alias on a gitlab project: ' + r.body);
check(sh(`git --git-dir="${gl.bare}" show main:main.tex`).trim() === 'BOTH CONNECTED', 'the alias still pushed to the GitLab repo');
check(!sh(`git --git-dir="${gh.bare}" show main:main.tex`).includes('BOTH CONNECTED'), 'nothing reached the GitHub repo');
r = await app.inject({url: `/api/projects/${pid}/github/status`});
check(r.statusCode === 200 && J(r).provider === 'gitlab' && J(r).ahead === 0 && J(r).behind === 0, 'legacy project status names the linked provider: ' + r.body);

// ---------- legacy meta with only `github: {...}` syncs through the shim ----------
const legacyId = newId();
await gitops.cloneRepo(legacyId, `file://${gh.bare}`);
await store.writeMeta({
  id: legacyId, name: 'hello', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(),
  github: { fullName: 'octocat/hello', owner: 'octocat', repo: 'hello', remoteBranch: 'main', cloneUrl: `file://${gh.bare}` },
});
r = await app.inject({url: `/api/projects/${legacyId}`});
check(r.statusCode === 200 && J(r).remote?.provider === 'github' && J(r).github?.fullName === 'octocat/hello', 'summary shims github into remote (and keeps github): ' + r.body);
r = await app.inject({url: `/api/projects/${legacyId}/remote/status`});
check(r.statusCode === 200 && J(r).linked === true && J(r).provider === 'github' && J(r).fullName === 'octocat/hello' && J(r).behind === 0, 'legacy project syncs via /remote/status: ' + r.body);
r = await app.inject({url: `/api/projects/${legacyId}/github/status`});
check(r.statusCode === 200 && J(r).provider === 'github', 'legacy project via /github/status: ' + r.body);
fs.writeFileSync(path.join(projectDir(legacyId), 'main.tex'), 'LEGACY PUSH\n');
r = await app.inject({method: 'POST', url: `/api/projects/${legacyId}/remote/push`});
check(r.statusCode === 200 && sh(`git --git-dir="${gh.bare}" show main:main.tex`).trim() === 'LEGACY PUSH', 'legacy project pushes to the GitHub repo: ' + r.body);
check((await store.readMeta(legacyId)).github && !(await store.readMeta(legacyId)).remote, 'a push alone does not rewrite the meta');

r = await app.inject({method: 'POST', url: `/api/projects/${legacyId}/github/pr`, payload: {title: 'Legacy PR'}});
check(r.statusCode !== 404, 'legacy /github/pr still answers');
check(r.statusCode === 400 && /default branch/.test(J(r).error), 'pr on the default branch → 400: ' + r.body);
r = await app.inject({url: `/api/projects/${legacyId}/github/branches`});
check(r.statusCode === 200 && J(r).current === 'main', 'legacy /github/branches: ' + r.body);

execSync(`cd "${gh.seed}" && git pull -q && git checkout -q -b dev && printf 'DEV\\n' > main.tex && git -c user.email=a@b.c -c user.name=t commit -qam dev && git push -q origin dev`);
r = await app.inject({method: 'POST', url: `/api/projects/${legacyId}/remote/switch-branch`, payload: {branch: 'dev'}});
check(r.statusCode === 200 && J(r).branch === 'dev', 'legacy project switches branch: ' + r.body);
const migrated = await store.readMeta(legacyId);
check(migrated.remote?.provider === 'github' && migrated.remote?.remoteBranch === 'dev' && migrated.remote?.fullName === 'octocat/hello', 'switch-branch wrote `remote`: ' + JSON.stringify(migrated.remote));
check(!('github' in migrated), 'and dropped the legacy `github` field');
r = await app.inject({method: 'POST', url: `/api/projects/${legacyId}/github/pr`, payload: {title: 'Legacy PR'}});
check(r.statusCode === 200 && J(r).number === 7, 'legacy /github/pr opens a PR from dev: ' + r.body);

// ---------- publish a fresh local project into a GitLab group ----------
r = await app.inject({method: 'POST', url: '/api/projects', payload: {name: 'New Paper'}});
check(r.statusCode === 200 || r.statusCode === 201, 'create local project ' + r.body);
const fresh = J(r).id;
check(J(r).remote === null, 'fresh project has no link: ' + r.body);
r = await app.inject({method: 'POST', url: `/api/projects/${fresh}/remote/link`, payload: {name: 'New Paper'}});
check(r.statusCode === 400 && /provider/.test(J(r).error), 'link without provider → 400: ' + r.body);
r = await app.inject({method: 'POST', url: `/api/projects/${fresh}/remote/link`, payload: {provider: 'nope'}});
check(r.statusCode === 400, 'link with unknown provider → 400: ' + r.body);
r = await app.inject({method: 'POST', url: `/api/projects/${fresh}/remote/link`, payload: {provider: 'gitlab', name: 'New Paper', namespace: 'grp/sub'}});
check(r.statusCode === 200 && J(r).ok === true, 'link → ' + r.body);
check(J(r).remote?.provider === 'gitlab' && J(r).remote?.fullName === 'grp/sub/new-paper' && J(r).remote?.owner === 'grp/sub', 'link response: ' + r.body);
check(!('github' in J(r)), 'link response has no github field for gitlab');
const created = recorded.created.at(-1);
check(created?.namespace_id === 42 && created?.path === 'new-paper' && created?.visibility === 'private' && created?.initialize_with_readme === false, 'POST /projects body: ' + JSON.stringify(created));
const freshBare = glProjects.get('grp/sub/new-paper').bare;
check(refs(freshBare).includes('main') && sh(`git --git-dir="${freshBare}" show main:main.tex`).includes('documentclass'), 'first push landed in the created repo');
r = await app.inject({method: 'POST', url: `/api/projects/${fresh}/remote/link`, payload: {provider: 'gitlab', name: 'Again'}});
check(r.statusCode === 400 && /already linked/.test(J(r).error), 'link twice → 400: ' + r.body);
r = await app.inject({url: `/api/projects/${fresh}/remote/status`});
check(r.statusCode === 200 && J(r).provider === 'gitlab' && J(r).ahead === 0 && J(r).behind === 0, 'published project in sync: ' + r.body);
r = await app.inject({url: '/api/remotes/gitlab/repos'});
check(J(r).some((p) => p.fullName === 'grp/sub/new-paper'), 'created project is listed');

// ---------- disconnect, revoked token ----------
r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/disconnect'});
check(r.statusCode === 200 && J(r).ok === true, 'disconnect');
r = await app.inject({url: '/api/remotes/gitlab/status'});
check(J(r).connected === false, 'disconnected');
r = await app.inject({url: `/api/projects/${pid}/remote/status`});
check(r.statusCode === 400 && /Connect GitLab/.test(J(r).error), 'sync without a gitlab connection → 400: ' + r.body);

r = await app.inject({method: 'POST', url: '/api/remotes/gitlab/connect', payload: {token: 'later-revoked'}});
check(r.statusCode === 200 && J(r).baseUrl === undefined, 'connect without baseUrl (gitlab.com) ' + r.body);
revoked.add('later-revoked');
r = await app.inject({url: '/api/remotes/gitlab/repos'});
check(r.statusCode === 401 && J(r).reason === 'token-invalid', 'revoked token → 401 token-invalid: ' + r.body);
r = await app.inject({url: `/api/projects/${pid}/remote/branches`});
check(r.statusCode === 401 && J(r).reason === 'token-invalid', 'branches with a revoked token → 401 token-invalid: ' + r.body);

// ---------- allowlist: a disabled provider is unknown to the routes ----------
process.env.REMOTE_PROVIDERS = 'github';
r = await app.inject({url: '/api/remotes'});
check(J(r).length === 1 && J(r)[0].id === 'github', 'REMOTE_PROVIDERS=github lists only github: ' + r.body);
r = await app.inject({url: '/api/remotes/gitlab/status'});
check(r.statusCode === 404, 'disabled provider → 404');
r = await app.inject({url: `/api/projects/${pid}/remote/status`});
check(r.statusCode === 400 && /disabled/.test(J(r).error), 'a project linked to a disabled provider says so: ' + r.body);
delete process.env.REMOTE_PROVIDERS;

glMock.close(); ghMock.close(); await app.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log('GitLab integration (connect→import→push→pull→conflict→branches→MR→link→legacy shim→aliases): ALL PASSED');
