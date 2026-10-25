/**
 * The project list with accounts: each row says why the caller sees it
 * (access), when they last opened it and on which branch (opened), the last
 * typeset of that branch (compile) and the last edit; the list is sorted by
 * the last edit. A link-shared project is listed for someone who opened it
 * through the link until they remove it; an invited member can remove a
 * project from their list without losing access; the owner cannot. Duplicate
 * copies the main working tree and nothing else. Trash rows say when they are
 * purged, and a purge takes the project's list rows with it.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore; the compiler is a mock that answers whatever the test queues.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-project-list-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
process.env.COPY_MAX_BYTES = String(1024 * 1024);
process.env.RL_COPY_BURST = '6';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'ALDINE_TRASH_DAYS']) delete process.env[k];

const queue = [];
const compiler = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const buf = Buffer.from(JSON.stringify(queue.shift() ?? { ok: false, error: 'mock queue empty' }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
});
await new Promise((r) => compiler.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${compiler.address().port}`;

const { initDb, db, closeDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { flushActivity } = await import('../src/activity.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const people = {};
for (const [who, name] of [['ada', 'Ada'], ['bob', 'Bob'], ['carol', 'Carol'], ['dana', 'Dana']]) {
  const u = await auth.register(`${who}@example.com`, 'password123', name);
  // Invites by email count once the address is confirmed (email-confirmation.test.mjs).
  await db().setEmailPending(u.id, null);
  delete u.emailPending;
  people[who] = { user: u, headers: { cookie: `aldine_session=${await auth.createSession(u.id)}` } };
}
const { token } = await auth.createAccessToken(people.ada.user.id, 'agent', null, null);
const bearer = { authorization: `Bearer ${token}` };

const send = (method, url, who, payload) => app.inject({ method, url, headers: who === null ? {} : (typeof who === 'string' ? people[who].headers : who), payload });
const list = async (who) => {
  const res = await send('GET', '/api/projects', who);
  eq(res.statusCode, 200, `the list answers ${who}`);
  return res.json();
};
const row = async (who, id) => (await list(who)).find((r) => r.id === id);
const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const create = async (name) => {
  const res = await send('POST', '/api/projects', 'ada', { name, files: { 'main.tex': doc } });
  eq(res.statusCode, 200, `creating ${name}`);
  return res.json();
};

try {
  // ---- rows carry the new fields, newest edit first ----
  const p1 = await create('First');
  const p2 = await create('Second');
  let rows = await list('ada');
  eq(rows.map((r) => r.id), [p2.id, p1.id], 'the newest project leads');
  for (const r of rows) {
    eq(r.access, 'owner', `${r.name}: the owner sees it as the owner`);
    eq(r.opened, null, `${r.name}: never opened`);
    eq(r.compile, null, `${r.name}: never typeset`);
    eq([r.lastEdit.byId, r.lastEdit.byName, r.lastEdit.branch], [people.ada.user.id, 'Ada', 'main'], `${r.name}: creating it is its first edit, by Ada`);
  }

  const put = await send('PUT', `/api/projects/${p1.id}/file`, 'ada', { path: 'main.tex', content: `${doc}% more\n` });
  eq(put.statusCode, 200, 'the upload is accepted');
  rows = await list('ada');
  eq(rows.map((r) => r.id), [p1.id, p2.id], 'an edit moves the older project to the top');
  check(rows[0].lastEdit.at > rows[1].lastEdit.at, 'its last edit is the newer one');

  // ---- POST /opened ----
  let res = await send('POST', `/api/projects/${p1.id}/opened`, 'ada', { branch: 'main' });
  eq(res.statusCode, 200, 'opening is recorded');
  const openedAt = res.json().opened.at;
  eq(res.json().opened.branch, 'main', 'on the branch given');
  eq((await row('ada', p1.id)).opened, { at: openedAt, branch: 'main' }, 'the row carries the open');
  eq((await list('ada')).map((r) => r.id), [p1.id, p2.id], 'opening does not reorder the list');
  eq((await send('POST', `/api/projects/${p1.id}/opened`, 'ada', { branch: '../x' })).statusCode, 400, 'a malformed branch is refused');
  eq((await send('POST', `/api/projects/${p1.id}/opened`, 'ada', { branch: 'nope' })).statusCode, 404, 'a branch that does not exist is refused');
  eq((await send('POST', `/api/projects/${p1.id}/opened`, 'ada', {})).json().opened.branch, 'main', 'no branch means main');

  eq((await send('POST', `/api/projects/${p1.id}/branches`, 'ada', { name: 'draft' })).statusCode, 200, 'a branch is made');
  await send('POST', `/api/projects/${p1.id}/opened`, 'ada', { branch: 'draft' });
  eq((await row('ada', p1.id)).opened.branch, 'draft', 'a branch switch is recorded');

  // ---- compile: the opened branch's last typeset ----
  queue.push({ ok: false, pdf: null, log: '! Undefined control sequence.', durationMs: 5, errors: [
    { type: 'error', line: 1, message: 'Undefined control sequence' }, { type: 'error', line: 2, message: 'Missing $' }, { type: 'warning', line: 3, message: 'Overfull' },
  ] });
  eq((await send('POST', `/api/projects/${p1.id}/compile`, 'ada', { branch: 'draft' })).statusCode, 200, 'draft typesets (with errors)');
  queue.push({ ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, log: 'ok', errors: [], durationMs: 5 });
  await send('POST', `/api/projects/${p1.id}/compile`, 'ada', { branch: 'main' });
  let r1 = await row('ada', p1.id);
  eq([r1.compile.status, r1.compile.errors, r1.compile.branch], ['error', 2, 'draft'], 'the row shows the opened branch, counting error rows only');
  check(typeof r1.compile.at === 'string' && !Number.isNaN(Date.parse(r1.compile.at)), 'with the time it finished');
  await send('POST', `/api/projects/${p1.id}/opened`, 'ada', { branch: 'main' });
  r1 = await row('ada', p1.id);
  eq([r1.compile.status, r1.compile.errors, r1.compile.branch], ['ok', 0, 'main'], 'back on main, main\'s typeset');
  eq((await row('ada', p2.id)).compile, null, 'a project never opened shows main, which never typeset');

  // A deleted branch takes its typeset with it, and an open of it points at main.
  await send('POST', `/api/projects/${p1.id}/opened`, 'ada', { branch: 'draft' });
  eq((await send('DELETE', `/api/projects/${p1.id}/branches?name=draft`, 'ada')).statusCode, 200, 'the branch is deleted');
  r1 = await row('ada', p1.id);
  eq(r1.opened.branch, 'main', 'the open of the deleted branch now names main');
  eq(r1.compile.branch, 'main', 'and the row shows main\'s typeset');
  await flushActivity();
  const stored = (await db().listProjectActivity()).find((a) => a.projectId === p1.id);
  eq(Object.keys(stored.compile), ['main'], 'the deleted branch\'s mark is gone from the store');
  eq(stored.lastEdit.byId, people.ada.user.id, 'the stored last edit names Ada');

  // ---- who may use the new routes ----
  for (const [method, url, payload] of [['POST', `/api/projects/${p1.id}/opened`, { branch: 'main' }], ['DELETE', `/api/projects/${p1.id}/listing`], ['POST', `/api/projects/${p1.id}/copy`, {}]]) {
    eq((await send(method, url, null, payload)).statusCode, 401, `${method} ${url.split('/').pop()}: signed out is 401`);
    eq((await send(method, url, 'bob', payload)).statusCode, 403, `${method} ${url.split('/').pop()}: a stranger to a private project is 403`);
    eq((await send(method, url, bearer, payload)).statusCode, 403, `${method} ${url.split('/').pop()}: an access token is 403 (the list is the person's)`);
  }
  const viaToken = await send('GET', '/api/projects', bearer);
  eq(viaToken.statusCode, 200, 'an unscoped token still reads the list');
  eq(viaToken.json().find((r) => r.id === p1.id).opened?.branch, 'main', 'with its person\'s opens');

  // ---- a link visitor: listed once they opened it, until they remove it ----
  eq((await send('POST', `/api/projects/${p2.id}/share`, 'ada', { mode: 'link', collaborators: ['dana@example.com'] })).statusCode, 200, 'P2 is link-shared, Dana invited');
  check(!(await row('carol', p2.id)), 'a link-shared project is not on a stranger\'s list');
  eq((await send('GET', `/api/projects/${p2.id}`, 'carol')).statusCode, 200, 'the link opens it');
  check(!(await row('carol', p2.id)), 'reading it is not opening it');
  eq((await send('POST', `/api/projects/${p2.id}/opened`, 'carol', { branch: 'main' })).statusCode, 200, 'Carol opens it in the editor');
  let c2 = await row('carol', p2.id);
  eq(c2.access, 'link', 'now it is on her list, through the link');
  eq(c2.isMember, false, 'she is still not a member');
  eq(c2.opened.branch, 'main', 'with her open');
  eq(c2.share.collaborators, [], 'and without the invite list');
  eq((await row('ada', p2.id)).opened, null, 'Carol\'s open is hers, not Ada\'s');

  eq((await send('DELETE', `/api/projects/${p2.id}/listing`, 'carol')).statusCode, 200, 'Carol removes it from her list');
  check(!(await row('carol', p2.id)), 'it is gone from her list');
  check((await db().getProjectOpen(people.carol.user.id, p2.id)) === null, 'and her row with it');
  eq((await send('GET', `/api/projects/${p2.id}`, 'carol')).statusCode, 200, 'the link still opens it');
  await send('POST', `/api/projects/${p2.id}/opened`, 'carol', { branch: 'main' });
  eq((await row('carol', p2.id))?.access, 'link', 'opening it again lists it again');

  await send('POST', `/api/projects/${p2.id}/share`, 'ada', { mode: 'private', collaborators: ['dana@example.com'] });
  check(!(await row('carol', p2.id)), 'when the link stops working, the project leaves her list');
  eq((await send('POST', `/api/projects/${p2.id}/opened`, 'carol', { branch: 'main' })).statusCode, 403, 'and she cannot open it');

  // ---- an invited member hides it and keeps access ----
  let d2 = await row('dana', p2.id);
  eq(d2.access, 'member', 'Dana sees it as a member without opening it');
  eq(d2.opened, null, 'never opened');
  await send('POST', `/api/projects/${p2.id}/opened`, 'dana', { branch: 'main' });
  const danaOpen = (await row('dana', p2.id)).opened;
  eq((await send('DELETE', `/api/projects/${p2.id}/listing`, 'dana')).statusCode, 200, 'Dana removes it from her list');
  check(!(await row('dana', p2.id)), 'it is off her list');
  eq((await send('GET', `/api/projects/${p2.id}`, 'dana')).statusCode, 200, 'she keeps access');
  eq(await db().getProjectOpen(people.dana.user.id, p2.id), { userId: people.dana.user.id, projectId: p2.id, at: danaOpen.at, branch: 'main', hidden: true }, 'her row keeps the open and says hidden');
  await send('POST', `/api/projects/${p2.id}/opened`, 'dana', { branch: 'main' });
  d2 = await row('dana', p2.id);
  eq(d2.access, 'member', 'opening it again brings it back');
  check(d2.opened.at >= danaOpen.at, 'with the new open');

  // ---- the owner cannot remove their own project ----
  res = await send('DELETE', `/api/projects/${p1.id}/listing`, 'ada');
  eq(res.statusCode, 400, 'the owner is refused');
  check(/trash/.test(res.json().error), `and told to use the trash: ${res.json().error}`);
  check(!!(await row('ada', p1.id)), 'the project stays listed');

  // ---- Duplicate ----
  const mainDir = store.branchDir(p2.id, 'main');
  fs.writeFileSync(path.join(mainDir, 'notes.txt'), 'not committed yet\n');
  fs.mkdirSync(path.join(mainDir, 'fig'), { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
  fs.writeFileSync(path.join(mainDir, 'fig', 'plot.png'), png);
  fs.mkdirSync(path.join(mainDir, '.aldine-out'), { recursive: true });
  fs.writeFileSync(path.join(mainDir, '.aldine-out', 'main.pdf'), '%PDF-1.5 old');
  await send('POST', `/api/projects/${p2.id}/branches`, 'ada', { name: 'side' });
  fs.writeFileSync(path.join(store.branchDir(p2.id, 'side'), 'side-only.tex'), 'side\n');
  const m2 = await store.readMeta(p2.id);
  Object.assign(m2, {
    engine: 'xelatex', stopOnFirstError: true, autopush: true,
    zotero: { apiKey: 'secret-key', userId: 1, libraryPrefix: 'users/1', bibFile: 'zotero.bib' },
    remote: { provider: 'github', fullName: 'ada/second', owner: 'ada', repo: 'second', remoteBranch: 'main', cloneUrl: 'https://github.com/ada/second.git' },
  });
  await store.writeMeta(m2);

  res = await send('POST', `/api/projects/${p2.id}/copy`, 'ada', {});
  eq(res.statusCode, 200, 'Ada duplicates P2');
  const copy = res.json();
  check(copy.id && copy.id !== p2.id, 'a new project');
  eq(copy.name, 'Second copy', 'named "<name> copy"');
  eq([copy.access, copy.isOwner, copy.ownerId], ['owner', true, people.ada.user.id], 'owned by the caller');
  eq(copy.share, { mode: 'private', collaborators: [] }, 'with no share settings');
  eq(copy.zotero, null, 'no Zotero link');
  check(!copy.remote && !copy.github && !copy.autopush, 'no remote link and no autopush');
  eq([copy.engine, copy.stopOnFirstError, copy.rootFile], ['xelatex', true, 'main.tex'], 'the typesetting settings come along');
  eq([copy.lastEdit.byId, copy.lastEdit.branch, copy.opened, copy.compile], [people.ada.user.id, 'main', null, null], 'the answer is a list row');
  const copied = store.listFiles(copy.id, 'main').filter((f) => f.type === 'file').map((f) => f.path).sort();
  eq(copied, ['.gitignore', 'fig/plot.png', 'main.tex', 'notes.txt'], 'the main working tree, uncommitted file included, no other branch, no build output');
  eq(store.readFile(copy.id, 'main', 'fig/plot.png'), png, 'binary files byte for byte');
  eq(store.readFile(copy.id, 'main', 'main.tex').toString(), doc, 'text files as they are');
  eq((await gitops.log(copy.id, 'main')).length, 1, 'one commit, no history');
  eq((await gitops.listBranches(copy.id)).map((b) => b.name), ['main'], 'main only');
  eq((await list('ada'))[0].id, copy.id, 'the copy leads the list');

  eq((await send('POST', `/api/projects/${p2.id}/copy`, 'ada', { name: '  Revised  ' })).json().name, 'Revised', 'a name is trimmed');
  eq((await send('POST', `/api/projects/${p2.id}/copy`, 'ada', { name: '   ' })).json().name, 'Second copy', 'a blank name is the default');
  eq((await send('POST', `/api/projects/${p2.id}/copy`, 'ada', { name: 42 })).statusCode, 400, 'a name that is not text is refused');
  eq((await send('POST', `/api/projects/${p2.id}/copy`, 'ada', { name: 'x'.repeat(201) })).statusCode, 400, 'a name over 200 characters is refused');

  // Anyone who may download the source may copy it, and owns the copy.
  await send('POST', `/api/projects/${p2.id}/share`, 'ada', { mode: 'link', collaborators: [] });
  res = await send('POST', `/api/projects/${p2.id}/copy`, 'carol', {});
  eq(res.statusCode, 200, 'a link visitor duplicates it');
  const carolsCopy = res.json();
  eq([carolsCopy.ownerId, carolsCopy.access], [people.carol.user.id, 'owner'], 'and owns the copy');
  eq((await row('carol', carolsCopy.id))?.access, 'owner', 'on her list as hers');
  check(!(await row('ada', carolsCopy.id)), 'not on Ada\'s');
  eq((await send('GET', `/api/projects/${carolsCopy.id}`, 'ada')).statusCode, 403, 'and closed to Ada');

  // A copy is bounded: by size, and by how often one person may make one.
  fs.writeFileSync(path.join(store.branchDir(carolsCopy.id, 'main'), 'big.bin'), Buffer.alloc(1024 * 1024 + 1));
  const before = fs.readdirSync(process.env.DATA_DIR + '/projects').length;
  eq((await send('POST', `/api/projects/${carolsCopy.id}/copy`, 'carol', {})).statusCode, 413, 'a project over the size cap is not copied');
  eq(fs.readdirSync(process.env.DATA_DIR + '/projects').length, before, 'and leaves nothing on disk');
  let codes = [];
  for (let i = 0; i < 6; i++) codes.push((await send('POST', `/api/projects/${p2.id}/copy`, 'carol', {})).statusCode);
  eq(codes.slice(0, 4), [200, 200, 200, 200], 'Carol copies until her burst is spent');
  eq(codes.slice(4), [429, 429], 'then the copy route refuses');

  // ---- trash: purgeAt ----
  eq((await send('DELETE', `/api/projects/${p1.id}`, 'ada')).statusCode, 200, 'P1 goes to the trash');
  const trashed = (await send('GET', '/api/projects/trash', 'ada')).json().find((t) => t.id === p1.id);
  eq(trashed.purgeAt, new Date(Date.parse(trashed.deletedAt) + 30 * 864e5).toISOString(), 'purgeAt is 30 days after the trashing');
  eq((await send('POST', `/api/projects/${p1.id}/copy`, 'ada', {})).statusCode, 404, 'a trashed project cannot be copied');
  eq((await send('POST', `/api/projects/${p1.id}/opened`, 'ada', { branch: 'main' })).statusCode, 404, 'nor opened');

  // ---- a purge takes the list rows with it ----
  await send('POST', `/api/projects/${p2.id}/opened`, 'carol', { branch: 'main' });
  await flushActivity();
  check((await db().listProjectActivity()).some((a) => a.projectId === p2.id), 'P2 has stored activity');
  eq((await send('DELETE', `/api/projects/${p2.id}?permanent=1`, 'ada')).statusCode, 200, 'P2 is deleted for good');
  check((await db().getProjectOpen(people.carol.user.id, p2.id)) === null, 'Carol\'s open of it is gone');
  check((await db().getProjectOpen(people.dana.user.id, p2.id)) === null, 'and Dana\'s');
  check(!(await db().listProjectActivity()).some((a) => a.projectId === p2.id), 'and its activity');
  console.log('✓ project list: rows, opens, link listing, removal, duplicate, trash and purge');
} finally {
  await closeDb();
  compiler.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
