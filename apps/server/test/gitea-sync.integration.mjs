/**
 * Gitea/Forgejo as a remote provider, end to end over the routes: PAT connect
 * (the instance URL is mandatory), import, push/pull/conflict, branches and a
 * pull request, publish (`link`) under the user and into an organisation,
 * page walking against a small MAX_RESPONSE_ITEMS (with and without
 * X-Total-Count, and past the page cap), the link's instance against
 * connections to other instances, the token-invalid path and the
 * REMOTE_PROVIDERS allowlist.
 *
 * One bare repo stands in for the host (clone_url is `file://<bare>`); the
 * `node:http` mock from ./mock-gitea-api.mjs answers the REST calls behind
 * GITEA_API_BASE, which must be set before the routes are imported.
 */
import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execSync } from 'node:child_process';
import { startGiteaMock, refs, show } from './mock-gitea-api.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-gt-'));
process.env.DATA_DIR = path.join(tmp, 'data'); process.env.META_DIR = path.join(tmp, 'secrets');
delete process.env.REMOTE_PROVIDERS;

function seedBare(name, content) {
  const bare = path.join(tmp, `${name}.git`); execSync(`git init -q --bare -b main "${bare}"`);
  const seed = path.join(tmp, `${name}-seed`); execSync(`git clone -q "${bare}" "${seed}" 2>/dev/null`);
  fs.writeFileSync(path.join(seed, 'main.tex'), content);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`);
  execSync(`cd "${seed}" && git add -A && git -c user.email=a@b.c -c user.name=t commit -q -m init && git push -q origin main`);
  return { bare, seed };
}
const gt = seedBare('paper', '\\documentclass{article}\\begin{document}From Forgejo\\end{document}\n');

const mock = await startGiteaMock({ tmp });
mock.addRepo('tester/paper', gt.bare);
mock.revoked.add('bad');
process.env.GITEA_API_BASE = mock.url;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const remotes = await import('../src/remotes.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };
const projectDir = (id) => path.join(process.env.DATA_DIR, 'projects', id);

// ---------- account level ----------
let r = await app.inject({url: '/api/remotes'});
const listed = J(r);
check(r.statusCode === 200 && listed.map((p) => p.id).sort().join() === 'gitea,github,gitlab', 'all three providers listed: ' + r.body);
const gitea = listed.find((p) => p.id === 'gitea');
check(gitea.label === 'Gitea / Forgejo' && gitea.changeRequestLabel === 'pull request', 'gitea label and noun: ' + JSON.stringify(gitea));
check(gitea.selfHosted === true && gitea.baseUrlRequired === true && gitea.oauth === false, 'gitea is self-hosted, needs a URL, has no OAuth: ' + JSON.stringify(gitea));
check(listed.find((p) => p.id === 'gitlab').baseUrlRequired === false && listed.find((p) => p.id === 'github').baseUrlRequired === false, 'the other two do not require a URL');

r = await app.inject({url: '/api/remotes/gitea/status'});
check(r.statusCode === 200 && J(r).connected === false && J(r).baseUrlRequired === true, 'gitea not connected yet, status says a URL is required: ' + r.body);
r = await app.inject({url: '/api/remotes/gitea/oauth'});
check(r.statusCode === 400 || r.statusCode === 404, 'no OAuth start for gitea (got ' + r.statusCode + ')');

// the instance URL is mandatory: no default host exists
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/connect', payload: {token: 'good'}});
check(r.statusCode === 400 && /instance URL is required/.test(J(r).error) && /codeberg\.org/.test(J(r).error), 'connect without baseUrl → 400 naming Codeberg: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/connect', payload: {token: 'good', baseUrl: 'not a url'}});
check(r.statusCode === 400 && /Gitea \/ Forgejo URL must be a full https/.test(J(r).error), 'malformed baseUrl → 400: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/connect', payload: {token: 'good', baseUrl: 'https://codeberg.org/?x=1'}});
check(r.statusCode === 400 && /query/.test(J(r).error), 'baseUrl with query → 400: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/connect', payload: {token: 'bad', baseUrl: 'https://codeberg.org'}});
check(r.statusCode === 400 && /rejected/.test(J(r).error) && /read:user and write:repository/.test(J(r).error), 'bad token → 400 naming the scopes: ' + r.body);
r = await app.inject({url: '/api/remotes/gitea/status'});
check(J(r).connected === false, 'a rejected token stores no connection');

// the swagger page's URL, API suffix included, is what users copy: the suffix is dropped, not doubled
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/connect', payload: {token: 'good', baseUrl: 'https://forge.example.org/git/api/v1/'}});
check(r.statusCode === 200 && J(r).baseUrl === 'https://forge.example.org/git', 'connect with a /api/v1 suffix stores the instance without it: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/connect', payload: {token: 'good', baseUrl: 'https://forge.example.org/git/'}});
check(r.statusCode === 200 && J(r).login === 'tester' && J(r).baseUrl === 'https://forge.example.org/git', 'PAT connect with sub-path base: ' + r.body);
r = await app.inject({url: '/api/remotes/gitea/status'});
check(J(r).connected === true && J(r).login === 'tester' && J(r).baseUrl === 'https://forge.example.org/git', 'status shows normalised baseUrl: ' + r.body);
check(mock.recorded.requests.includes('GET /user'), 'whoami hit GET /user with the token header');

r = await app.inject({url: '/api/remotes/gitea/repos'});
check(r.statusCode === 200 && Array.isArray(J(r)) && J(r).length === 1 && J(r)[0].fullName === 'tester/paper', 'repos list: ' + r.body);
check(J(r)[0].owner === 'tester' && J(r)[0].name === 'paper' && J(r)[0].private === true && J(r)[0].defaultBranch === 'main' && J(r)[0].cloneUrl === `file://${gt.bare}`, 'repo mapped from the v1 shape: ' + r.body);

// ---------- page walk: a small MAX_RESPONSE_ITEMS must not truncate the list ----------
mock.addRepo('tester/older', gt.bare, { updatedAt: '2025-01-01T00:00:00Z' });
mock.addRepo('research/shared', gt.bare, { updatedAt: '2026-03-03T00:00:00Z' });
mock.flags.maxItems = 2;
mock.recorded.requests.length = 0;
r = await app.inject({url: '/api/remotes/gitea/repos'});
check(r.statusCode === 200 && J(r).length === 3, 'all three repos across pages: ' + r.body);
check(J(r).map((x) => x.fullName).join() === 'research/shared,tester/paper,tester/older', 'most recently updated first: ' + J(r).map((x) => x.fullName).join());
let pages = mock.recorded.requests.filter((x) => x.startsWith('GET /user/repos'));
check(pages.length === 2 && pages[0] === 'GET /user/repos?page=1&limit=50' && pages[1] === 'GET /user/repos?page=2&limit=50', 'X-Total-Count ends the walk once every entry is in hand: ' + pages.join(' | '));
mock.flags.totalCount = false;
mock.recorded.requests.length = 0;
r = await app.inject({url: '/api/remotes/gitea/repos'});
check(r.statusCode === 200 && J(r).length === 3, 'all three repos without the count header: ' + r.body);
pages = mock.recorded.requests.filter((x) => x.startsWith('GET /user/repos'));
check(pages.length === 3 && pages[2] === 'GET /user/repos?page=3&limit=50', 'without the header only an empty page ends the walk: ' + pages.join(' | '));
mock.flags.totalCount = true;
// more pages than the walk allows is an error, never a list that looks complete
mock.flags.maxItems = 1;
for (let i = 0; i < 40; i++) mock.addRepo(`tester/filler-${i}`, gt.bare);
r = await app.inject({url: '/api/remotes/gitea/repos'});
check(r.statusCode === 502 && /lists 43 entries/.test(J(r).error), 'past the page cap → 502 naming the count: ' + r.body);
for (let i = 0; i < 40; i++) mock.repos.delete(`tester/filler-${i}`);
mock.flags.maxItems = 50;

// ---------- import ----------
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/import', payload: {fullName: 'nope'}});
check(r.statusCode === 400 && /owner\/repo/.test(J(r).error), 'import without a slash → 400 asking for owner/repo: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/import', payload: {fullName: 'tester/missing'}});
check(r.statusCode === 400 && /not found/.test(J(r).error), 'import of an unknown repo → 400: ' + r.body);
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/import', payload: {fullName: 'a/b/c'}});
check(r.statusCode === 400 && /owner\/repo/.test(J(r).error), 'a three-segment path never reaches the network: ' + r.body);

