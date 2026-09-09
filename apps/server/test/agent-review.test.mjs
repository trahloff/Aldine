/**
 * The away-review prompt with accounts: GET /agent-activity answers what
 * Claude committed past the caller's mark, POST …/seen records it per user,
 * and an access token can never clear a person's prompt.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore — env must be set before any src import, since AUTH_ENABLED and
 * the data/meta roots are read at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-away-'));
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

const project = await store.createProject('Away Review', { 'main.tex': 'Original line.\n' }, ada.id);
const id = project.id;

/** Commit straight to the branch dir — no collab debounce in a unit test. */
async function commitAs(author, rel, content, message) {
  fs.writeFileSync(path.join(store.branchDir(id, 'main'), rel), content);
  const res = await gitops.commitPaths(id, 'main', [rel], message, author);
  check(res.committed, `commit "${message}" landed`);
  return res.hash;
}

const activity = async (headers = { cookie }, query = 'branch=main') =>
  (await app.inject({ method: 'GET', url: `/api/projects/${id}/agent-activity?${query}`, headers })).json();

const seen = async (body, headers = { cookie }) =>
  app.inject({ method: 'POST', url: `/api/projects/${id}/agent-activity/seen`, headers, payload: body });

// ---- (1) one Claude commit, no mark ----
const h1 = await commitAs('Claude', 'main.tex', 'Claude wrote this.\n', 'Rewrite the opening line');
let a = await activity();
eq(a.commitCount, 1, 'one Claude commit past an empty mark');
eq(a.fileCount, 1, 'one file touched');
eq(a.commits[0].files, ['main.tex'], 'the commit names its file');
eq(a.commits[0].message, 'Rewrite the opening line', 'the commit carries its message');
check(a.since === null, 'no mark yet');
eq(a.head, await gitops.headCommit(id), 'head is the branch head');
check(a.truncated === false, 'a single commit is not truncated');

// ---- (2) the caller's own commits never prompt ----
await commitAs('Ada', 'notes.tex', 'A human note.\n', 'Add a note');
a = await activity();
eq(a.commitCount, 1, "a human commit does not raise the count");
check(a.head !== h1, 'though the head moved');

// ---- (3) acknowledging clears it ----
const headAfterHuman = a.head;
let res = await seen({ branch: 'main', head: headAfterHuman, kind: 'acknowledged' });
eq(res.statusCode, 200, 'seen accepted');
eq(res.json(), { ok: true, stored: true, acknowledged: true }, 'the mark was stored as an acknowledgement');
a = await activity();
eq(a.commitCount, 0, 'nothing is reported at or before the acknowledged head');
eq(a.since.head, headAfterHuman, 'the answer names the mark it used');

// ---- (4) only what is new since the mark ----
const h2 = await commitAs('Claude', 'main.tex', 'Claude wrote this again.\n', 'Refine the opening line');
a = await activity();
eq(a.commitCount, 1, 'the new Claude commit is reported');
eq(a.commits.map((c) => c.hash), [h2], 'and only that one');

// ---- (5) the mark is per user ----
const bob = await auth.register('bob@example.com', 'password123', 'Bob');
const bobCookie = `aldine_session=${await auth.createSession(bob.id)}`;
const meta = await store.readMeta(id);
meta.share = { mode: 'link', collaborators: [] };
await store.writeMeta(meta);
const bobsAnswer = await activity({ cookie: bobCookie });
eq(bobsAnswer.commitCount, 2, "Ada's acknowledgement does not mark the batch seen for Bob");

// ---- (6) an ignored prompt is raised twice, then counts as seen ----
const headNow = a.head;
res = await seen({ branch: 'main', head: headNow, kind: 'prompted' });
eq(res.json(), { ok: true, stored: true, acknowledged: false }, 'the first sighting only records that it was prompted');
eq((await activity()).commitCount, 1, 'a prompted-but-ignored batch is still reported');
res = await seen({ branch: 'main', head: headNow, kind: 'prompted' });
eq(res.json(), { ok: true, stored: true, acknowledged: true }, 'the second sighting of the same head acknowledges it');
eq((await activity()).commitCount, 0, 'and it is never reported again');

// ---- (7) a long agent batch reports a count and caps the diffs ----
for (let i = 0; i < 25; i++) await commitAs('Claude', 'main.tex', `Claude pass ${i}.\n`, `Agent pass ${i}`);
a = await activity();
eq(a.commits.length, 20, 'at most 20 commits carry a hash');
eq(a.commitCount, 25, 'the count is the whole batch');
check(a.truncated === false, '25 commits are well inside the scan ceiling');
eq(a.commits[0].message, 'Agent pass 24', 'newest first');

// ---- (8) a mark whose commit is not on the branch falls back to the date ----
await store.setProjectVisit({
  userId: ada.id, projectId: id, branch: 'main',
  head: 'f'.repeat(40), at: new Date(Date.now() - 3600_000).toISOString(), promptedHead: null,
});
// the date bound is an hour back, so every Claude commit on the branch returns
eq((await activity()).commitCount, 27, 'a stale mark hides nothing');

// ---- (9) an access token cannot clear the prompt ----
const before = await store.getProjectVisit(ada.id, id, 'main');
const { token } = await auth.createAccessToken(ada.id, 'Agent', null, null);
res = await seen({ branch: 'main', head: a.head, kind: 'acknowledged' }, { authorization: `Bearer ${token}` });
eq(res.statusCode, 403, 'a bearer token is refused');
check(res.json().error.includes('Access tokens cannot clear the review prompt'), 'and told why');
eq(await store.getProjectVisit(ada.id, id, 'main'), before, 'the stored mark is untouched');

// ---- (10) branch names are validated on both routes ----
eq((await app.inject({ method: 'GET', url: `/api/projects/${id}/agent-activity?branch=..`, headers: { cookie } })).statusCode, 400, 'GET rejects a bad branch name');
eq((await seen({ branch: '..', head: a.head, kind: 'prompted' })).statusCode, 400, 'POST rejects a bad branch name');
eq((await seen({ branch: 'main', head: 'nope' })).statusCode, 400, 'POST requires a commit-shaped head');

// ---- (11) a project Claude never touched ----
const quiet = await store.createProject('Quiet', { 'main.tex': 'Nothing agentic here.\n' }, ada.id);
const quietAnswer = (await app.inject({ method: 'GET', url: `/api/projects/${quiet.id}/agent-activity?branch=main`, headers: { cookie } })).json();
eq(quietAnswer.commitCount, 0, 'no Claude commits, no prompt');
check(/^[0-9a-f]{40}$/.test(quietAnswer.head), 'and the head is still reported');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('agent-review: ALL PASSED');
