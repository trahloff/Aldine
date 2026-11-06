/**
 * A person who first opens someone else's project starts their review of
 * Claude's work there: the commits Claude made before they came are not put
 * to them (nor offered for revert). Their own first GET of /agent-activity
 * records the branch head as seen, per branch; what Claude does afterwards
 * is reviewed as usual. The owner's first open keeps the whole branch, and an
 * access token never sets a person's mark.
 *
 * Real route table (Fastify inject) on a throwaway datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-first-open-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);

const person = async (email, name) => {
  const u = await auth.register(email, 'password123', name);
  await db().setEmailPending(u.id, null);
  return { id: u.id, cookie: `aldine_session=${await auth.createSession(u.id)}` };
};
const ada = await person('ada@example.com', 'Ada');
const bob = await person('bob@example.com', 'Bob');
const cy = await person('cy@example.com', 'Cy');

const project = await store.createProject('Shared Review', { 'main.tex': 'Original line.\n' }, ada.id);
const id = project.id;
await store.writeMeta({ ...(await store.readMeta(id)), share: { mode: 'link', collaborators: ['bob@example.com', 'cy@example.com'] } });

async function commitAs(author, content, message) {
  fs.writeFileSync(path.join(store.branchDir(id, 'main'), 'main.tex'), content);
  const res = await gitops.commitPaths(id, 'main', ['main.tex'], message, author);
  check(res.committed, `commit "${message}" landed`);
  return res.hash;
}
const activity = async (headers) => (await app.inject({ method: 'GET', url: `/api/projects/${id}/agent-activity?branch=main`, headers })).json();

// Months of Claude's work before Bob and Cy were invited.
await commitAs('Claude', 'One.\n', 'First pass');
const before = await commitAs('Claude', 'Two.\n', 'Second pass');

// ---- a token cannot stand in for the person ----
const { token } = await auth.createAccessToken(cy.id, 'Agent', null, null);
eq((await activity({ authorization: `Bearer ${token}` })).commitCount, 2, "a token's read shows the whole branch");
eq(await store.getProjectVisit(cy.id, id, 'main'), null, 'and records nothing for Cy');

// ---- a member's first open ----
let a = await activity({ cookie: bob.cookie });
eq([a.commitCount, a.since?.head], [0, before], "Bob's first open asks nothing: the head is his starting point");
eq((await store.getProjectVisit(bob.id, id, 'main'))?.head, before, 'and the mark is stored');

// ---- what Claude does next is his to review ----
const after = await commitAs('Claude', 'Three.\n', 'Third pass');
a = await activity({ cookie: bob.cookie });
eq([a.commitCount, a.commits.map((c) => c.hash)], [1, [after]], 'the next Claude commit is put to Bob');

// ---- the owner's first open keeps the whole branch ----
a = await activity({ cookie: ada.cookie });
eq(a.commitCount, 3, "the owner's first open covers everything Claude did");
eq(await store.getProjectVisit(ada.id, id, 'main'), null, 'and marks nothing by itself');

// ---- per branch: another branch's first open starts there too ----
await gitops.createBranch(id, 'draft', 'main');
a = (await app.inject({ method: 'GET', url: `/api/projects/${id}/agent-activity?branch=draft`, headers: { cookie: bob.cookie } })).json();
eq(a.commitCount, 0, "Bob's first open of another branch starts there");

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('agent review first open: ok');
process.exit(0);
