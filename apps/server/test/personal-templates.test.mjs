/**
 * Personal template repositories (#308):
 *  - an account adds a repository; its templates are listed and seed a
 *    project for that account only, never for another account or for a
 *    caller without one
 *  - the id comes from the label, the list survives a restart (it is read
 *    back from the store), and the per-account limit holds; 0 turns it off
 *  - a URL with credentials in it, a non-https URL, a host on a private
 *    address and a repository without a template are refused, and nothing
 *    of a refused one is kept
 *  - removing a repository, or deleting the account, removes its checkout
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { check, eq } from './assert.mjs';

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-personal-templates-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.VENUES_FILE = path.join(tmp, 'venues.json');
// file:// repository URLs are only accepted under the test hook.
process.env.ALDINE_TEST_HOOKS = '1';
process.env.ALDINE_TEMPLATE_PREVIEWS = '0';
delete process.env.ALDINE_PERSONAL_TEMPLATE_REPOS;
delete process.env.TEMPLATE_REPOS;
delete process.env.TEMPLATE_REPOS_FILE;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.AUTH_ENABLED;

fs.mkdirSync(process.env.TEMPLATES_DIR, { recursive: true });
fs.writeFileSync(process.env.VENUES_FILE, JSON.stringify({ venues: [] }));
globalThis.fetch = async () => { throw new Error('connection refused'); };

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
function bareRepo(name, files) {
  const bare = path.join(tmp, `${name}.git`);
  const work = path.join(tmp, `${name}-work`);
  fs.mkdirSync(bare);
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  git(tmp, 'clone', '-q', bare, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'files');
  git(work, 'push', '-q', 'origin', 'main');
  return pathToFileURL(bare).href;
}

const lettersUrl = bareRepo('letters', {
  'letter/template.json': JSON.stringify({ name: 'My letter' }),
  'letter/main.tex': '\\documentclass{letter}\n% {{AUTHOR}}\n',
  'slides/template.json': JSON.stringify({ name: 'My slides', category: 'Slides' }),
  'slides/main.tex': '\\documentclass{beamer}\n',
});
const emptyUrl = bareRepo('empty', { 'README.md': 'no templates here\n' });

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const repos = await import('../src/templaterepos.ts');
const { listAllTemplates, resolveTemplateSeed } = await import('../src/templates.ts');
const auth = await import('../src/auth.ts');

const ada = 'user-ada';
const bob = 'user-bob';
const rejects = async (p, re, msg) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  check(err && re.test(String(err.message)), `${msg}: ${err ? err.message : 'no error'}`);
};

// ---- adding ----
const view = await repos.addPersonalRepo(ada, { label: 'Letters & slides', url: lettersUrl });
eq(view.id, 'letters-slides', 'the id is made from the label');
eq(view.templates, 2, 'both templates are counted');
check(view.ok && view.available, 'the repository is cloned');
check(view.repoId.startsWith('~') && view.repoId.endsWith('-letters-slides'), `the repository id is personal: ${view.repoId}`);
const stored = await db().getConnection(ada, 'template-repos');
eq(stored.repos.map((r) => [r.id, r.label, r.url]), [['letters-slides', 'Letters & slides', lettersUrl]], 'the list is stored with the account');

const second = await repos.addPersonalRepo(ada, { label: 'Letters & slides', url: lettersUrl });
eq(second.id, 'letters-slides-2', 'a second repository with the same label gets its own id');
check(await repos.removePersonalRepo(ada, 'letters-slides-2'), 'and can be removed again');

// ---- who sees it ----
const letterId = `repo:${view.repoId}/letter`;
const idsFor = async (viewer) => (await listAllTemplates(viewer)).map((t) => t.id);
check((await idsFor(ada)).includes(letterId), 'the owner is shown the templates');
check(!(await idsFor(bob)).includes(letterId), 'another account is not');
check(!(await idsFor(null)).includes(letterId), 'a caller without an account is not');
const listed = (await listAllTemplates(ada)).find((t) => t.id === letterId);
eq(listed.source, { kind: 'repo', label: 'Letters & slides', personal: true }, 'the tile says the repository is personal');
check(repos.templateVisibleTo(letterId, ada) && !repos.templateVisibleTo(letterId, bob) && !repos.templateVisibleTo(letterId, null), 'templateVisibleTo answers the owner only');
check(repos.templateVisibleTo('repo:lab/thesis', null) && repos.templateVisibleTo('article', bob), 'every other id is visible as before');

const seed = await resolveTemplateSeed(letterId, { author: 'Ada', viewer: ada });
check(seed.files['main.tex'].toString().includes('% Ada'), 'the owner can start a project from it');
await rejects(resolveTemplateSeed(letterId, { viewer: bob }), /unknown template/, 'another account cannot');
await rejects(resolveTemplateSeed(letterId, {}), /unknown template/, 'nor can a caller without an account');
eq(repos.personalStates(ada).map((s) => [s.id, s.personal, s.ok]), [[view.repoId, true, true]], 'the gallery gets the sync state of the account\'s repositories');
eq(repos.personalStates(bob), [], 'and nobody else\'s');

// ---- a restart: read back from the store ----
repos.resetTemplateRepos();
check(!repos.templateVisibleTo(letterId, ada), 'nothing is registered before the account is read');
const again = await resolveTemplateSeed(letterId, { viewer: ada });
check(!!again.files['main.tex'], 'seeding reads the account\'s list first');
eq((await repos.loadPersonalRepos(ada)).map((e) => e.id), [view.repoId], 'the list comes back from the store');

// ---- refusals ----
const checkouts = () => fs.readdirSync(path.join(process.env.CACHE_DIR, 'template-repos')).sort();
const before = checkouts();
await rejects(repos.addPersonalRepo(ada, { url: 'https://user:secret@example.com/x.git' }), /token out of the URL/, 'credentials in the URL are refused');
await rejects(repos.addPersonalRepo(ada, { url: 'http://example.com/x.git' }), /https:\/\//, 'a plain-http URL is refused');
await rejects(repos.addPersonalRepo(ada, { label: 'Inside', url: 'https://10.0.0.7/x.git' }), /private address/, 'a host on a private address is refused');
await rejects(repos.addPersonalRepo(ada, { label: 'Empty', url: emptyUrl }), /has no template/, 'a repository without a template is refused');
await rejects(repos.addPersonalRepo(ada, { label: 'Sub', url: lettersUrl, path: '../x' }), /path/i, 'a path outside the repository is refused');
eq(checkouts(), before, 'no checkout of a refused repository is kept');
eq((await db().getConnection(ada, 'template-repos')).repos.length, 1, 'nor is it stored');

// ---- the limit ----
process.env.ALDINE_PERSONAL_TEMPLATE_REPOS = '1';
await rejects(repos.addPersonalRepo(ada, { url: lettersUrl }), /up to 1 template repositor/, 'the per-account limit holds');
process.env.ALDINE_PERSONAL_TEMPLATE_REPOS = '0';
eq(await repos.loadPersonalRepos(ada), [], 'with 0 the account\'s repositories are not loaded');
check(!repos.templateVisibleTo(letterId, ada), 'nor visible');
await rejects(repos.addPersonalRepo(ada, { url: lettersUrl }), /turned off/, 'and none can be added');
delete process.env.ALDINE_PERSONAL_TEMPLATE_REPOS;
await repos.loadPersonalRepos(ada);

// ---- removing ----
check(!(await repos.removePersonalRepo(bob, 'letters-slides')), 'another account cannot remove it');
check(fs.existsSync(repos.templateRepoDir(view.repoId)), 'the checkout is still there');
check(await repos.removePersonalRepo(ada, 'letters-slides'), 'the owner removes it');
check(!fs.existsSync(repos.templateRepoDir(view.repoId)), 'the checkout goes with it');
check(!(await idsFor(ada)).includes(letterId), 'its templates are gone from the gallery');
eq(await db().getConnection(ada, 'template-repos'), null, 'an empty list leaves no row');

// ---- deleting the account ----
await db().createUser({ id: bob, email: 'bob@example.com', name: 'Bob', salt: '', hash: '', createdAt: new Date().toISOString() });
const bobs = await repos.addPersonalRepo(bob, { label: 'Bob', url: lettersUrl });
check(fs.existsSync(repos.templateRepoDir(bobs.repoId)), 'bob has a checkout');
await auth.deleteAccount(bob);
check(!fs.existsSync(repos.templateRepoDir(bobs.repoId)), 'deleting the account removes its checkouts');
check(!repos.templateVisibleTo(`repo:${bobs.repoId}/letter`, bob), 'and its templates');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('personal-templates: all checks passed');
process.exit(0);
