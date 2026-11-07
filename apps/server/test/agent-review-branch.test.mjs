/**
 * The review prompt across branches, with accounts: a revert only ever undoes
 * commits in the branch's own history, and a new branch starts with its
 * creator's review mark from the branch it was made from.
 *
 * Real route table (Fastify inject) on a throwaway datastore; env is set
 * before any src import, since AUTH_ENABLED and the roots are read at load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-review-branch-'));
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

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const cookie = `aldine_session=${await auth.createSession(ada.id)}`;
const project = await store.createProject('Review Across Branches', { 'main.tex': 'Original line.\n' }, ada.id);
const id = project.id;

async function commitAs(branch, author, rel, content, message) {
  fs.writeFileSync(path.join(store.branchDir(id, branch), rel), content);
  const res = await gitops.commitPaths(id, branch, [rel], message, author);
  check(res.committed, `commit "${message}" landed on ${branch}`);
  return res.hash;
}
const inject = (method, tail, payload, headers = { cookie }) =>
  app.inject({ method, url: `/api/projects/${id}/${tail}`, headers, payload });
const activity = async (branch, headers = { cookie }) => (await inject('GET', `agent-activity?branch=${branch}`, undefined, headers)).json();
const revert = (branch, hashes) => inject('POST', 'revert', { branch, hashes });

// ---- a new branch starts with its creator's mark ----
await commitAs('main', 'Claude', 'main.tex', 'Claude wrote this.\n', 'Rewrite the opening line');
let a = await activity('main');
eq(a.commitCount, 1, 'one Claude commit on main');
eq((await inject('POST', 'agent-activity/seen', { branch: 'main', head: a.head, kind: 'acknowledged' })).statusCode, 200, 'Ada acknowledges it');
eq((await activity('main')).commitCount, 0, 'main has nothing left to review');

eq((await inject('POST', 'branches', { name: 'camera-ready', from: 'main' })).statusCode, 200, 'Ada creates a branch');
a = await activity('camera-ready');
eq(a.commitCount, 0, 'the new branch does not prompt for work reviewed on main');
eq(a.since && a.since.head, (await store.getProjectVisit(ada.id, id, 'main')).head, "against main's mark");

const bob = await auth.register('bob@example.com', 'password123', 'Bob');
const bobCookie = `aldine_session=${await auth.createSession(bob.id)}`;
const meta = await store.readMeta(id);
meta.share = { mode: 'link', collaborators: [] };
await store.writeMeta(meta);
eq(await store.getProjectVisit(bob.id, id, 'camera-ready'), null, "Ada's mark is not copied for Bob, who never reviewed it");
eq((await activity('camera-ready', { cookie: bobCookie })).commitCount, 0, "Bob's first open starts his own mark (agent-review-first-open.test.mjs)");

// unreviewed work on the base stays unreviewed on the new branch
await commitAs('main', 'Claude', 'main.tex', 'Claude wrote this again.\n', 'Refine the opening line');
eq((await inject('POST', 'branches', { name: 'draft-2', from: 'main' })).statusCode, 200, 'a second branch from main');
a = await activity('draft-2');
eq(a.commits.map((c) => c.message), ['Refine the opening line'], 'only the commit Ada has not reviewed is reported');

// ---- a revert refuses commits that are not in the branch's history ----
const onSide = await commitAs('camera-ready', 'Claude', 'main.tex', 'Claude tightened this on the branch.\n', 'Tighten the opening line');
const mainBefore = (await gitops.log(id, 'main'))[0].hash;
let res = await revert('main', [onSide]);
eq(res.statusCode, 400, "a commit from another branch is refused on main");
const refused = res.json().error;
eq(refused, `Could not revert "Tighten the opening line" (${onSide.slice(0, 7)}) — it is not on main. Open the branch it was made on and revert it there`, 'and the sentence names the commit and what to do');
eq((await gitops.log(id, 'main'))[0].hash, mainBefore, 'nothing was committed on main');
eq(fs.readFileSync(path.join(store.branchDir(id, 'main'), 'main.tex'), 'utf8'), 'Claude wrote this again.\n', 'and its files are untouched');

const onMain = (await gitops.log(id, 'main'))[0].hash;
res = await revert('main', [onMain, onSide, 'abcdef1']);
eq(res.statusCode, 400, 'a mixed batch is refused as a whole');
check(res.json().error.startsWith(`Could not revert "Tighten the opening line" (${onSide.slice(0, 7)}) and 1 more — they are not on main.`), `and counts the rest: ${res.json().error}`);
eq((await gitops.log(id, 'main'))[0].hash, mainBefore, 'still nothing committed');

// ---- a commit on the branch still reverts, with the same answer as before ----
res = await revert('camera-ready', [onSide]);
eq(res.statusCode, 200, 'the same commit reverts on its own branch');
const body = res.json();
eq(Object.keys(body).sort(), ['author', 'hash', 'ok'], 'the success answer keeps its fields');
check(body.ok === true && /^[0-9a-f]{40}$/.test(body.hash), 'and names the revert commit');
eq(fs.readFileSync(path.join(store.branchDir(id, 'camera-ready'), 'main.tex'), 'utf8'), 'Claude wrote this.\n', 'the branch is back to what it was');

// ---- a mark on a commit the branch does not have falls back to its date ----
// The commit still exists (a branch reset or recreated under the old name),
// so it must not bound a range: everything on main it can reach would hide.
const cy = await auth.register('cy@example.com', 'password123', 'Cy');
const cyCookie = `aldine_session=${await auth.createSession(cy.id)}`;
await store.setProjectVisit({
  userId: cy.id, projectId: id, branch: 'main',
  head: onSide, at: new Date(Date.now() - 3600_000).toISOString(), promptedHead: null,
});
a = await activity('main', { cookie: cyCookie });
eq(a.commits.map((c) => c.message), ['Refine the opening line', 'Rewrite the opening line'], "a mark off the branch hides none of main's Claude commits from the last hour");

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('agent-review-branch: ALL PASSED');
