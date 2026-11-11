/**
 * The editor's change marks compare against GET /diff-baseline: with
 * automatic commits the newest whole-tree commit a person made on the
 * branch (autosaves, Claude's commits, a file's removal and a project-wide
 * replace never are); with manual commits the branch head. `since` answers
 * without the content while the baseline stands; a path that was no file
 * there answers null content, a binary one `large`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-diff-baseline-'));
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

const project = await store.createProject('Diff Baseline', { 'main.tex': 'one\n', 'chapters/two.tex': 'two\n', 'gone.tex': 'bye\n' });
const id = project.id;
const dir = store.branchDir(id, 'main');
const write = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
const inject = (url) => app.inject({ method: 'GET', url: `/api/projects/${id}${url}` });
const baseline = async (rel, extra = '') => (await inject(`/diff-baseline?branch=main&path=${encodeURIComponent(rel)}${extra}`)).json();
const head = () => gitops.branchHead(id, 'main');

try {
  const initial = await head();
  let b = await baseline('main.tex');
  eq(b, { commit: initial, content: 'one\n' }, 'the first commit is the baseline of a new project');
  eq((await baseline('chapters/two.tex')).content, 'two\n', 'a file in a folder reads from the same commit');

  // ---- autosaves and Claude's commits move the head, not the baseline ----
  write('main.tex', 'one\ntyped\n');
  await gitops.autosave(id, 'main');
  write('main.tex', 'one\ntyped\nby Claude\n');
  await gitops.commitAll(id, 'main', 'Add a line', 'Claude');
  write('main.tex', 'one\ntyped\nby Claude\nagain\n');
  await gitops.commitAll(id, 'main', 'aldine: autosave on shutdown');
  check((await head()) !== initial, 'the head moved');
  eq(await baseline('main.tex'), { commit: initial, content: 'one\n' }, 'autosaves and agent commits are not the baseline');
  eq(await baseline('main.tex', `&since=${initial}`), { commit: initial, unchanged: true }, 'since answers without the content while the baseline stands');

  // ---- a removal and a project-wide replace hold only their paths ----
  const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}/file?branch=main&path=gone.tex&author=Ada` });
  eq(del.statusCode, 200, 'the file is deleted');
  write('chapters/two.tex', 'TWO\n');
  await gitops.commitPaths(id, 'main', ['chapters/two.tex'], 'Replace "two" with "TWO" in chapters/two.tex', 'Ada');
  eq((await baseline('main.tex')).commit, initial, 'neither moves the baseline');

  // ---- a checkpoint does ----
  const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/commit`, payload: { branch: 'main', message: 'Delete the stray line', author: 'Ada' } });
  check(r.json().committed, 'the checkpoint lands, though nothing was left to sweep but its title');
  const checkpoint = await head();
  const again = await app.inject({ method: 'POST', url: `/api/projects/${id}/commit`, payload: { branch: 'main', message: 'Again', author: 'Ada' } });
  eq(again.json(), { committed: false }, 'a second checkpoint with nothing new is not made');
  write('main.tex', 'one\ntyped\nby Claude\nagain\nfleeting\n');
  await gitops.autosave(id, 'main');
  write('main.tex', 'one\ntyped\nby Claude\nagain\n');
  await gitops.autosave(id, 'main');
  const back = await app.inject({ method: 'POST', url: `/api/projects/${id}/commit`, payload: { branch: 'main', message: 'Back', author: 'Ada' } });
  eq(back.json(), { committed: false }, 'nor is one when the autosaves since came back to the checkpoint');
  eq(await baseline('main.tex', `&since=${initial}`), { commit: checkpoint, content: 'one\ntyped\nby Claude\nagain\n' }, 'a checkpoint is the new baseline, whatever its title says');
  eq(await baseline('gone.tex'), { commit: checkpoint, content: null }, 'a file that was not there has no baseline text');
  eq(await baseline('chapters'), { commit: checkpoint, content: null }, 'nor has a folder');

  // a commit asked for under a title or name that is no baseline gets no empty twin
  write('main.tex', 'one\ntyped\nby Claude\nagain\nmore\n');
  const before = (await gitops.log(id, 'main')).length;
  await app.inject({ method: 'POST', url: `/api/projects/${id}/commit`, payload: { branch: 'main', message: 'Claude’s note', author: 'Claude' } });
  await gitops.autosave(id, 'main');
  await app.inject({ method: 'POST', url: `/api/projects/${id}/commit`, payload: { branch: 'main', message: 'aldine: autosave' } });
  eq((await gitops.log(id, 'main')).length, before + 1, 'only the commit that held the edit');
  eq((await baseline('main.tex')).commit, checkpoint, 'and the baseline stays');
  await app.inject({ method: 'POST', url: `/api/projects/${id}/commit`, payload: { branch: 'main', message: 'Keep the note', author: 'Ada' } });

  write('pic.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await gitops.commitAll(id, 'main', 'Add a picture', 'Ada');
  eq(await baseline('pic.bin'), { commit: await head(), content: null, large: true }, 'a binary file is not sent');

  // ---- manual commits: the head, Claude's commits included ----
  const meta = await store.readMeta(id);
  meta.manualCommits = true;
  await store.writeMeta(meta);
  write('main.tex', 'manual\n');
  await gitops.commitAll(id, 'main', 'Rewrite', 'Claude');
  eq(await baseline('main.tex'), { commit: await head(), content: 'manual\n' }, 'with manual commits the head is the baseline');

  // ---- what the route refuses ----
  eq((await inject('/diff-baseline?branch=main&path=../x')).statusCode, 400, 'a path outside the project');
  eq((await inject('/diff-baseline?branch=main')).statusCode, 400, 'no path');
  eq((await inject('/diff-baseline?branch=main&path=.git/config')).statusCode, 403, 'a hidden path');
  eq((await inject('/diff-baseline?branch=-x&path=main.tex')).statusCode, 400, 'a bad branch');
  eq(await baseline('main.tex', '').then(() => inject('/diff-baseline?branch=nope&path=main.tex')).then((res) => res.json()), { commit: null, content: null }, 'a branch with no commit has no baseline');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('diff-baseline: all assertions passed');
process.exit(0);
