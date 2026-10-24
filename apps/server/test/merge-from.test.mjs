/**
 * Merging takes branch names, nothing git would read as an option or a
 * revision: `from` and `into` follow the rule branch creation enforces, and
 * `from` must be an existing local branch, handed to git as refs/heads/<from>.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore, as a signed-in link visitor (who may edit, so may merge).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-merge-from-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const owner = await auth.register('owner@example.com', 'password123', 'Owner');
const visitor = await auth.register('visitor@example.com', 'password123', 'Visitor');
const cookie = `aldine_session=${await auth.createSession(visitor.id)}`;
const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const meta = await store.createProject('Shared', { 'main.tex': doc }, owner.id);
meta.share = { mode: 'link', collaborators: [] };
await store.writeMeta(meta);
const id = meta.id;
await gitops.createBranch(id, 'draft', 'main');
store.writeFile(id, 'draft', 'chapter.tex', 'new chapter\n');
await gitops.autoCommit(id, 'draft', 'add chapter');

const merge = (from, into = 'main') => app.inject({ method: 'POST', url: `/api/projects/${id}/merge`, headers: { cookie }, payload: { from, into } });
const head = () => store.git(store.repoDir(id)).revparse(['HEAD']);

try {
  const before = await head();
  for (const from of ['--strategy=nope', '--file=/etc/hosts', '-n', 'HEAD~0', 'main^', 'draft..main', '@{-1}', ':/chapter']) {
    const res = await merge(from);
    eq(res.statusCode, 400, `merge from ${JSON.stringify(from)} → 400`);
  }
  for (const into of ['--strategy=nope', 'HEAD~0']) {
    const res = await merge('draft', into);
    eq(res.statusCode, 400, `merge into ${JSON.stringify(into)} → 400`);
  }
  // Names the branch rule allows but that are no local branch.
  for (const from of ['HEAD', 'ORIG_HEAD', 'nope', 'refs/heads/draft']) {
    const res = await merge(from);
    eq(res.statusCode, 200, `merge from ${from} answers`);
    eq(res.json().ok, false, `merge from ${from} is refused: ${res.body}`);
  }
  eq(await head(), before, 'nothing was merged into main');
  let threw = false;
  try { await gitops.merge(id, '--strategy=nope', 'main'); } catch { threw = true; }
  check(threw, 'gitops.merge refuses an option-shaped from on its own');

  const res = await merge('draft');
  eq(res.statusCode, 200, 'merging a real branch answers');
  eq(res.json().ok, true, `merging draft into main works: ${res.body}`);
  eq(store.readFile(id, 'main', 'chapter.tex').toString('utf8'), 'new chapter\n', "draft's file is on main");
  const subject = (await store.git(store.repoDir(id)).raw(['log', '-1', '--format=%s'])).trim();
  eq(subject, 'Merge draft into main', 'the merge commit names the branches');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('merge-from: all assertions passed');
process.exit(0);
