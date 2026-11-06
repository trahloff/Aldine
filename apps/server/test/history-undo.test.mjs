/**
 * The way back through History: a page of the log carries what each commit
 * changed and pages back with skip/limit; a deleted file or folder lands as
 * its own commit whose revert brings it back; a merge reverts against its
 * first parent; a conflicted merge into a branch can keep both versions;
 * and the checkpoints before a branch, a merge or a revert take the
 * person's message. Without accounts, so the claimed author is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-history-undo-'));
delete process.env.AUTH_ENABLED;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const project = await store.createProject('History Undo', { 'main.tex': 'Opening line.\n', 'chapters/one.tex': 'One.\n', 'chapters/two.tex': 'Two.\n' });
const id = project.id;
const dir = (branch = 'main') => store.branchDir(id, branch);
const read = (rel, branch = 'main') => fs.readFileSync(path.join(dir(branch), rel), 'utf8');
const inject = (method, url, payload) => app.inject({ method, url: `/api/projects/${id}${url}`, ...(payload ? { payload } : {}) });
const log = async (query = '') => (await inject('GET', `/log?branch=main${query}`)).json();

try {
  // ---- a page of the log names the files and the parents ----
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(dir(), `n${i}.tex`), `note ${i}\n`);
    await gitops.commitAll(id, 'main', `Add note ${i}`, 'Ada');
  }
  let entries = await log();
  eq(entries[0].message, 'Add note 5', 'newest first');
  eq(entries[0].files, ['n5.tex'], 'an entry names the paths it changed');
  eq(entries[0].fileCount, 1, 'and counts them');
  eq(entries[0].parents, 1, 'a plain commit has one parent');
  const first = entries[entries.length - 1];
  eq(first.message, 'Initial commit', 'the first commit is listed');
  eq(first.parents, 0, 'and has no parent');
  check(first.files.includes('chapters/one.tex'), `the first commit names the seeded files: ${first.files}`);

  const page1 = await log('&limit=2');
  const page2 = await log('&limit=2&skip=2');
  eq(page1.map((c) => c.message), ['Add note 5', 'Add note 4'], 'limit caps the page');
  eq(page2.map((c) => c.message), ['Add note 3', 'Add note 2'], 'skip pages back from the newest');
  eq((await log('&limit=0')).length, 1, 'a zero limit still answers one entry');
  eq((await log('&skip=-3&limit=2')).map((c) => c.message), ['Add note 5', 'Add note 4'], 'a bad skip is no skip');

  // ---- deleting a file is its own commit, and its revert brings it back ----
  fs.writeFileSync(path.join(dir(), 'main.tex'), 'Opening line, typed but not yet autosaved.\n');
  let res = await inject('DELETE', '/file?branch=main&path=main.tex&author=Ada');
  eq(res.statusCode, 200, 'the delete answers');
  let body = res.json();
  check(/^[0-9a-f]{7}$/.test(body.commit ?? ''), `the delete names its commit: ${JSON.stringify(body)}`);
  eq(body.pending, false, 'nothing waits with automatic commits');
  entries = await log();
  eq(entries[0].message, 'Delete main.tex', 'the deletion is titled with the path');
  eq(entries[0].author, 'Ada', 'under the person who deleted it');
  eq(entries[0].files, ['main.tex'], 'and holds the deletion only');
  eq(entries[1].message, 'aldine: autosave', 'the typing before it was saved first');
  check(!fs.existsSync(path.join(dir(), 'main.tex')), 'the file is gone');

  res = await inject('POST', '/revert', { branch: 'main', hashes: [body.commit], message: 'Undo “Delete main.tex”', author: 'Ada' });
  eq(res.statusCode, 200, 'the undo answers');
  check(res.json().ok, 'the undo reverted the deletion');
  eq(read('main.tex'), 'Opening line, typed but not yet autosaved.\n', 'the file is back with its latest text');

  // ---- a folder, with a file no autosave reached yet ----
  fs.writeFileSync(path.join(dir(), 'chapters/three.tex'), 'Three, brand new.\n');
  body = (await inject('DELETE', '/file?branch=main&path=chapters')).json();
  check(!!body.commit, 'the folder delete names its commit');
  eq((await log())[0].message, 'Delete folder chapters', 'a folder deletion says so');
  check(!fs.existsSync(path.join(dir(), 'chapters')), 'the folder is gone');
  check((await inject('POST', '/revert', { branch: 'main', hashes: [body.commit] })).json().ok, 'the folder undo reverted');
  eq(read('chapters/three.tex'), 'Three, brand new.\n', 'a file that was never committed comes back too');
  eq(read('chapters/one.tex'), 'One.\n', 'and the committed ones');

  // ---- manual commits: the deletion waits for the person ----
  let meta = await store.readMeta(id);
  meta.manualCommits = true;
  await store.writeMeta(meta);
  const before = (await log()).length;
  body = (await inject('DELETE', '/file?branch=main&path=n1.tex')).json();
  eq(body.commit, null, 'no commit is made for a manual-commit project');
  eq(body.pending, true, 'and the deletion is reported as waiting');
  eq((await log()).length, before, 'History did not move');
  check((await gitops.uncommittedPaths(id, 'main')).includes('n1.tex'), 'the deletion waits uncommitted');

  // ---- the checkpoints before a branch, a merge and a revert take the person's message ----
  res = await inject('POST', '/branches', { name: 'draft', from: 'main', checkpoint: 'Drop the first note', author: 'Ada' });
  eq(res.statusCode, 200, 'the branch was created');
  entries = await log();
  eq(entries[0].message, 'Drop the first note', 'the waiting edit was committed under the person\'s message');
  eq(entries[0].author, 'Ada', 'and name');

  fs.writeFileSync(path.join(dir(), 'n2.tex'), 'note 2, edited\n');
  const target = entries.find((c) => c.message === 'Add note 3');
  res = await inject('POST', '/revert', { branch: 'main', hashes: [target.hash], message: 'Undo “Add note 3”', author: 'Ada', checkpoint: 'Edit the second note' });
  check(res.json().ok, 'the revert went through');
  entries = await log();
  eq(entries.slice(0, 2).map((c) => c.message), ['Undo “Add note 3”', 'Edit the second note'], 'the waiting edit was committed under its message before the revert');

  fs.writeFileSync(path.join(dir('draft'), 'n4.tex'), 'note 4 on the draft\n');
  await gitops.commitAll(id, 'draft', 'Rework note 4', 'Ada');
  fs.writeFileSync(path.join(dir(), 'n5.tex'), 'note 5, waiting\n');
  res = await inject('POST', '/merge', { from: 'draft', into: 'main', author: 'Ada', checkpoint: 'Edit the fifth note' });
  check(res.json().ok, `the merge went through: ${res.body}`);
  entries = await log();
  eq(entries[0].message, 'Merge draft into main', 'the merge landed');
  eq(entries[0].parents, 2, 'with two parents');
  eq(entries[0].files, ['n4.tex'], 'and names what it brought in');
  check(entries.some((c) => c.message === 'Edit the fifth note'), 'the waiting edit on main took the message');
  meta = await store.readMeta(id);
  meta.manualCommits = false;
  await store.writeMeta(meta);

  // ---- undoing a merge reverts against its first parent ----
  res = await inject('POST', '/revert', { branch: 'main', hashes: [entries[0].hash], message: 'Undo “Merge draft into main”' });
  check(res.json().ok, `a merge can be undone: ${res.body}`);
  eq(read('n4.tex'), 'note 4\n', 'what the merge brought in is gone');
  eq(read('n5.tex'), 'note 5, waiting\n', 'main\'s own edits stay');

  // ---- a conflicted merge into a branch keeps both versions on request ----
  fs.writeFileSync(path.join(dir('draft'), 'n2.tex'), 'note 2 from the draft\n');
  await gitops.commitAll(id, 'draft', 'Draft note 2', 'Ada');
  fs.writeFileSync(path.join(dir(), 'n2.tex'), 'note 2 from main\n');
  await gitops.commitAll(id, 'main', 'Main note 2', 'Ada');
  body = (await inject('POST', '/merge', { from: 'draft', into: 'main' })).json();
  eq(body.ok, false, 'the conflicted merge into main stops');
  eq(body.conflicts, ['n2.tex'], 'and names the file');
  eq(read('n2.tex'), 'note 2 from main\n', 'main is untouched');
  res = await inject('POST', '/merge', { from: 'draft', into: 'main', keepConflicts: true });
  eq(res.statusCode, 400, 'main never takes conflict marks');
  body = (await inject('POST', '/merge', { from: 'main', into: 'draft', keepConflicts: true, author: 'Ada' })).json();
  eq(body.ok, true, 'main came into the draft');
  eq(body.conflicts, ['n2.tex'], 'naming the file that holds both versions');
  const marked = read('n2.tex', 'draft');
  check(marked.includes('<<<<<<<') && marked.includes('note 2 from the draft') && marked.includes('note 2 from main') && marked.includes('>>>>>>>'), `both versions are marked: ${marked}`);
  const draftLog = (await inject('GET', '/log?branch=draft&limit=1')).json();
  eq(draftLog[0].message, 'Merge main into draft', 'the merge is committed on the draft');
  eq((await gitops.uncommittedPaths(id, 'draft')).length, 0, 'nothing is left half-merged');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('history-undo: all assertions passed');
process.exit(0);