r = await app.inject({method: 'POST', url: '/api/remotes/gitea/import', payload: {fullName: 'tester/paper'}});
check(r.statusCode === 200, 'import status ' + r.body);
const pid = J(r).id; check(pid, 'got project id');
check(J(r).remote?.provider === 'gitea' && J(r).remote?.fullName === 'tester/paper', 'summary carries the gitea link: ' + r.body);
check(J(r).remote?.owner === 'tester' && J(r).remote?.repo === 'paper' && J(r).remote?.remoteBranch === 'main', 'link fields: ' + JSON.stringify(J(r).remote));
check(J(r).remote?.baseUrl === 'https://forge.example.org/git', 'the link records the instance it was imported from: ' + JSON.stringify(J(r).remote));
check(!('github' in J(r)) || J(r).github == null, 'no legacy github field for a gitea link: ' + r.body);
check(fs.readFileSync(path.join(projectDir(pid), 'main.tex'), 'utf8').includes('From Forgejo'), 'imported the repository content');
check((await store.readMeta(pid)).remote?.provider === 'gitea', 'stored meta names the provider');

// ---------- push / pull / conflict ----------
fs.writeFileSync(path.join(projectDir(pid), 'main.tex'), '\\documentclass{article}\\begin{document}EDITED IN ALDINE\\end{document}\n');
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/push`});
check(r.statusCode === 200, 'push status ' + r.body);
check(show(gt.bare, 'main:main.tex').includes('EDITED IN ALDINE'), 'push reached the bare repo');

execSync(`cd "${gt.seed}" && git pull -q && printf 'EXTERNAL\\n' >> main.tex && git -c user.email=a@b.c -c user.name=t commit -qam ext && git push -q`);
r = await app.inject({url: `/api/projects/${pid}/remote/status`});
check(r.statusCode === 200 && J(r).linked === true && J(r).provider === 'gitea' && J(r).behind === 1, 'behind 1 after external push: ' + r.body);
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/pull`});
check(r.statusCode === 200, 'pull ok ' + r.body);
check(fs.readFileSync(path.join(projectDir(pid), 'main.tex'), 'utf8').includes('EXTERNAL'), 'pulled external change');

