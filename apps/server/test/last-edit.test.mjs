/**
 * The last edit a project-list row shows, recorded for every way a project's
 * files change: typing (who sent the last update over the collab socket,
 * since autosave commits are anonymous), uploads, renames, deletes, replace,
 * an accepted suggestion, a reference, a Zotero sync, revert, merge, a pull,
 * a ZIP import, agent writes (named "Claude") and a project the agent
 * creates. A write that changes nothing records nothing. The store sees at
 * most one write per project per autosave window however fast people type,
 * and what it holds is what a restarted server reads, typesets included.
 * Projects from before any of this get a last edit from their git history,
 * in the background, without naming anyone and without overriding one that
 * was recorded.
 *
 * Accounts on, a throwaway JSON datastore, the real route table (Fastify
 * inject) and real collab sockets (HocuspocusProvider over ws, signed in by
 * session cookie). One mock upstream answers the compiler, DOI and Zotero.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import * as Y from 'yjs';
import WS, { WebSocketServer } from 'ws';
import { check, eq } from './assert.mjs';
import { buildZip } from './zip.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-last-edit-')));
const WINDOW_MS = 400;
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = String(WINDOW_MS);
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'REMOTE_PROVIDERS']) delete process.env[k];

const BIB = '@article{Mock_2024, title={A Mock Paper}, author={Doe, Jane}, year={2024} }';
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const json = (v, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(v)); };
    if (req.url === '/compile') return json({ ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, log: 'ok', errors: [], durationMs: 3 });
    if (req.url === `/doi/${encodeURIComponent('10.1234/mock.2')}`) { res.writeHead(200, { 'content-type': 'application/x-bibtex' }); return res.end(BIB.replace('Mock_2024', 'Other_2025').replace('A Mock Paper', 'Another Paper').replace('Doe, Jane', 'Roe, Rita').replace('2024}', '2025}')); }
    if (req.url === `/doi/${encodeURIComponent('10.1234/mock.1')}`) { res.writeHead(200, { 'content-type': 'application/x-bibtex' }); return res.end(BIB); }
    if (req.url === '/zotero/keys/current') return json({ userID: 7, username: 'ada' });
    if (req.url.startsWith('/zotero/users/7/groups')) return json([]);
    if (req.url.startsWith('/zotero/users/7/items/top')) {
      res.writeHead(200, { 'content-type': 'text/plain', 'Last-Modified-Version': '5', 'Total-Results': '1' });
      return res.end('@book{zot1, title={From Zotero}}');
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;
process.env.COMPILER_URL = up;
process.env.DOI_API_BASE = `${up}/doi`;
process.env.ZOTERO_API_BASE = `${up}/zotero`;

const { initDb, db, closeDb } = await import('../src/db/index.ts');
await initDb();
const { JsonStore } = await import('../src/db/json.ts');
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const collab = await import('../src/collab.ts');
const activity = await import('../src/activity.ts');
const remotes = await import('../src/remotes.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { createMcpServer } = await import('../src/mcp/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { HocuspocusProvider, HocuspocusProviderWebsocket } = await import('@hocuspocus/provider');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

// The collab socket, as index.ts serves it.
const wsServer = http.createServer();
const wss = new WebSocketServer({ noServer: true });
wsServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => collab.hocuspocus.handleConnection(ws, req)));
await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
const wsUrl = `ws://127.0.0.1:${wsServer.address().port}/collab`;

const people = {};
for (const [who, name] of [['ada', 'Ada'], ['bob', 'Bob']]) {
  const u = await auth.register(`${who}@example.com`, 'password123', name);
  // Invites by email count once the address is confirmed (email-confirmation.test.mjs).
  await db().setEmailPending(u.id, null);
  delete u.emailPending;
  people[who] = { user: u, cookie: `aldine_session=${await auth.createSession(u.id)}` };
}
const send = (method, url, who, payload) => app.inject({ method, url, headers: { cookie: people[who].cookie }, payload });
const ok = async (method, url, who, payload, what) => {
  const res = await send(method, url, who, payload);
  eq(res.statusCode, 200, `${what}: ${res.body.slice(0, 200)}`);
  return res.json();
};
const lastEdit = async (id, who = 'ada') => (await ok('GET', '/api/projects', who, undefined, 'the list')).find((r) => r.id === id)?.lastEdit ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
/** The step changed the files: a newer last edit, by `by` (a person's key, 'agent' or null), on `branch`. */
async function records(what, id, by, step, branch = 'main') {
  const before = await lastEdit(id);
  await sleep(2);
  await step();
  const after = await lastEdit(id);
  check(after && (!before || after.at > before.at), `${what}: a newer last edit (before ${before?.at}, after ${after?.at})`);
  const want = by === 'agent' ? [null, 'Claude'] : by ? [people[by].user.id, people[by].user.name] : [null, null];
  eq([after.byId, after.byName, after.branch], [...want, branch], `${what}: by ${by ?? 'nobody'} on ${branch}`);
}
async function recordsNothing(what, id, step) {
  const before = await lastEdit(id);
  await sleep(2);
  await step();
  eq(await lastEdit(id), before, `${what}: changes nothing, records nothing`);
}

