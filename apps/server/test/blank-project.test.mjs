/**
 * Blank projects (issue #8) against a throwaway data dir:
 *  - template "blank" and files {} create a project with zero files and no root
 *  - no files and no template still seeds the default article
 *  - the template list leads with "blank"
 *  - the first .tex created (or renamed in) becomes the root; non-.tex do not
 *  - deleting the last .tex unsets the root; the next .tex adopts it again
 *  - typesetting a rootless project with no .tex is refused before the compiler
 *  - typesetting a rootless project that gained a .tex through git adopts it
 *  - a templates/blank directory does not duplicate the built-in entry
 *  - `files` keys reaching .git (any letter case, NTFS trailing dot or
 *    space), non-string values, empty keys and file/dir conflicts (including
 *    a directory named .gitignore) are refused with 400 and leave no repo dir
 *    behind
 *  - adopted roots are stored normalised; adoption and re-derivation rank
 *    like an import (main.tex over appendix/main.tex, \documentclass over a
 *    shallower classless file)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-blank-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
// A deployment that ships templates/blank/ must not shadow the built-in entry.
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
fs.mkdirSync(path.join(tmp, 'templates', 'article'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'templates', 'article', 'template.json'), JSON.stringify({ name: 'Article', order: 1 }));
fs.writeFileSync(path.join(tmp, 'templates', 'article', 'main.tex'), '\\documentclass{article}\\begin{document}A\\end{document}');
fs.mkdirSync(path.join(tmp, 'templates', 'blank'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'templates', 'blank', 'template.json'), JSON.stringify({ name: 'Blank on disk' }));
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

// Mock compiler: records what it is asked for and answers a failed run.
const requests = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    requests.push(JSON.parse(raw));
    const buf = Buffer.from(JSON.stringify({ ok: false, pdf: null, log: 'mock', errors: [], durationMs: 1 }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: Fastify } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');

await initDb();
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
await registerRoutes(app);
await app.ready();

const create = (payload) => app.inject({ method: 'POST', url: '/api/projects', payload });
const userFiles = (id) => store.listFiles(id, 'main').filter((f) => f.type === 'file' && f.path !== '.gitignore').map((f) => f.path).sort();
const rootOf = async (id) => (await store.readMeta(id)).rootFile;
const put = (id, p, content = '') => app.inject({ method: 'PUT', url: `/api/projects/${id}/file`, payload: { branch: 'main', path: p, content, createOnly: true } });
const del = (id, p) => app.inject({ method: 'DELETE', url: `/api/projects/${id}/file?branch=main&path=${encodeURIComponent(p)}` });
const compile = (id) => app.inject({ method: 'POST', url: `/api/projects/${id}/compile`, payload: { branch: 'main' } });

try {
  // ---- creation paths ----
  let res = await create({ name: 'Blank', template: 'blank' });
  eq(res.statusCode, 200, `template blank creates: ${res.body}`);
  const blank = res.json();
  eq(userFiles(blank.id), [], 'template blank: no files');
  eq(blank.rootFile, '', 'template blank: no root');

  res = await create({ name: 'Empty files', files: {} });
  eq(res.statusCode, 200, `files {} creates: ${res.body}`);
  eq(userFiles(res.json().id), [], 'files {}: no files');
  eq(res.json().rootFile, '', 'files {}: no root');

  res = await create({ name: 'Default' });
  eq(userFiles(res.json().id), ['main.tex', 'references.bib'], 'no files, no template: default article');
  eq(res.json().rootFile, 'main.tex', 'default article root');

  res = await create({ name: 'Custom', files: { 'paper/thesis.tex': '\\documentclass{article}' } });
  eq(userFiles(res.json().id), ['paper/thesis.tex'], 'explicit files are used as given');
  eq(res.json().rootFile, 'paper/thesis.tex', 'first .tex of explicit files is the root');

  res = await create({ name: 'Bogus', template: 'nope' });
  eq(res.statusCode, 400, 'unknown template still refused');

  res = await app.inject({ method: 'GET', url: '/api/templates' });
  eq(res.json()[0].id, 'blank', 'template list leads with blank');
  eq(res.json()[0].name, 'Blank', 'the built-in entry, not the directory claiming its id');
  eq(res.json().filter((t) => t.id === 'blank').length, 1, 'a templates/blank directory does not list a second blank');
  check(res.json().some((t) => t.id === 'article'), 'directory templates still listed');

  // ---- seed validation: nothing may reach .git before the initial commit ----
  const projectsDir = path.join(process.env.DATA_DIR, 'projects');
  const repoDirs = () => fs.readdirSync(projectsDir).sort();
  const dirsBefore = repoDirs();
  const idsBefore = (await store.listProjects()).map((m) => m.id).sort();
  for (const [label, files] of [
    ['.git/config', { 'main.tex': 'x', '.git/config': '[core]\n\tfsmonitor = touch /tmp/pwned\n' }],
    ['.git/hooks/pre-commit', { '.git/hooks/pre-commit': '#!/bin/sh\necho pwned' }],
    ['nested .git', { 'sub/.git/config': 'x' }],
    ['.GIT (case-insensitive filesystems)', { '.GIT/config': '[core]\n\tfsmonitor = touch /tmp/pwned\n' }],
    ['.Git hooks', { '.Git/hooks/pre-commit': '#!/bin/sh\necho pwned' }],
    ['.git. (NTFS trailing dot)', { '.git./config': 'x' }],
    ['.git with trailing space', { '.git /config': 'x' }],
    ['.aldine-out', { '.aldine-out/main.pdf': 'x' }],
    ['.ALDINE-OUT', { '.ALDINE-OUT/main.pdf': 'x' }],
    ['.gitignore as a directory', { '.gitignore/x': 'y' }],
    ['escape', { '../evil.tex': 'x' }],
    ['absolute', { '/etc/passwd': 'x' }],
    ['empty key', { '': 'x' }],
    ['non-string value', { 'main.tex': 1 }],
    ['file/dir conflict', { 'a': 'x', 'a/b': 'y' }],
    ['array', ['main.tex']],
  ]) {
    res = await create({ name: label, files });
    eq(res.statusCode, 400, `${label} → 400 (${res.body})`);
    check(typeof res.json().error === 'string' && res.json().error.length > 0, `${label}: error message present`);
  }
  eq(repoDirs(), dirsBefore, 'no repo dir left behind by a rejected seed');
  eq((await store.listProjects()).map((m) => m.id).sort(), idsBefore, 'no project recorded for a rejected seed');

  res = await create({ name: 'Own gitignore', files: { 'main.tex': 'x', '.gitignore': '*.bak\n' } });
  eq(res.statusCode, 200, `a .gitignore file in the seed is accepted: ${res.body}`);

  res = await create({ name: 'Dotted', files: { './main.tex': '\\documentclass{article}', 'paper\\notes.tex': 'x' } });
  eq(res.statusCode, 200, `normalisable keys accepted: ${res.body}`);
  eq(userFiles(res.json().id), ['main.tex', 'paper/notes.tex'], 'keys are stored normalised');
  eq(res.json().rootFile, 'main.tex', 'root from the normalised key');

  // ---- root adoption ----
  res = await put(blank.id, 'notes.md', '# notes');
  eq(res.json(), { ok: true }, 'a non-.tex file is not adopted as root');
  eq(await rootOf(blank.id), '', 'root still unset after notes.md');

  res = await put(blank.id, 'main.tex', '\\documentclass{article}\\begin{document}Hi\\end{document}');
  eq(res.json(), { ok: true, newRoot: 'main.tex' }, 'first .tex is adopted and reported');
  eq(await rootOf(blank.id), 'main.tex', 'root is main.tex');

  res = await put(blank.id, 'extra.tex', 'x');
  eq(res.json(), { ok: true }, 'a second .tex leaves the root alone');
  eq(await rootOf(blank.id), 'main.tex', 'root unchanged by extra.tex');

  res = await del(blank.id, 'main.tex');
  eq(res.json(), { ok: true, newRoot: 'extra.tex' }, 'deleting the root re-points it at the other .tex');
  res = await del(blank.id, 'extra.tex');
  eq(res.json(), { ok: true }, 'deleting the last .tex reports no new root');
  eq(await rootOf(blank.id), '', 'root unset once no .tex remains');

  res = await app.inject({ method: 'POST', url: `/api/projects/${blank.id}/file/rename`, payload: { branch: 'main', from: 'notes.md', to: 'intro.tex' } });
  eq(res.json(), { ok: true, newRoot: 'intro.tex' }, 'renaming in the first .tex adopts it');
  eq(await rootOf(blank.id), 'intro.tex', 'root is intro.tex');

  // ---- typeset without a .tex: refused before the compiler ----
  res = await create({ name: 'Rootless', template: 'blank' });
  const rootless = res.json();
  res = await compile(rootless.id);
  eq(res.statusCode, 400, 'compile of a blank project → 400');
  check(res.json().error.includes('No .tex file'), `error says what is missing: ${res.json().error}`);
  eq(requests.length, 0, 'the compiler was never asked');

  // ---- a .tex that arrived through git is adopted at typeset time ----
  fs.writeFileSync(path.join(store.branchDir(rootless.id, 'main'), 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}');
  await gitops.commitAll(rootless.id, 'main', 'test: main.tex via git');
  res = await compile(rootless.id);
  eq(res.statusCode, 200, `compile with a git-added .tex reaches the compiler: ${res.body}`);
  eq(requests.length, 1, 'one compiler request');
  eq(requests[0].rootFile, 'main.tex', 'the adopted root was sent');
  eq(await rootOf(rootless.id), 'main.tex', 'adoption persisted');

  // ---- adopted roots are stored normalised ----
  res = await create({ name: 'Dotted paths', template: 'blank' });
  const dotted = res.json();
  res = await put(dotted.id, './main.tex', 'x');
  eq(res.json(), { ok: true, newRoot: 'main.tex' }, 'a ./ path is adopted as its normalised form');
  res = await app.inject({ method: 'POST', url: `/api/projects/${dotted.id}/file/rename`, payload: { branch: 'main', from: './main.tex', to: 'paper//main.tex' } });
  eq(res.json(), { ok: true, newRoot: 'paper/main.tex' }, 'a renamed root keeps its designation, normalised');
  res = await del(dotted.id, './paper/main.tex');
  eq(res.json(), { ok: true }, 'deleting the root through an unnormalised path unsets it');
  eq(await rootOf(dotted.id), '', 'root unset');

  // ---- adoption ranks like an import ----
  const viaGit = async (id, files) => {
    for (const [p, c] of Object.entries(files)) {
      const abs = path.join(store.branchDir(id, 'main'), p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, c);
    }
    await gitops.commitAll(id, 'main', 'test: files via git');
  };
  const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}';
  res = await create({ name: 'Nested main', template: 'blank' });
  const nested = res.json();
  await viaGit(nested.id, { 'appendix/main.tex': doc, 'main.tex': doc });
  res = await compile(nested.id);
  eq(res.statusCode, 200, `compile adopts a root: ${res.body}`);
  eq(await rootOf(nested.id), 'main.tex', 'top-level main.tex beats appendix/main.tex');

  res = await create({ name: 'Classless first', template: 'blank' });
  const classless = res.json();
  await viaGit(classless.id, { 'chapters/intro.tex': '\\section{Intro}', 'thesis.tex': doc });
  res = await compile(classless.id);
  eq(res.statusCode, 200, `compile adopts a root: ${res.body}`);
  eq(await rootOf(classless.id), 'thesis.tex', '\\documentclass beats a classless file that sorts first');

  res = await create({ name: 'Delete re-derives', files: { 'main.tex': doc, 'chapters/intro.tex': '\\section{Intro}', 'thesis.tex': doc } });
  const rederive = res.json();
  eq(rederive.rootFile, 'main.tex', 'main.tex is the initial root');
  res = await del(rederive.id, 'main.tex');
  eq(res.json(), { ok: true, newRoot: 'thesis.tex' }, 'deleting the root re-derives by ranking, not by sort order');

  res = await create({ name: 'Adopt on write', template: 'blank' });
  const adopt = res.json();
  await viaGit(adopt.id, { 'thesis.tex': doc });
  res = await put(adopt.id, 'notes/scratch.tex', '');
  eq(res.json(), { ok: true, newRoot: 'thesis.tex' }, 'the first write to a rootless branch adopts the best .tex on it');

  console.log('blank-project: all assertions passed');
} finally {
  await app.close();
  await closeDb();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