execSync(`cd "${gt.seed}" && git pull -q && printf 'REMOTE VERSION\\n' > main.tex && git -c user.email=a@b.c -c user.name=t commit -qam remoteedit && git push -q`);
fs.writeFileSync(path.join(projectDir(pid), 'main.tex'), 'LOCAL VERSION\n');
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/pull`});
check(r.statusCode === 409 && Array.isArray(J(r).conflicts) && J(r).conflicts.includes('main.tex'), 'pull conflicts with 409 listing main.tex: ' + r.body);
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/reset-to-remote`});
check(r.statusCode === 200 && fs.readFileSync(path.join(projectDir(pid), 'main.tex'), 'utf8').trim() === 'REMOTE VERSION', 'reset-to-remote took the remote version');

// ---------- branches + pull request ----------
r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/change-request`, payload: {title: 'Too early'}});
check(r.statusCode === 400 && /default branch/.test(J(r).error), 'PR from the default branch → 400: ' + r.body);

r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/create-branch`, payload: {name: 'feature-y'}});
check(r.statusCode === 200 && J(r).branch === 'feature-y', 'create-branch ' + r.body);
check(refs(gt.bare).includes('feature-y'), 'bare repo has feature-y');
r = await app.inject({url: `/api/projects/${pid}/remote/branches`});
check(J(r).current === 'feature-y' && J(r).default === 'main' && J(r).branches.includes('main') && J(r).branches.includes('feature-y'), 'branches list + current: ' + r.body);

