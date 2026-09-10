/**
 * Template repositories (#50):
 *  - TEMPLATE_REPOS is parsed once; a duplicate id or a non-https URL is
 *    skipped with a warning, the rest keep their defaults
 *  - a checkout lists every folder with a manifest, hidden folders and
 *    manifest-less folders excluded, ids `repo:<id>/<folder>`
 *  - the seed is byte-exact for a binary, template.json and LICENSE stay
 *    behind, placeholders are substituted in text (LaTeX-escaped in .tex,
 *    verbatim elsewhere), unknown tokens are left alone
 *  - a new commit shows up after a refresh, not before
 *  - an unreachable remote leaves the previous checkout listed and reports the
 *    error; an oversized checkout is refused and removed
 *  - the checkout's origin carries no credentials
 *  - a traversing id is refused by the loader and by the route, leaving no
 *    project behind
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-template-repos-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.VENUES_FILE = path.join(tmp, 'venues.json');
// file:// repository URLs are only accepted under the test hook.
process.env.ALDINE_TEST_HOOKS = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.TEMPLATE_REPOS_FILE;
delete process.env.TEMPLATE_REPO_MAX_BYTES;
delete process.env.TEMPLATE_REPOS_REFRESH_MS;

fs.mkdirSync(process.env.TEMPLATES_DIR, { recursive: true });
fs.writeFileSync(process.env.VENUES_FILE, JSON.stringify({ venues: [] }));
// No compiler in this test: the venue half of the gallery is empty.
globalThis.fetch = async () => { throw new Error('connection refused'); };

// ---- a bare repository laid out like templates/ ----
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
const bare = path.join(tmp, 'templates.git');
const work = path.join(tmp, 'work');
fs.mkdirSync(bare);
git(bare, 'init', '--bare', '-q', '-b', 'main');
git(tmp, 'clone', '-q', bare, work);
git(work, 'config', 'user.email', 'test@example.com');
git(work, 'config', 'user.name', 'Test');

// Every byte value: UTF-8 decoding would turn the invalid sequences into U+FFFD.
const LOGO = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const MAIN_TEX = '\\documentclass{article}\n\\title{{{PROJECT_NAME}}}\n\\author{{{AUTHOR}}}\n\\date{{{DATE}}}\n% (c) {{YEAR}} {{UNKNOWN}}\n\\begin{document}\\maketitle\\end{document}\n';
const write = (rel, content) => {
  const abs = path.join(work, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
write('thesis/template.json', JSON.stringify({ name: 'Thesis', category: 'Theses' }));
write('thesis/main.tex', MAIN_TEX);
write('thesis/logo.png', LOGO);
write('thesis/LICENSE', 'MIT License\n');
write('poster/template.json', '{}');
write('poster/poster.tex', '\\documentclass{beamer}\n');
write('nomanifest/readme.txt', 'not a template\n');
write('.hidden/template.json', JSON.stringify({ name: 'Hidden' }));
write('.hidden/main.tex', '\\documentclass{article}\n');
git(work, 'add', '-A');
git(work, 'commit', '-q', '-m', 'templates');
git(work, 'push', '-q', 'origin', 'main');
const bareUrl = pathToFileURL(bare).href;

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };

const REPOS = [
  { id: 'lab', label: 'Lab Templates', url: bareUrl },
  { id: 'dup', url: bareUrl },
  { id: 'dup', url: bareUrl },
  { id: 'plain', url: 'http://example.com/x.git' },
];
process.env.TEMPLATE_REPOS = JSON.stringify(REPOS);

const repos = await import('../src/templaterepos.ts');
const { listAllTemplates, resolveTemplateSeed, templateFiles } = await import('../src/templates.ts');
const gitops = await import('../src/gitops.ts');

// ---- 1. configuration ----
const entries = repos.loadTemplateRepos();
eq(entries.map((e) => e.id), ['lab', 'dup'], 'the second "dup" and the plain-http entry are skipped');
check(warnings.some((w) => w.includes('TEMPLATE_REPOS entry skipped') && w.includes('duplicate id "dup"')), `the duplicate id is warned about: ${JSON.stringify(warnings)}`);
check(warnings.some((w) => w.includes('TEMPLATE_REPOS entry skipped') && w.includes('"plain"') && w.includes('https://')), `the non-https URL is warned about: ${JSON.stringify(warnings)}`);
eq(entries[0].label, 'Lab Templates', 'a label is kept');
eq(entries[1].label, 'dup', 'the label defaults to the id');
eq(entries.map((e) => e.ref), ['HEAD', 'HEAD'], 'the ref defaults to HEAD');
eq(entries.map((e) => e.user), ['oauth2', 'oauth2'], 'the token user defaults to oauth2');
eq(entries.map((e) => e.path), ['', ''], 'the path defaults to the repository root');
check(repos.loadTemplateRepos() === entries, 'the list is parsed once');

// ---- 2. first sync and listing ----
eq(repos.listRepoTemplates(), [], 'nothing is listed before the first sync');
const synced = await repos.syncAllTemplateRepos();
eq(synced.map((s) => [s.id, s.ok, s.available]), [['lab', true, true], ['dup', true, true]], 'both repositories sync');
check(synced.every((s) => /^[0-9a-f]{40}$/.test(s.head)), `head is a commit sha: ${JSON.stringify(synced)}`);
check(synced.every((s) => !s.error && !Number.isNaN(Date.parse(s.syncedAt))), 'a good sync has a syncedAt and no error');
const firstHead = synced[0].head;

const listed = repos.listRepoTemplates();
eq(listed.map((t) => t.id).sort(), ['repo:dup/poster', 'repo:dup/thesis', 'repo:lab/poster', 'repo:lab/thesis'], 'every folder with a manifest is listed, hidden and manifest-less folders are not');
const thesis = listed.find((t) => t.id === 'repo:lab/thesis');
eq(thesis.source, { kind: 'repo', label: 'Lab Templates' }, 'a repo template names its repository');
eq(thesis.name, 'Thesis', 'the manifest name reaches the gallery');
eq(thesis.category, 'Theses', 'the manifest category is kept');
const poster = listed.find((t) => t.id === 'repo:dup/poster');
eq(poster.source, { kind: 'repo', label: 'dup' }, 'the default label is the id');
eq(poster.name, 'poster', 'an empty manifest falls back to the folder name');
eq(poster.category, 'General', 'and to General');

const all = await listAllTemplates();
eq(all[0].id, 'blank', 'the blank tile still leads');
eq(all.slice(1).map((t) => t.id).sort(), ['repo:dup/poster', 'repo:dup/thesis', 'repo:lab/poster', 'repo:lab/thesis'], 'the gallery lists the repo templates after the folder templates');

// ---- 3. seed files and placeholders ----
const ctx = { projectName: 'My & Paper', author: 'Ada', now: new Date('2026-09-10T12:00:00Z') };
const seed = await resolveTemplateSeed('repo:lab/thesis', ctx);
eq(Object.keys(seed.files).sort(), ['logo.png', 'main.tex'], 'template.json and LICENSE are not seeded');
check(seed.files['logo.png'].equals(LOGO), 'the logo is byte-identical to the source');
const tex = seed.files['main.tex'].toString('utf8');
check(tex.includes('\\title{My \\& Paper}'), `the project name is LaTeX-escaped in .tex: ${tex}`);
check(tex.includes('\\author{Ada}'), 'the author is substituted');
check(tex.includes('\\date{2026-09-10}'), 'the date is YYYY-MM-DD');
check(tex.includes('(c) 2026 '), 'the year is substituted');
check(tex.includes('{{UNKNOWN}}'), 'an unknown token is left alone');
check(!tex.includes('{{PROJECT_NAME}}') && !tex.includes('{{AUTHOR}}') && !tex.includes('{{DATE}}') && !tex.includes('{{YEAR}}'), 'no known token survives');

// ---- 4. placeholders apply to folder templates too, verbatim outside .tex ----
const local = path.join(process.env.TEMPLATES_DIR, 'local');
fs.mkdirSync(local, { recursive: true });
fs.writeFileSync(path.join(local, 'template.json'), JSON.stringify({ name: 'Local' }));
fs.writeFileSync(path.join(local, 'notes.md'), '# {{PROJECT_NAME}}\nby {{AUTHOR}}, {{DATE}}\n');
fs.writeFileSync(path.join(local, 'main.tex'), '\\title{{{PROJECT_NAME}}}\n');
fs.writeFileSync(path.join(local, 'logo.png'), Buffer.concat([Buffer.from('{{PROJECT_NAME}}'), LOGO]));
const builtin = await resolveTemplateSeed('local', ctx);
eq(builtin.files['notes.md'].toString('utf8'), '# My & Paper\nby Ada, 2026-09-10\n', 'a Markdown file gets the value verbatim');
eq(builtin.files['main.tex'].toString('utf8'), '\\title{My \\& Paper}\n', 'the same template escapes it in .tex');
check(builtin.files['logo.png'].equals(Buffer.concat([Buffer.from('{{PROJECT_NAME}}'), LOGO])), 'a binary is never rewritten, even when it happens to contain a token');
eq((await listAllTemplates()).map((t) => t.id).slice(0, 2), ['blank', 'local'], 'folder templates come before the repo ones');

// ---- 5. a new commit appears after a refresh ----
write('report/template.json', JSON.stringify({ name: 'Report' }));
write('report/main.tex', '\\documentclass{report}\n');
git(work, 'add', '-A');
git(work, 'commit', '-q', '-m', 'add report');
git(work, 'push', '-q', 'origin', 'main');
const newHead = git(work, 'rev-parse', 'HEAD');
check(newHead !== firstHead, 'the fixture repository moved');
check(!repos.listRepoTemplates().some((t) => t.id === 'repo:lab/report'), 'the new folder is not listed before a refresh');
eq(repos.templateRepoStates().find((s) => s.id === 'lab').head, firstHead, 'the state still shows the old head');
const refreshed = await repos.syncTemplateRepo(entries[0]);
eq([refreshed.ok, refreshed.head], [true, newHead], 'the refresh fast-forwards to the new commit');
check(repos.listRepoTemplates().some((t) => t.id === 'repo:lab/report'), 'the new folder is listed after the refresh');
check(!repos.listRepoTemplates().some((t) => t.id === 'repo:dup/report'), 'a repository that was not refreshed keeps its old listing');
eq(repos.templateRepoStates().find((s) => s.id === 'lab').head, newHead, 'templateRepoStates shows the new head');
eq(repos.templateRepoStates().find((s) => s.id === 'dup').head, firstHead, 'and the old one for the other repository');

// ---- 6. an unreachable remote is stale, not gone ----
const before = repos.listRepoTemplates().map((t) => t.id).sort();
fs.renameSync(bare, `${bare}.away`);
const failed = await repos.syncTemplateRepo(entries[0]);
eq([failed.ok, failed.available], [false, true], 'a failed refresh keeps the checkout available');
check(typeof failed.error === 'string' && failed.error.length > 0, 'the error says why');
eq(failed.head, newHead, 'the head of the last good sync is kept');
eq(repos.listRepoTemplates().map((t) => t.id).sort(), before, 'the previous checkout is still listed');
check(warnings.some((w) => w.includes('repository "lab" could not be refreshed') && w.includes('serving the previous checkout')), 'the failure is logged as stale');
const failedAgain = await repos.syncTemplateRepo(entries[0]);
eq(failedAgain.ok, false, 'still failing while the remote is away');
eq(warnings.filter((w) => w.includes('repository "lab" could not be refreshed')).length, 1, 'a failure streak is logged once, not per attempt');
fs.renameSync(`${bare}.away`, bare);
const recovered = await repos.syncTemplateRepo(entries[0]);
eq([recovered.ok, recovered.available, recovered.head, recovered.error], [true, true, newHead, undefined], 'the repository recovers once the remote is back');

// ---- 7. no credentials at rest ----
const checkout = path.join(process.env.CACHE_DIR, 'template-repos', 'lab');
eq(git(checkout, 'remote', 'get-url', 'origin'), bareUrl, 'origin is the plain URL');
eq(gitops.injectToken('https://host/x.git', 'oauth2', 's3cr3t'), 'https://oauth2:s3cr3t@host/x.git', 'the token goes into the URL for one operation');
eq(gitops.injectToken('https://old:creds@host/x.git', 'x-access-token', 't'), 'https://x-access-token:t@host/x.git', 'stale credentials in the configured URL are replaced');
eq(gitops.injectToken(bareUrl, 'oauth2', 's3cr3t'), bareUrl, 'a non-http URL passes through untouched');
eq(gitops.stripCreds('https://oauth2:s3cr3t@host/x.git'), 'https://host/x.git', 'stripCreds undoes it');
check(!fs.readFileSync(path.join(checkout, '.git', 'config'), 'utf8').includes('@'), 'the checkout\u2019s git config holds no user:token');

// ---- 8. an oversized checkout is refused ----
repos.resetTemplateRepos();
process.env.TEMPLATE_REPOS = JSON.stringify([{ id: 'big', url: bareUrl }]);
process.env.TEMPLATE_REPO_MAX_BYTES = '10';
const [big] = await repos.syncAllTemplateRepos();
eq([big.id, big.ok, big.available], ['big', false, false], 'an oversized checkout is refused and nothing is available');
check(big.error.includes('TEMPLATE_REPO_MAX_BYTES'), `the error names the limit: ${big.error}`);
check(!fs.existsSync(path.join(process.env.CACHE_DIR, 'template-repos', 'big')), 'the oversized checkout is removed');
eq(repos.listRepoTemplates(), [], 'a refused repository lists nothing');
delete process.env.TEMPLATE_REPO_MAX_BYTES;
check(repos.maxCheckoutBytes() === 50 * 1024 * 1024, 'the limit falls back to 50 MiB');

// ---- 9. traversal, by the loader and through the route ----
repos.resetTemplateRepos();
process.env.TEMPLATE_REPOS = JSON.stringify(REPOS);
eq(repos.loadTemplateRepos().map((e) => e.id), ['lab', 'dup'], 'the original configuration is back');
eq(repos.templateRepoStates().map((s) => [s.id, s.ok, s.available]), [['lab', false, true], ['dup', false, true]], 'an existing checkout is available before the first sync of this process');

await throws(async () => templateFiles('repo:lab/../thesis'), 'bad template id', 'a traversing folder is refused');
await throws(async () => templateFiles('repo:lab/.git'), 'bad template id', 'the .git directory is not a template');
await throws(async () => templateFiles('repo:lab/thesis/main.tex'), 'bad template id', 'a nested path is refused');
await throws(async () => templateFiles('repo:lab/nomanifest'), 'unknown template', 'a folder without a manifest is not a template');
await throws(async () => templateFiles('repo:nope/thesis'), 'unknown template repository', 'an unknown repository is refused');
await throws(async () => templateFiles('repo:lab'), 'bad template id', 'a repository alone is not a template');
await throws(async () => repos.templateRepoDir('../x'), 'bad template repo id', 'the checkout dir never leaves CACHE_DIR/template-repos');

const { default: Fastify } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');
await initDb();
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const projectsDir = path.join(process.env.DATA_DIR, 'projects');
const projectCount = () => fs.readdirSync(projectsDir).length;
const countBefore = projectCount();
const traversing = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'X', template: 'repo:lab/../thesis' } });
eq(traversing.statusCode, 400, `a traversing template id is a 400: ${traversing.body}`);
eq(JSON.parse(traversing.body).error, 'bad template id', 'and says so');
eq(projectCount(), countBefore, 'no project is left behind');

const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Real', template: 'repo:lab/thesis' } });
eq(created.statusCode, 200, `creating from a repo template answers 200: ${created.body}`);
const projectId = JSON.parse(created.body).id;
const onDisk = fs.readFileSync(path.join(projectsDir, projectId, 'main.tex'), 'utf8');
check(onDisk.includes('\\title{Real}'), `the project name is in the created main.tex: ${onDisk}`);
check(fs.readFileSync(path.join(projectsDir, projectId, 'logo.png')).equals(LOGO), 'the logo reaches the project unmangled');
check(!fs.existsSync(path.join(projectsDir, projectId, 'template.json')) && !fs.existsSync(path.join(projectsDir, projectId, 'LICENSE')), 'gallery bookkeeping stays out of the project');

const states = JSON.parse((await app.inject({ method: 'GET', url: '/api/templates/repos' })).body);
eq(states.repos.map((s) => s.id), ['lab', 'dup'], 'GET /api/templates/repos lists the configured repositories');
const refreshRes = await app.inject({ method: 'POST', url: '/api/templates/repos/refresh' });
eq(refreshRes.statusCode, 200, 'the refresh route answers 200');
const refreshBody = JSON.parse(refreshRes.body);
eq(refreshBody.repos.map((s) => [s.id, s.ok, s.available, s.head]), [['lab', true, true, newHead], ['dup', true, true, newHead]], 'the refresh route syncs every repository');
const gallery = JSON.parse((await app.inject({ method: 'GET', url: '/api/templates' })).body);
check(gallery.some((t) => t.id === 'repo:dup/report' && t.source.kind === 'repo'), 'GET /api/templates shows the refreshed folder');

// The refresh route reports a failed sync as stale rather than failing the request.
fs.renameSync(bare, `${bare}.away`);
const staleRes = await app.inject({ method: 'POST', url: '/api/templates/repos/refresh' });
eq(staleRes.statusCode, 200, 'a failed refresh is still a 200');
const stale = JSON.parse(staleRes.body).repos;
check(stale.every((s) => s.ok === false && s.available === true && s.error), `every repository is stale with an error: ${staleRes.body}`);
check(!staleRes.body.includes('s3cr3t'), 'no token in the reported error');
fs.renameSync(`${bare}.away`, bare);

repos.stopTemplateRepoRefresh();
await app.close();
await closeDb();

// ---- 10. entry validation and interval floor ----
const valid = { id: 'ok', url: 'https://example.com/x.git' };
eq(repos.entryProblem(valid), null, 'a minimal entry is fine');
check(repos.entryProblem({ ...valid, id: 'Lab' }) !== null, 'an uppercase id is refused');
check(repos.entryProblem({ ...valid, id: '-lab' }) !== null, 'an id starting with a dash is refused');
check(repos.entryProblem({ ...valid, ref: '../main' }) !== null, 'a ref with .. is refused');
check(repos.entryProblem({ ...valid, ref: '--upload-pack=x' }) !== null, 'a ref that looks like an option is refused');
check(repos.entryProblem({ ...valid, path: '/etc' }) !== null, 'an absolute path is refused');
check(repos.entryProblem({ ...valid, path: 'a/../b' }) !== null, 'a path with .. is refused');
eq(repos.entryProblem({ ...valid, path: 'templates/latex' }), null, 'a relative path is fine');
check(repos.entryProblem({ ...valid, tokenEnv: 'tpl_token' }) !== null, 'a lowercase tokenEnv is refused');
eq(repos.entryProblem({ ...valid, tokenEnv: 'TPL_TOKEN', user: 'x-access-token', ref: 'v1.2', label: 'Mine' }), null, 'a full entry is fine');
check(repos.entryProblem({ ...valid, url: 'http://example.com/x.git' }) !== null, 'plain http to a non-loopback host is refused even under the test hook');
eq(repos.entryProblem({ ...valid, url: 'http://127.0.0.1:8080/x.git' }), null, 'loopback http is accepted under the test hook');
check(repos.entryProblem({ ...valid, label: '  ' }) !== null, 'a blank label is refused');
check(repos.entryProblem('lab') !== null, 'a non-object entry is refused');
check(repos.entryProblem(valid, new Set(['ok'])) !== null, 'a seen id is a duplicate');

process.env.TEMPLATE_REPOS_REFRESH_MS = '5';
eq(repos.refreshIntervalMs(), 60_000, 'the refresh interval floors at a minute');
process.env.TEMPLATE_REPOS_REFRESH_MS = 'soon';
eq(repos.refreshIntervalMs(), 600_000, 'a non-numeric interval falls back to the default');
delete process.env.TEMPLATE_REPOS_REFRESH_MS;
eq(repos.refreshIntervalMs(), 600_000, 'the default is ten minutes');

console.warn = realWarn;
fs.rmSync(tmp, { recursive: true, force: true });
console.log('template-repos: all checks passed');
