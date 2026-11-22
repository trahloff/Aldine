/**
 * @mentions and assignment on review comments. The people a comment can
 * name are the accounts that can open the project (owner, share entries,
 * share-link members), by name only, never an address. A mention counts
 * only for an account on that list whose `@Name` the text carries. A mention
 * or a new assignment emails the person, except the one who acted and anyone
 * who turned the emails off. /api/for-me lists the open threads that wait on
 * the signed-in account.
 *
 * Real route table (Fastify inject), throwaway JSON datastore, mails read
 * from the no-transport log under ALDINE_TEST_HOOKS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mentions-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
process.env.ALDINE_TEST_HOOKS = '1';
process.env.RL_REGISTER_BURST = '100';
delete process.env.SMTP_HOST;
delete process.env.SES_FROM;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { loggedMailsTo } = await import('../src/email.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const { db } = await import('../src/db/index.ts');
/** A password account with its address confirmed. */
const account = async (email, name) => {
  const u = await auth.register(email, 'password123', name);
  const stored = await db().getUser(u.id);
  delete stored.emailPending;
  await db().updateUser(stored);
  return { ...u, cookie: `aldine_session=${await auth.createSession(u.id)}` };
};
const ada = await account('ada@example.com', 'Ada Owner');
const bea = await account('bea@example.com', 'Bea Editor');
const cy = await account('cy@example.com', 'Cy Linked');
const dee = await account('dee@example.com', 'Dee Outsider');

const doc = '\\documentclass{article}\\begin{document}Hello world\\end{document}\n';
const meta = await store.createProject('Paper', { 'main.tex': doc }, ada.id);
meta.share = {
  collaborators: ['bea@example.com'],
  links: [{ id: '0123456789abcdef', token: 'x'.repeat(43), role: 'review', createdAt: new Date().toISOString(), members: [{ id: cy.id, at: new Date().toISOString() }, { id: 'guest:abc', at: new Date().toISOString(), name: 'Gus' }], guests: true }],
};
await store.writeMeta(meta);
const id = meta.id;

const call = (who, method, url, payload) => app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });
const settle = () => new Promise((r) => setTimeout(r, 100));
const mails = (who) => loggedMailsTo(who.email);