r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/change-request`, payload: {title: 'My PR'}});
check(r.statusCode === 200 && J(r).number === 1 && J(r).url === 'https://forge.example.org/tester/paper/pulls/1', 'PR opened: ' + r.body);
const pull = mock.recorded.pulls.at(-1);
check(pull?.head === 'feature-y' && pull?.base === 'main' && pull?.title === 'My PR' && pull?.body === '', 'PR body uses CreatePullRequestOption names: ' + JSON.stringify(pull));

r = await app.inject({method: 'POST', url: `/api/projects/${pid}/remote/switch-branch`, payload: {branch: 'main'}});
check(r.statusCode === 200 && J(r).branch === 'main', 'switch back to main ' + r.body);

// ---------- publish under the user, then into an organisation ----------
r = await app.inject({method: 'POST', url: '/api/projects', payload: {name: 'New Paper'}});
const fresh = J(r).id;
check((r.statusCode === 200 || r.statusCode === 201) && J(r).remote === null, 'fresh project has no link: ' + r.body);
r = await app.inject({method: 'POST', url: `/api/projects/${fresh}/remote/link`, payload: {provider: 'gitea', name: 'New Paper'}});
check(r.statusCode === 200 && J(r).ok === true, 'link → ' + r.body);
check(J(r).remote?.provider === 'gitea' && J(r).remote?.fullName === 'tester/New-Paper' && J(r).remote?.owner === 'tester', 'link response: ' + r.body);
check(J(r).remote?.baseUrl === 'https://forge.example.org/git', 'a published link records the instance too: ' + JSON.stringify(J(r).remote));
let created = mock.recorded.created.at(-1);
check(created?.owner === 'tester' && created?.name === 'New-Paper' && created?.private === true && created?.auto_init === false, 'POST /user/repos body: ' + JSON.stringify(created));
let bare = mock.repos.get('tester/New-Paper').bare;
check(refs(bare).includes('main') && show(bare, 'main:main.tex').includes('documentclass'), 'first push landed in the created repo');
r = await app.inject({method: 'POST', url: `/api/projects/${fresh}/remote/link`, payload: {provider: 'gitea', name: 'Again'}});
check(r.statusCode === 400 && /already linked/.test(J(r).error), 'link twice → 400: ' + r.body);
r = await app.inject({url: `/api/projects/${fresh}/remote/status`});
check(r.statusCode === 200 && J(r).provider === 'gitea' && J(r).ahead === 0 && J(r).behind === 0, 'published project in sync: ' + r.body);

r = await app.inject({method: 'POST', url: '/api/projects', payload: {name: 'Org Paper'}});
const orgProject = J(r).id;
r = await app.inject({method: 'POST', url: `/api/projects/${orgProject}/remote/link`, payload: {provider: 'gitea', name: 'org-paper', private: false, namespace: 'nobody'}});
check(r.statusCode === 400 && /Could not create the repository/.test(J(r).error) && /404/.test(J(r).error), 'unknown organisation → 400 with the host status: ' + r.body);
r = await app.inject({method: 'POST', url: `/api/projects/${orgProject}/remote/link`, payload: {provider: 'gitea', name: 'org-paper', private: false, namespace: 'research'}});
check(r.statusCode === 200 && J(r).remote?.fullName === 'research/org-paper' && J(r).remote?.owner === 'research', 'link into an organisation: ' + r.body);
created = mock.recorded.created.at(-1);
check(created?.owner === 'research' && created?.private === false, 'POST /orgs/research/repos body: ' + JSON.stringify(created));
bare = mock.repos.get('research/org-paper').bare;
check(refs(bare).includes('main'), 'first push landed in the organisation repo');
r = await app.inject({url: '/api/remotes/gitea/repos'});
check(J(r).some((p) => p.fullName === 'research/org-paper') && J(r).some((p) => p.fullName === 'tester/New-Paper'), 'created repos are listed');
r = await app.inject({method: 'POST', url: `/api/projects/${orgProject}/remote/link`, payload: {provider: 'gitea', name: 'org-paper', namespace: 'research'}});
check(r.statusCode === 400, 'a second link on the same project is refused');

// ---------- disconnect, revoked token ----------
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/disconnect'});
check(r.statusCode === 200 && J(r).ok === true, 'disconnect');
r = await app.inject({url: '/api/remotes/gitea/status'});
check(J(r).connected === false, 'disconnected');
r = await app.inject({url: `/api/projects/${pid}/remote/status`});
check(r.statusCode === 400 && /Connect Gitea \/ Forgejo/.test(J(r).error), 'sync without a gitea connection → 400: ' + r.body);

// ---------- a connection to another instance never serves the link ----------
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/connect', payload: {token: 'elsewhere', baseUrl: 'https://codeberg.org'}});
check(r.statusCode === 200 && J(r).baseUrl === 'https://codeberg.org', 'reconnect on codeberg.org ' + r.body);
r = await app.inject({url: `/api/projects/${pid}/remote/status`});
check(r.statusCode === 400 && /Connect Gitea \/ Forgejo on https:\/\/forge\.example\.org\/git to sync/.test(J(r).error), 'a codeberg connection does not sync a forge.example.org link, and the 400 names the instance: ' + r.body);
{
  // two users: B, connected to another instance, opens A's project → A's connection is used, never B's
  const link = store.remoteLink(await store.readMeta(pid));
  check(link.connectedBy === 'local' && link.baseUrl === 'https://forge.example.org/git', 'link made by "local" on forge.example.org: ' + JSON.stringify(link));
  await remotes.setConnection('local', 'gitea', { token: 'a-token', login: 'tester', baseUrl: 'https://forge.example.org/git' });
  await remotes.setConnection('b', 'gitea', { token: 'b-codeberg', login: 'bee', baseUrl: 'https://codeberg.org' });
  let conn = await remotes.resolveConnection(link, 'b', { allowService: true });
  check(conn?.token === 'a-token', 'B on codeberg.org falls through to the linker\'s forge.example.org connection: ' + JSON.stringify(conn));
  await remotes.setConnection('b', 'gitea', { token: 'b-forge', login: 'bee', baseUrl: 'https://forge.example.org/other-path' });
  conn = await remotes.resolveConnection(link, 'b', { allowService: true });
  check(conn?.token === 'b-forge', 'B on the same origin (any path) uses B\'s own connection: ' + JSON.stringify(conn));
  await remotes.setConnection('b', 'gitea', { token: 'b-codeberg', login: 'bee', baseUrl: 'https://codeberg.org' });
  await remotes.disconnect('local', 'gitea');
  conn = await remotes.resolveConnection(link, 'b', { allowService: true });
  check(conn === null, 'no connection on the link\'s instance → none, B\'s codeberg connection is not used: ' + JSON.stringify(conn));
  const legacy = { ...link, baseUrl: undefined };
  conn = await remotes.resolveConnection(legacy, 'b', { allowService: true });
  check(conn?.token === 'b-codeberg', 'a link from before the field with a non-http clone URL accepts any connection: ' + JSON.stringify(conn));
  const legacyHttps = { ...legacy, cloneUrl: 'https://forge.example.org/git/tester/paper.git' };
  conn = await remotes.resolveConnection(legacyHttps, 'b', { allowService: true });
  check(conn === null, 'a link from before the field is matched by its clone URL origin: ' + JSON.stringify(conn));
  await remotes.disconnect('b', 'gitea');
}
r = await app.inject({method: 'POST', url: '/api/remotes/gitea/connect', payload: {token: 'later-revoked', baseUrl: 'https://forge.example.org/git'}});
check(r.statusCode === 200, 'reconnect on the link\'s instance ' + r.body);
mock.revoked.add('later-revoked');
r = await app.inject({url: '/api/remotes/gitea/repos'});
check(r.statusCode === 401 && J(r).reason === 'token-invalid' && /Gitea \/ Forgejo rejected/.test(J(r).error), 'revoked token → 401 token-invalid: ' + r.body);
r = await app.inject({url: `/api/projects/${pid}/remote/branches`});
check(r.statusCode === 401 && J(r).reason === 'token-invalid', 'branches with a revoked token → 401 token-invalid: ' + r.body);

// ---------- allowlist: a disabled provider is unknown to the routes ----------
process.env.REMOTE_PROVIDERS = 'github,gitlab';
r = await app.inject({url: '/api/remotes'});
check(J(r).map((p) => p.id).join() === 'github,gitlab', 'REMOTE_PROVIDERS=github,gitlab hides gitea: ' + r.body);
r = await app.inject({url: '/api/remotes/gitea/status'});
check(r.statusCode === 404, 'disabled provider → 404');
r = await app.inject({url: `/api/projects/${pid}/remote/status`});
check(r.statusCode === 400 && /disabled/.test(J(r).error), 'a project linked to a disabled provider says so: ' + r.body);
process.env.REMOTE_PROVIDERS = 'gitea';
r = await app.inject({url: '/api/remotes'});
check(J(r).length === 1 && J(r)[0].id === 'gitea', 'REMOTE_PROVIDERS=gitea lists only gitea: ' + r.body);
delete process.env.REMOTE_PROVIDERS;

await mock.close(); await app.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log('Gitea integration (connect→import→push→pull→conflict→branches→PR→link→org→instance→revoked→allowlist): ALL PASSED');