const sockets = [];
async function connect(who, name) {
  const { cookie } = people[who];
  const Polyfill = class extends WS { constructor(url) { super(url, { headers: { cookie } }); } };
  const document = new Y.Doc();
  const websocketProvider = new HocuspocusProviderWebsocket({ url: wsUrl, WebSocketPolyfill: Polyfill });
  const provider = new HocuspocusProvider({ websocketProvider, name, document, token: 'aldine-session' });
  sockets.push(provider, websocketProvider);
  await until(`${who}'s socket to sync`, () => provider.synced);
  return { provider, text: document.getText('content'), doc: document };
}

const doc = '\\documentclass{article}\n\\begin{document}\nThe needle is here.\n\\end{document}\n';
const sumWrites = [];
const realSetLastEdit = db().setLastEdit.bind(db());
db().setLastEdit = async (projectId, value) => { sumWrites.push({ projectId, value, t: Date.now() }); return realSetLastEdit(projectId, value); };

try {
  const p = await ok('POST', '/api/projects', 'ada', { name: 'Paper', files: { 'main.tex': doc, 'notes.tex': 'notes\n' } }, 'Ada creates the paper');
  const id = p.id;
  const shared = await ok('POST', `/api/projects/${id}/share`, 'ada', { mode: 'private', collaborators: ['bob@example.com'] }, 'Bob is invited');
  await ok('POST', `/api/invitations/${shared.invitations[0].id}/accept`, 'bob', undefined, 'Bob accepts');

  // ---- typing: whoever sent the last update ----
  const created = await lastEdit(id);
  eq([created.byId, created.branch], [people.ada.user.id, 'main'], 'creating the project is its first edit');
  const adaDoc = await connect('ada', collab.docName(id, 'main', 'main.tex'));
  await records('Ada types', id, 'ada', async () => {
    adaDoc.text.insert(0, '% Ada was here\n');
    await until('the server to see Ada\'s update', async () => (await lastEdit(id))?.byId === people.ada.user.id && (await lastEdit(id)).at > created.at);
  });
  const bobDoc = await connect('bob', collab.docName(id, 'main', 'main.tex'));
  await records('Bob types after her', id, 'bob', async () => {
    bobDoc.text.insert(0, '% Bob too\n');
    await until('the server to see Bob\'s update', async () => (await lastEdit(id))?.byId === people.bob.user.id);
  });

  // ---- at most one store write per project per window, however fast the typing ----
  await activity.flushActivity();
  await sleep(WINDOW_MS + 100);
  sumWrites.length = 0;
  const burstStart = Date.now();
  for (let i = 0; i < 40; i++) { bobDoc.text.insert(0, 'x'); await sleep(5); }
  const burstMs = Date.now() - burstStart;
  await until('Bob\'s burst to reach the server', async () => collab.openDocContent(id, 'main', 'main.tex')?.startsWith('x'.repeat(40)));
  await sleep(WINDOW_MS * 2 + 200);
  const ours = sumWrites.filter((w) => w.projectId === id);
  check(ours.length >= 1, 'the burst was written');
  check(ours.length <= Math.floor(burstMs / WINDOW_MS) + 2, `40 updates in ${burstMs} ms made ${ours.length} store writes, not one per keystroke`);
  for (let i = 1; i < ours.length; i++) check(ours[i].t - ours[i - 1].t >= WINDOW_MS - 50, `writes are a window apart: ${ours.map((w) => w.t - ours[0].t).join(', ')} ms`);
  eq(ours.at(-1).value.byId, people.bob.user.id, 'the stored edit is Bob\'s');

  // ---- what the server writes into an open document is the writer's ----
  await records('Ada uploads over the open file', id, 'ada', () => ok('PUT', `/api/projects/${id}/file`, 'ada', { path: 'main.tex', content: doc }, 'the upload'));
  await until('the open document to take the upload', () => collab.openDocContent(id, 'main', 'main.tex') === doc);
  eq((await lastEdit(id)).byId, people.ada.user.id, 'the refresh of Bob\'s open document is not an edit of Bob\'s');

  // ---- signal documents are not edits ----
  const signal = await connect('bob', collab.docName(id, 'main', '.aldine/comment-signal'));
  await recordsNothing('a signal document changes', id, async () => {
    signal.doc.getMap('signal').set('v', Date.now());
    await sleep(150);
  });

  // ---- REST writes ----
  await records('a rename', id, 'ada', () => ok('POST', `/api/projects/${id}/file/rename`, 'ada', { from: 'notes.tex', to: 'notes2.tex' }, 'rename'));
  await records('a delete', id, 'bob', () => ok('DELETE', `/api/projects/${id}/file?path=notes2.tex`, 'bob', undefined, 'delete'));
  await recordsNothing('a delete of a file that is not there', id, () => ok('DELETE', `/api/projects/${id}/file?path=gone.tex`, 'bob', undefined, 'delete of nothing'));
  await records('replace all', id, 'bob', async () => {
    const r = await ok('POST', `/api/projects/${id}/replace`, 'bob', { q: 'needle', replace: 'thread', paths: ['main.tex'] }, 'replace');
    eq(r.replaced, 1, 'one match replaced');
  });
  await recordsNothing('replace with no match', id, () => ok('POST', `/api/projects/${id}/replace`, 'bob', { q: 'absent-word', replace: 'x', paths: ['main.tex'] }, 'replace nothing'));
  const live = collab.openDocContent(id, 'main', 'main.tex');
  const from = live.indexOf('thread');
  const comment = await ok('POST', `/api/projects/${id}/comments`, 'bob', { file: 'main.tex', anchor: { from, to: from + 6, quote: 'thread' }, body: 'better word', suggestion: 'string' }, 'a suggestion');
  await records('an accepted suggestion', id, 'ada', () => ok('POST', `/api/projects/${id}/comments/${comment.id}/accept`, 'ada', { branch: 'main' }, 'accept'));
  await records('a reference', id, 'ada', () => ok('POST', `/api/projects/${id}/references/add`, 'ada', { query: '10.1234/mock.1' }, 'reference'));
  await recordsNothing('the same reference again', id, () => ok('POST', `/api/projects/${id}/references/add`, 'ada', { query: '10.1234/mock.1' }, 'duplicate reference'));
  await records('a Zotero link syncs the library', id, 'ada', () => ok('POST', `/api/projects/${id}/zotero/link`, 'ada', { apiKey: 'zkey', libraryPrefix: 'users/7' }, 'zotero link'));
  await records('a Zotero sync', id, 'bob', () => ok('POST', `/api/projects/${id}/zotero/sync`, 'bob', { force: true }, 'zotero sync'));

  // ---- git: revert, merge ----
  // Under the repo lock, so a debounced autosave cannot sweep the file first.
  const commitFile = (branch, rel, content, message, author) => gitops.withRepoLock(id, async () => {
    fs.writeFileSync(path.join(store.branchDir(id, branch), rel), content);
    const r = await gitops.commitPathsHeld(id, branch, [rel], message, author);
    check(r.committed, `"${message}" committed`);
    return r;
  });
  const agentCommit = await commitFile('main', 'claude.tex', 'agent text\n', 'Add a file', 'Claude');
  await records('a revert', id, 'bob', () => ok('POST', `/api/projects/${id}/revert`, 'bob', { hashes: [agentCommit.hash] }, 'revert'));
  await ok('POST', `/api/projects/${id}/branches`, 'ada', { name: 'feat' }, 'a branch');
  await commitFile('feat', 'feat.tex', 'feature\n', 'Feature', 'Ada');
  await records('a merge', id, 'ada', async () => eq((await ok('POST', `/api/projects/${id}/merge`, 'ada', { from: 'feat', into: 'main' }, 'merge')).ok, true, 'the merge succeeds'));
  await recordsNothing('a merge with nothing new', id, () => ok('POST', `/api/projects/${id}/merge`, 'ada', { from: 'feat', into: 'main' }, 'empty merge'));
  // A merged branch typed on since: the merge's checkpoint brings the edit in.
  fs.writeFileSync(path.join(store.branchDir(id, 'feat'), 'feat.tex'), 'feature, revised\n');
  await records('a merge of edits made after the last merge', id, 'ada', () => ok('POST', `/api/projects/${id}/merge`, 'ada', { from: 'feat', into: 'main' }, 'merge again'));
  eq(store.readFile(id, 'main', 'feat.tex').toString(), 'feature, revised\n', 'the revised file reached main');

  // ---- a pull from the linked remote ----
  const bare = path.join(tmp, 'remote.git');
  execFileSync('git', ['clone', '--bare', '-q', store.repoDir(id), bare]);
  const work = path.join(tmp, 'remote-work');
  execFileSync('git', ['clone', '-q', bare, work]);
  fs.writeFileSync(path.join(work, 'upstream.tex'), 'from the remote\n');
  execFileSync('git', ['add', 'upstream.tex'], { cwd: work });
  execFileSync('git', ['-c', 'user.name=Remote', '-c', 'user.email=r@example.com', 'commit', '-qm', 'Upstream change'], { cwd: work });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: work });
  const meta = await store.readMeta(id);
  meta.remote = { provider: 'github', fullName: 'ada/paper', owner: 'ada', repo: 'paper', remoteBranch: 'main', cloneUrl: `file://${bare}`, connectedBy: people.ada.user.id };
  await store.writeMeta(meta);
  await remotes.setConnection(people.ada.user.id, 'github', { token: 'gh-token', login: 'ada' });
  await records('a pull that brings commits', id, 'ada', () => ok('POST', `/api/projects/${id}/remote/pull`, 'ada', {}, 'pull'));
  check(store.fileExists(id, 'main', 'upstream.tex'), 'the pull brought the remote file');
  await recordsNothing('a pull with nothing new', id, () => ok('POST', `/api/projects/${id}/remote/pull`, 'ada', {}, 'empty pull'));

  // ---- discarding local changes for the remote version ----
  const reset = () => ok('POST', `/api/projects/${id}/remote/reset-to-remote`, 'ada', {}, 'reset to remote');
  await reset();
  await recordsNothing('a reset when nothing differs from the remote', id, reset);
  fs.writeFileSync(path.join(store.branchDir(id, 'main'), 'upstream.tex'), 'an edit not yet saved to git\n');
  await records('a reset that throws away uncommitted edits', id, 'ada', reset);
  eq(store.readFile(id, 'main', 'upstream.tex').toString(), 'from the remote\n', 'the remote version is back');

  // ---- a ZIP import ----
  const zip = buildZip({ 'main.tex': doc });
  const imported = await ok('POST', '/api/projects/import', 'bob', { name: 'Imported', zipBase64: zip.toString('base64') }, 'import');
  eq([imported.id && (await lastEdit(imported.id, 'bob'))?.byId, (await lastEdit(imported.id, 'bob'))?.branch], [people.bob.user.id, 'main'], 'an import is its importer\'s first edit');

  // ---- agent writes ----
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ user: { id: people.ada.user.id, email: 'ada@example.com', name: 'Ada' }, tokenScope: { tokenId: 't1', projectIds: null } }, '').connect(serverSide);
  const client = new Client({ name: 'last-edit-test', version: '0.0.0' });
  await client.connect(clientSide);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
    return JSON.parse(res.content[0].text);
  };
  await records('the agent writes a file', id, 'agent', () => call('write_file', { project: id, path: 'agent.tex', content: 'by the agent\n', message: 'Add agent.tex' }));
  await recordsNothing('the agent writes the same content again', id, () => call('write_file', { project: id, path: 'agent.tex', content: 'by the agent\n' }));
  await records('the agent edits the open file', id, 'agent', () => call('edit_file', { project: id, path: 'main.tex', edits: [{ quote: '\\begin{document}', replacement: '\\begin{document}\n% agent' }], message: 'Annotate' }));
  await records('the agent adds a reference', id, 'agent', () => call('references_add', { project: id, query: '10.1234/mock.2' }));
  const made = await call('create_project', { name: 'Agent paper' });
  eq([(await lastEdit(made.id))?.byId, (await lastEdit(made.id))?.byName], [null, 'Claude'], 'a project the agent creates is the agent\'s first edit');

  // ---- what a restarted server reads ----
  await ok('POST', `/api/projects/${id}/compile`, 'ada', { branch: 'main' }, 'a typeset');
  const shown = await lastEdit(id);
  await activity.flushActivity();
  const reread = new JsonStore(process.env.META_DIR);
  await reread.init();
  const persisted = (await reread.listProjectActivity()).find((a) => a.projectId === id);
  eq(persisted.lastEdit, shown, 'the stored last edit is the one the list shows');
  eq([persisted.compile.main?.status, persisted.compile.main?.errors], ['ok', 0], 'and the typeset is stored too, not only in memory');

  // ---- backfill from git history ----
  const old = await store.createProject('From before', { 'main.tex': doc });
  execFileSync('git', ['checkout', '-q', '-b', 'late'], { cwd: store.repoDir(old.id) });
  fs.writeFileSync(path.join(store.repoDir(old.id), 'late.tex'), 'late\n');
  execFileSync('git', ['add', 'late.tex'], { cwd: store.repoDir(old.id) });
  execFileSync('git', ['commit', '-qm', 'Later work'], { cwd: store.repoDir(old.id), env: { ...process.env, GIT_COMMITTER_DATE: '2027-01-02T03:04:05Z' } });
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: store.repoDir(old.id) });
  const first = (await ok('GET', '/api/projects', 'ada', undefined, 'the list')).find((r) => r.id === old.id);
  eq(first.lastEdit, null, 'the list answers at once, before the history is read');
  await activity.backfillSettled();
  eq(await lastEdit(old.id), { at: '2027-01-02T03:04:05.000Z', byId: null, byName: null, branch: 'late' }, 'then the newest branch tip: its time and branch, nobody named');
  const rows = await ok('GET', '/api/projects', 'ada', undefined, 'the list');
  eq(rows[0].id, old.id, 'and it sorts by that time');

  const recorded = await store.createProject('Recorded', { 'main.tex': doc });
  await ok('PUT', `/api/projects/${recorded.id}/file`, 'ada', { path: 'main.tex', content: `${doc}%\n` }, 'an edit');
  const mine = await lastEdit(recorded.id);
  activity.backfillLastEdits([recorded.id]);
  await activity.backfillSettled();
  await activity.flushActivity();
  eq(await lastEdit(recorded.id), mine, 'a backfill never replaces an edit that was recorded');

  await client.close();
  console.log('✓ last edit: typing, every REST path, git, pull, import, agent, persistence, backfill');
} finally {
  for (const s of sockets) s.destroy();
  await closeDb();
  wss.close();
  wsServer.close();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