try {
  // ---- the people list ----
  let res = await call(bea, 'GET', `/api/projects/${id}/people`);
  eq(res.statusCode, 200, `a collaborator reads the people list: ${res.body}`);
  const people = res.json();
  eq(people.map((p) => p.name), ['Ada Owner', 'Bea Editor', 'Cy Linked'], 'owner, share entry and link member; no guest, no outsider');
  check(people.every((p) => Object.keys(p).sort().join() === 'id,name'), 'names and ids only, never an address');
  res = await call(dee, 'GET', `/api/projects/${id}/people`);
  check(res.statusCode === 403 || res.statusCode === 404, 'someone without access cannot read it');

  // ---- a mention ----
  res = await call(bea, 'POST', `/api/projects/${id}/comments`, {
    file: 'main.tex', anchor: { from: 38, to: 49, quote: 'Hello world' },
    body: '@Ada Owner can you check this?', mentions: [ada.id, dee.id, cy.id, bea.id],
  });
  eq(res.statusCode, 200, 'the comment is saved');
  const thread = res.json();
  eq(thread.mentions, [ada.id], 'only people on the list whose @Name the text carries count');
  await settle();
  eq(mails(ada).length, 1, 'the mentioned owner gets one email');
  check(mails(ada)[0].subject === 'Bea Editor mentioned you in “Paper”', 'the subject names who and where');
  check(mails(ada)[0].text.includes(`https://aldine.test/p/${id}?comment=${thread.id}`), 'the email links to the thread');
  check(mails(ada)[0].text.includes('Hello world'), 'the email quotes the passage');
  eq(mails(cy).length, 0, 'an id sent without its @Name mails nobody');

  // ---- a reply mention; mentioning yourself mails nobody ----
  res = await call(ada, 'POST', `/api/projects/${id}/comments/${thread.id}/reply`, { body: 'Sure, @Bea Editor and @Ada Owner', mentions: [bea.id, ada.id] });
  eq(res.statusCode, 200, 'the reply is saved');
  eq(res.json().replies[0].mentions, [bea.id, ada.id], 'the reply stores its mentions');
  await settle();
  eq(mails(bea).length, 1, 'the mentioned collaborator gets an email');
  eq(mails(ada).length, 1, 'the author mentioning herself gets none');

  // ---- assignment ----
  res = await call(bea, 'POST', `/api/projects/${id}/comments/${thread.id}/assign`, { to: dee.id });
  eq(res.statusCode, 400, 'someone without access cannot be assigned');
  res = await call(bea, 'POST', `/api/projects/${id}/comments/${thread.id}/assign`, { to: cy.id });
  eq(res.statusCode, 200, 'a link member can be assigned');
  eq([res.json().assignee.id, res.json().assignee.name, res.json().assignee.by], [cy.id, 'Cy Linked', bea.id], 'the assignee and who assigned are stored');
  await settle();
  eq(mails(cy).length, 1, 'the assignee gets an email');
  check(mails(cy)[0].subject === 'Bea Editor assigned you a comment in “Paper”', 'the assignment subject');
  await call(ada, 'POST', `/api/projects/${id}/comments/${thread.id}/assign`, { to: cy.id });
  await settle();
  eq(mails(cy).length, 1, 'assigning the same person again sends nothing');
  res = await call(cy, 'POST', `/api/projects/${id}/comments/${thread.id}/assign`, { to: 42 });
  eq(res.statusCode, 400, 'a malformed assignee is refused');

  // ---- what waits on me ----
  res = await call(cy, 'GET', '/api/for-me');
  eq(res.statusCode, 200, 'for-me answers');
  eq(res.json().map((r) => [r.project.id, r.reason, r.comment.id]), [[id, 'assigned', thread.id]], 'the assignee sees the thread');
  res = await call(ada, 'GET', '/api/for-me');
  eq(res.json().map((r) => r.reason), ['mentioned'], 'the mentioned owner sees it');
  res = await call(dee, 'GET', '/api/for-me');
  eq(res.json(), [], 'an outsider sees nothing');

  // ---- emails off ----
  res = await call(bea, 'PATCH', '/api/auth/me', { commentMail: false });
  eq(res.statusCode, 200, 'the setting saves');
  eq(res.json().user.commentMail, 'off', 'and reads back');
  res = await call(bea, 'PATCH', '/api/auth/me', { commentMail: 'no' });
  eq(res.statusCode, 400, 'only true or false');
  await call(ada, 'POST', `/api/projects/${id}/comments/${thread.id}/reply`, { body: 'Again @Bea Editor', mentions: [bea.id] });
  await settle();
  eq(mails(bea).length, 1, 'no email once they are off');
  eq((await call(bea, 'GET', '/api/auth/me')).json().user.name, 'Bea Editor', 'the name is untouched by the setting');
  await call(bea, 'PATCH', '/api/auth/me', { commentMail: true });
  check((await call(bea, 'GET', '/api/auth/me')).json().user.commentMail === undefined, 'turned back on, the field is gone');

  // ---- unassign, resolve ----
  res = await call(cy, 'POST', `/api/projects/${id}/comments/${thread.id}/assign`, { to: null });
  check(res.json().assignee === undefined, 'null takes the thread off its assignee');
  await call(cy, 'POST', `/api/projects/${id}/comments/${thread.id}/resolve`, { resolved: true });
  res = await call(bea, 'GET', '/api/for-me');
  eq(res.json(), [], 'a resolved thread no longer waits on anyone');

  // ---- For you reads each project's comments once, until a write ----
  await call(bea, 'POST', `/api/projects/${id}/comments/${thread.id}/resolve`, { resolved: false });
  await call(bea, 'POST', `/api/projects/${id}/comments/${thread.id}/assign`, { to: cy.id });
  const store_ = db();
  const real = store_.loadComments.bind(store_);
  let reads = 0;
  store_.loadComments = (pid) => { if (pid === id) reads++; return real(pid); };
  try {
    eq((await call(cy, 'GET', '/api/for-me')).json().length, 1, 'the reopened, assigned thread waits on Cy');
    const first = reads;
    check(first === 1, `after a write the first list reads the project once (read ${first})`);
    await call(cy, 'GET', '/api/for-me');
    await call(ada, 'GET', '/api/for-me');
    eq(reads, first, 'more For you lists read nothing more');
    await call(cy, 'POST', `/api/projects/${id}/comments/${thread.id}/resolve`, { resolved: true });
    eq((await call(cy, 'GET', '/api/for-me')).json(), [], 'a write shows at once');
  } finally { store_.loadComments = real; }

  console.log('comment mentions: ok');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
