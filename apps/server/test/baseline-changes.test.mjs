/**
 * The file tree's change marks read GET /baseline-changes: the files that
 * differ on disk from the editor gutter's diff baseline (the last
 * checkpoint, or the head with manual commits), autosaved or not, with
 * untracked files as added and build output and hidden paths left out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-baseline-changes-'));
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

const project = await store.createProject('Baseline Changes', { 'main.tex': 'one\n', 'chapters/two.tex': 'two\n', 'gone.tex': 'bye\n' });
const id = project.id;
const dir = store.branchDir(id, 'main');
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const changes = async (branch = 'main') => {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/baseline-changes?branch=${branch}` });
  return res.statusCode === 200 ? res.json() : res.statusCode;
};
const byPath = (r) => Object.fromEntries(r.files.map((f) => [f.path, f.status]).sort());

try {
  const initial = await gitops.branchHead(id, 'main');
  eq(await changes(), { commit: initial, files: [] }, 'a new project has nothing changed');

  // ---- typing not yet autosaved, then autosaved: the same marks ----
  write('main.tex', 'one\ntyped\n');
  write('chapters/new.tex', 'new\n');
  fs.rmSync(path.join(dir, 'gone.tex'));
  let r = await changes();
  eq(r.commit, initial, 'the baseline is the gutter\'s');
  eq(byPath(r), { 'chapters/new.tex': 'added', 'gone.tex': 'deleted', 'main.tex': 'modified' }, 'edits on disk count before any autosave');
  await gitops.autosave(id, 'main');
  eq(byPath(await changes()), { 'chapters/new.tex': 'added', 'gone.tex': 'deleted', 'main.tex': 'modified' }, 'and after one: an autosave is no baseline');
  write('main.tex', 'one\n');
  await gitops.autosave(id, 'main');
  eq(byPath(await changes()), { 'chapters/new.tex': 'added', 'gone.tex': 'deleted' }, 'a file typed back to its baseline text is unmarked');

  // ---- build output and hidden paths never show ----
  write('.aldine-out/main.pdf', '%PDF');
  write('.aldine/notes.json', '{}');
  eq(Object.keys(byPath(await changes())).sort(), ['chapters/new.tex', 'gone.tex'], 'neither the output folder nor a hidden path');

  // ---- a checkpoint clears them ----
  const cp = await app.inject({ method: 'POST', url: `/api/projects/${id}/commit`, payload: { branch: 'main', message: 'Add a chapter', author: 'Ada' } });
  check(cp.json().committed, 'the checkpoint lands');
  r = await changes();
  eq(r.commit, await gitops.branchHead(id, 'main'), 'the checkpoint is the new baseline');
  eq(r.files, [], 'and nothing differs from it');

  // ---- manual commits: against the head ----
  const meta = await store.readMeta(id);
  meta.manualCommits = true;
  await store.writeMeta(meta);
  write('chapters/two.tex', 'TWO\n');
  eq(byPath(await changes()), { 'chapters/two.tex': 'modified' }, 'an uncommitted edit with manual commits');
  await gitops.commitAll(id, 'main', 'Shout', 'Claude');
  eq(await changes().then((x) => x.files), [], 'any commit is the baseline with manual commits');

  // ---- what the route refuses ----
  eq(await changes('-x'), 400, 'a bad branch');
  eq(await changes('a..b'), 400, 'a branch with ..');
  eq(await changes('nope'), { commit: null, files: [] }, 'a branch with no commit has nothing to mark');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('baseline-changes: all assertions passed');
process.exit(0);
