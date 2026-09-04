import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { execSync } from 'node:child_process';

/**
 * Templates from two sources at once: a local directory and a nominated GitLab
 * group. GITLAB_DEFAULT_GROUP is deliberately unset — templates must work
 * without making GitLab the home for new projects.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-tpl-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
const TPL = path.join(tmp, 'templates');
process.env.TEMPLATES_DIR = TPL;

// --- local templates on disk ---
const mk = (rel, content) => {
  const abs = path.join(TPL, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
// no template.json at all: a plain folder of papers is a valid template
mk('thesis-draft/main.tex', '\\documentclass{report}\n% {{PROJECT_NAME}} by {{AUTHOR}}, {{DATE}}\n');
mk('thesis-draft/refs.bib', '@book{a,title={A}}\n');
// a manifest wins over the folder name
mk('grant/template.json', JSON.stringify({ name: 'Grant proposal', icon: '💰', order: 1 }));
mk('grant/main.tex', '\\documentclass{article}\n\\title{{{PROJECT_NAME}}}\n\\date{{{DATE}}}\n');
// broken manifest: skipped, and said so
mk('broken/template.json', '{ not json');
mk('broken/main.tex', 'x');
// nothing LaTeX in it: not a template
mk('notes/readme.md', 'just notes');
// a binary must survive the copy byte-for-byte
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01, 0x80]);
mk('branded/main.tex', '\\documentclass{article}\\usepackage{graphicx}\n');
fs.writeFileSync(path.join(TPL, 'branded/logo.png'), PNG);

// --- a GitLab group of template projects ---
const BARES = path.join(tmp, 'bares'); fs.mkdirSync(BARES, { recursive: true });
function seedBare(full, files) {
  const bare = path.join(BARES, `${full.replace(/\//g, '__')}.git`);
  execSync(`git init -q --bare -b main "${bare}"`, { stdio: 'ignore' });
  const work = path.join(tmp, `work-${full.replace(/\//g, '__')}`);
  execSync(`git clone -q "${bare}" "${work}"`, { stdio: 'ignore' });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(work, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execSync(`cd "${work}" && git add -A && git -c user.email=e@e.e -c user.name=e commit -q -m init && git push -q origin main`, { stdio: 'ignore' });
  return `file://${bare}`;
}

const GROUP = 'research/latex/templates';
const glProjects = [];
function addTemplateProject({ path: slug, name, description, files, manifest, group = GROUP }) {
  const full = `${group}/${slug}`;
  glProjects.push({
    id: glProjects.length + 1, path: slug, name, description,
    path_with_namespace: full, default_branch: 'main',
    http_url_to_repo: seedBare(full, { ...files, ...(manifest ? { 'template.json': JSON.stringify(manifest) } : {}) }),
    namespace: { full_path: group },
  });
  return full;
}

addTemplateProject({
  path: 'ieee-paper', name: 'ieee-paper', description: 'IEEE two-column manuscript',
  manifest: { name: 'IEEE paper', icon: '📐', order: 2 },
  files: {
    'main.tex': '\\documentclass{IEEEtran}\n\\title{{{PROJECT_NAME}}}\n\\author{{{AUTHOR}}}\n% (c) {{YEAR}}\n',
    'sections/intro.tex': 'Intro for {{PROJECT_NAME}}.\n',
    '.gitignore': 'my-own-ignore\n*.aux\n',
    'logo.png': PNG,
  },
});
// no manifest: the GitLab project's own name and description carry the tile
addTemplateProject({
  path: 'lab-report', name: 'Lab report', description: 'Weekly lab write-up',
  files: { 'main.tex': '\\documentclass{article}\n% {{PROJECT_NAME}}\n' },
});

let listCalls = 0;
let mockDown = false;
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (mockDown) return send(503, { message: 'gitlab is down' });
  if (url.pathname === '/api/v4/user') return send(200, { username: 'tester', name: 'Tester' });

  const gp = url.pathname.match(/^\/api\/v4\/groups\/([^/]+)\/projects$/);
  if (gp) {
    const group = decodeURIComponent(gp[1]);
    if (group !== GROUP) return send(404, { message: '404 Group Not Found' });
    check(url.searchParams.get('include_subgroups') === 'true', 'subgroups are included in the template listing');
    listCalls++;
    return send(200, glProjects);
  }

  const raw = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)\/repository\/files\/template\.json\/raw$/);
  if (raw) {
    const full = decodeURIComponent(raw[1]);
    const bare = path.join(BARES, `${full.replace(/\//g, '__')}.git`);
    try {
      const body = execSync(`git --git-dir="${bare}" show main:template.json`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(body);
    } catch { return send(404, { message: '404 File Not Found' }); }
  }
  send(404, { message: 'not mocked' });
});
await new Promise((r) => mock.listen(0, r));
process.env.GITLAB_API_BASE = `http://localhost:${mock.address().port}/api/v4`;
process.env.GITLAB_TOKEN = 'svc';
process.env.GITLAB_TEMPLATE_GROUP = GROUP;
process.env.GITLAB_TEMPLATE_TTL_MS = '80';
delete process.env.GITLAB_DEFAULT_GROUP;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };
const fileIn = (id, rel) => path.join(process.env.DATA_DIR, 'projects', id, rel);

// --- listing merges both sources ---
let r = await app.inject({ url: '/api/templates' });
check(r.statusCode === 200, 'list: ' + r.body);
const list = J(r);
const byId = Object.fromEntries(list.map((t) => [t.id, t]));

check(!!byId['thesis-draft'], 'a folder with no template.json is still a template');
check(byId['thesis-draft'].name === 'Thesis draft', 'name derived from the folder: ' + byId['thesis-draft'].name);
check(byId['thesis-draft'].source === 'local', 'labelled as local');
check(byId.grant?.name === 'Grant proposal', 'a manifest name wins over the folder name');
check(!byId.broken, 'a template with unparseable template.json is skipped');
check(!byId.notes, 'a folder with no .tex and no manifest is not a template');

check(!!byId[`gitlab:${GROUP}/ieee-paper`], 'gitlab templates are listed, ids prefixed: ' + list.map((t) => t.id).join(','));
check(byId[`gitlab:${GROUP}/ieee-paper`].name === 'IEEE paper', 'manifest name from the repo');
check(byId[`gitlab:${GROUP}/ieee-paper`].icon === '📐', 'manifest icon from the repo');
check(byId[`gitlab:${GROUP}/ieee-paper`].source === 'gitlab', 'labelled as gitlab');
const lab = byId[`gitlab:${GROUP}/lab-report`];
check(lab?.name === 'Lab report' && lab.description === 'Weekly lab write-up',
  'a template project with no manifest falls back to its GitLab name and description');

// order first, then name: grant(1), ieee(2), then the unordered ones alphabetically
check(list[0].id === 'grant' && list[1].id === `gitlab:${GROUP}/ieee-paper`, 'ordered by `order`: ' + list.map((t) => t.id).join(','));

// --- the listing is cached, and picks up a new template after the TTL ---
const afterFirst = listCalls;
await app.inject({ url: '/api/templates' });
check(listCalls === afterFirst, 'a second list within the TTL is served from cache');
addTemplateProject({ path: 'poster', name: 'Poster', files: { 'main.tex': '\\documentclass{a0poster}\n' } });
await new Promise((res) => setTimeout(res, 120));
r = await app.inject({ url: '/api/templates' });
check(J(r).some((t) => t.id === `gitlab:${GROUP}/poster`), 'a template added to the group appears after the TTL');

// --- creating from a local template, with placeholders ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'My Thesis', template: 'thesis-draft' } });
check(r.statusCode === 200, 'create from local template: ' + r.body);
let id = J(r).id;
let tex = fs.readFileSync(fileIn(id, 'main.tex'), 'utf8');
check(tex.includes('% My Thesis by '), 'PROJECT_NAME substituted: ' + tex);
check(/, \d{4}-\d{2}-\d{2}$/m.test(tex.trim()), 'DATE substituted: ' + tex);
check(!tex.includes('{{'), 'no placeholder left behind: ' + tex);
check(fs.existsSync(fileIn(id, 'refs.bib')), 'every template file is copied');
check(!J(r).remote, 'templates do not imply a GitLab mirror when no default group is set');

// --- binaries survive a local template ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Branded', template: 'branded' } });
id = J(r).id;
check(Buffer.compare(fs.readFileSync(fileIn(id, 'logo.png')), PNG) === 0, 'a binary template file is copied byte-for-byte');

// --- creating from a GitLab template ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Sensor Fusion', template: `gitlab:${GROUP}/ieee-paper` } });
check(r.statusCode === 200, 'create from gitlab template: ' + r.body);
id = J(r).id;
tex = fs.readFileSync(fileIn(id, 'main.tex'), 'utf8');
check(tex.includes('\\title{Sensor Fusion}'), 'PROJECT_NAME substituted in a cloned template: ' + tex);
check(tex.includes(`(c) ${new Date().getFullYear()}`), 'YEAR substituted: ' + tex);
check(fs.readFileSync(fileIn(id, 'sections/intro.tex'), 'utf8').includes('Sensor Fusion'), 'nested files are cloned and substituted');
check(Buffer.compare(fs.readFileSync(fileIn(id, 'logo.png')), PNG) === 0, 'a binary in a cloned template survives');
check(!fs.existsSync(fileIn(id, 'template.json')), 'the manifest is not copied into the project');
check(!fs.existsSync(path.join(process.env.DATA_DIR, 'projects', id, '.git', 'refs', 'remotes', 'origin')),
  'the template is not a remote of the new project');
const gitignore = fs.readFileSync(fileIn(id, '.gitignore'), 'utf8');
check(gitignore.includes('my-own-ignore'), "a template's own .gitignore is kept: " + gitignore);
check(gitignore.includes('.aldine-out/'), 'the Aldine ignores are appended: ' + gitignore);
check(gitignore.split('\n').filter((l) => l.trim() === '*.aux').length === 1, 'no duplicated ignore lines: ' + gitignore);
const logCount = execSync(`git --git-dir="${path.join(process.env.DATA_DIR, 'projects', id, '.git')}" rev-list --count HEAD`).toString().trim();
check(logCount === '1', `a project from a template starts with one commit of its own, saw ${logCount}`);

// --- an unknown template is a clean 400, and creates nothing ---
const before = (await app.inject({ url: '/api/projects' })).body.length;
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Nope', template: 'gitlab:research/latex/templates/missing' } });
check(r.statusCode === 400, 'unknown template is rejected: ' + r.statusCode);
check(/unknown template/.test(J(r).error || ''), 'says what went wrong: ' + r.body);
check((await app.inject({ url: '/api/projects' })).body.length === before, 'no project is left behind by a failed template read');

// --- a path traversal in a local id is refused ---
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Evil', template: '../../etc' } });
check(r.statusCode === 400, 'a traversing template id is refused');

// --- GitLab down: local templates still work ---
mockDown = true;
await new Promise((res) => setTimeout(res, 120));
r = await app.inject({ url: '/api/templates' });
check(r.statusCode === 200, 'listing survives an unreachable GitLab: ' + r.body);
check(J(r).every((t) => t.source === 'local'), 'only local templates remain');
check(J(r).some((t) => t.id === 'grant'), 'the local ones are all still there');
r = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Offline Grant', template: 'grant' } });
check(r.statusCode === 200, 'a local template still creates while GitLab is down: ' + r.body);
mockDown = false;

// --- no template group configured: local only, no GitLab calls ---
delete process.env.GITLAB_TEMPLATE_GROUP;
const callsBefore = listCalls;
await new Promise((res) => setTimeout(res, 120));
r = await app.inject({ url: '/api/templates' });
check(J(r).every((t) => t.source === 'local'), 'no group configured means local templates only');
check(listCalls === callsBefore, 'and GitLab is not called at all');

mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('gitlab-templates.integration: OK');
