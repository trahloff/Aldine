/**
 * The agent's review comments and git sync tools: add_comment anchors by
 * quote and shows under "Claude (for …)", list/reply/resolve work on the same
 * threads the editor shows, assign_comment picks a person by name, a "Can view" person may not comment; push and pull
 * go through the project's linked repository (a file:// bare repo here) with
 * the same membership rule as the Sync menu, a conflicting pull changes
 * nothing, and an unlinked project says so.
 *
 * In-memory MCP transport against real stores; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mcp-comments-sync-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL', 'REMOTE_PROVIDERS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const remotes = await import('../src/remotes.ts');
const comments = await import('../src/comments.ts');
const { createMcpServer } = await import('../src/mcp/server.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const vic = await auth.register('vic@example.com', 'password123', 'Vic');
await db().setEmailPending(vic.id, null);
const nora = await auth.register('nora@example.com', 'password123', 'Nora');

const connect = async (user) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ user: { id: user.id, email: user.email, name: user.name }, tokenScope: { tokenId: `t-${user.id}`, projectIds: null } }, '').connect(serverSide);
  const client = new Client({ name: 'comments-sync-test', version: '0.0.0' });
  await client.connect(clientSide);
  return async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { isError: !!res.isError, body };
  };
};
// without ALDINE_MCP_SYNC the sync tools do not exist
{
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ user: { id: ada.id, email: ada.email, name: ada.name }, tokenScope: { tokenId: 't0', projectIds: null } }, '').connect(sv);
  const client = new Client({ name: 'no-sync', version: '0.0.0' });
  await client.connect(c);
  const names = (await client.listTools()).tools.map((t) => t.name);
  check(!names.includes('push') && !names.includes('pull') && !names.includes('sync_status'), `no sync tools unless the instance opts in (got ${names.join(', ')})`);
  check(['list_comments', 'add_comment', 'reply_comment', 'resolve_comment', 'assign_comment'].every((n) => names.includes(n)), 'the comment tools are always there');
  await client.close();
}
process.env.ALDINE_MCP_SYNC = '1';
const asAda = await connect(ada);
const asVic = await connect(vic);
const asNora = await connect(nora);

// ---- a host repository and a project linked to it ----
const bare = path.join(tmp, 'host.git');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
const seed = path.join(tmp, 'seed');
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
const MAIN = '\\documentclass{article}\n\\begin{document}\nThe first claim needs a citation here.\nA second sentence follows.\n\\end{document}\n';
fs.writeFileSync(path.join(seed, 'main.tex'), MAIN);
const sg = (...a) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...a], { cwd: seed, stdio: 'pipe' }).toString();
sg('add', '-A'); sg('commit', '-qm', 'seed'); sg('push', '-q', bare, 'main');
const url = `file://${bare}`;
const hostLog = () => execFileSync('git', ['--git-dir', bare, 'log', '--format=%s', 'main']).toString().trim().split('\n');

const id = 'commentsync1';
await gitops.cloneRepo(id, url);
const meta = { id, name: 'Linked', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(), ownerId: ada.id, share: { mode: 'private', collaborators: ['vic@example.com'], roles: { 'vic@example.com': 'view' }, links: [] } };
store.setRemoteLink(meta, { provider: 'github', fullName: 'ada/paper', owner: 'ada', repo: 'paper', remoteBranch: 'main', cloneUrl: url, connectedBy: ada.id });
await store.writeMeta(meta);
await remotes.setConnection(ada.id, 'github', { token: 'ada-token', login: 'ada' });

// ---- comments ----
let r = await asAda('add_comment', { project: id, path: 'main.tex', quote: 'needs a citation', body: 'Which source backs this?', suggestion: 'needs a citation \\cite{doe2020}' });
check(!r.isError, `add_comment answers (got ${JSON.stringify(r.body)})`);
const added = r.body.comment;
eq([added.path, added.line, added.quote, added.author, added.resolved], ['main.tex', 3, 'needs a citation', 'Claude (for Ada)', false], 'the comment is anchored by its quote and signed as the agent for Ada');
const stored = (await comments.listComments(id, 'main')).find((c) => c.id === added.id);
eq(MAIN.slice(stored.anchor.from, stored.anchor.to), 'needs a citation', 'the stored anchor spans the quote in the editor text');
eq(stored.suggestion, 'needs a citation \\cite{doe2020}', 'the suggestion is kept for one-click accept');

r = await asAda('add_comment', { project: id, path: 'main.tex', quote: 'not in the file at all', body: 'x' });
eq(r.body.error, 'stale_anchor', 'a quote that is not there answers stale_anchor, as edit_file does');
r = await asAda('add_comment', { project: id, path: 'main.tex', quote: 'second', body: 'x' });
check(r.isError && /8 characters|at least/i.test(r.body), `a too-short quote is refused (got ${JSON.stringify(r.body)})`);

r = await asAda('reply_comment', { project: id, comment_id: added.id, body: 'Added the citation.' });
eq(r.body.comment.replies.map((x) => [x.author, x.body]), [['Claude (for Ada)', 'Added the citation.']], 'a reply lands on the thread under the agent\'s name');
r = await asAda('resolve_comment', { project: id, comment_id: added.id });
eq(r.body.resolved, true, 'resolve_comment closes the thread');
r = await asAda('list_comments', { project: id });
eq(r.body.total, 0, 'open threads only by default');
r = await asAda('list_comments', { project: id, include_resolved: true, path: 'main.tex' });
eq([r.body.total, r.body.comments[0].id, r.body.comments[0].replies.length], [1, added.id, 1], 'include_resolved and path show it with its reply');
r = await asAda('resolve_comment', { project: id, comment_id: 'nope' });
check(r.isError && /No comment nope/.test(r.body), 'an unknown thread is named');

r = await asAda('assign_comment', { project: id, comment_id: added.id, to: 'vic' });
eq([r.isError, r.body.assignee], [false, 'Vic'], `assign_comment finds a person by name, any case (got ${JSON.stringify(r.body)})`);
eq((await comments.listComments(id, 'main')).find((c) => c.id === added.id).assignee?.id, vic.id, 'the thread is stored as assigned to that account');
r = await asAda('list_comments', { project: id, include_resolved: true });
eq(r.body.comments[0].assignee, 'Vic', 'list_comments names the assignee');
r = await asAda('assign_comment', { project: id, comment_id: added.id, to: 'me' });
eq(r.body.assignee, 'Ada', '"me" is the user the agent works for');
r = await asAda('assign_comment', { project: id, comment_id: added.id, to: 'Nora' });
check(r.isError && /Nobody called "Nora"/.test(r.body) && /Ada/.test(r.body) && /Vic/.test(r.body), `someone outside the project is refused, with the names to pick from (got ${JSON.stringify(r.body)})`);
r = await asAda('assign_comment', { project: id, comment_id: added.id, to: null });
eq(r.body.assignee, null, 'to:null clears the assignee');
r = await asAda('assign_comment', { project: id, comment_id: 'nope', to: 'me' });
check(r.isError && /No comment nope/.test(r.body), 'an unknown thread is named when assigning');
r = await asVic('assign_comment', { project: id, comment_id: added.id, to: 'me' });
check(r.isError && /not comment on it/.test(r.body), 'a "Can view" person cannot assign through the agent');

r = await asVic('add_comment', { project: id, path: 'main.tex', quote: 'needs a citation', body: 'mine' });
check(r.isError && /not comment on it/.test(r.body), `a "Can view" person cannot comment through the agent (got ${JSON.stringify(r.body)})`);
r = await asVic('list_comments', { project: id, include_resolved: true });
eq(r.body.total, 1, 'but can read the threads');

// ---- sync ----
r = await asAda('sync_status', { project: id });
eq([r.body.linked, r.body.repository, r.body.ahead, r.body.behind, r.body.agentSyncAllowed], [true, 'ada/paper', 0, 0, false], 'sync_status names the repository, level with it, and that push and pull are not allowed yet');
r = await asAda('push', { project: id });
check(r.isError && /owner has not let Claude push and pull/.test(r.body) && /Project settings/.test(r.body), `push is refused until the owner allows it, and says where (got ${JSON.stringify(r.body)})`);
r = await asAda('pull', { project: id });
check(r.isError && /owner has not let Claude push and pull/.test(r.body), 'and so is pull');

// the switch: the owner's alone
const app = Fastify();
await registerRoutes(app);
await app.ready();
const patch = async (u, payload) => app.inject({ method: 'PATCH', url: `/api/projects/${id}`, headers: { cookie: `${auth.COOKIE}=${await auth.createSession(u.id)}` }, payload });
let res = await patch(vic, { agentSync: true });
eq(res.statusCode, 403, 'a collaborator cannot let Claude push and pull');
eq((await store.readMeta(id)).agentSync, undefined, 'and nothing changed');
eq((await patch(ada, { agentSync: 'yes' })).statusCode, 400, 'the value is a boolean');
res = await patch(ada, { agentSync: true });
eq([res.statusCode, res.json().agentSync], [200, true], 'the owner turns it on, and the project says so');
r = await asAda('sync_status', { project: id });
eq(r.body.agentSyncAllowed, true, 'sync_status reports it');

fs.writeFileSync(path.join(store.branchDir(id, 'main'), 'notes.tex'), 'typed by a person, not yet committed\n');
r = await asAda('push', { project: id });
check(!r.isError && r.body.pushed === true, `push answers (got ${JSON.stringify(r.body)})`);
const lastPushed = execFileSync('git', ['--git-dir', bare, 'log', '-1', '--format=%an|%s', 'main']).toString().trim();
check(!lastPushed.startsWith('Claude|'), `a person's unsaved work is pushed as an autosave, never signed as Claude (got ${lastPushed})`);
check(execFileSync('git', ['--git-dir', bare, 'show', 'main:notes.tex']).toString().includes('typed by a person'), 'and it reached the repository');

sg('pull', '-q', bare, 'main');
fs.writeFileSync(path.join(seed, 'upstream.tex'), 'from the repository\n');
sg('add', '-A'); sg('commit', '-qm', 'Upstream change'); sg('push', '-q', bare, 'main');
r = await asAda('sync_status', { project: id });
eq(r.body.behind, 1, 'one commit to pull');
r = await asAda('pull', { project: id });
check(!r.isError && r.body.pulled === true && r.body.changed === true, `pull brings it (got ${JSON.stringify(r.body)})`);
check(store.fileExists(id, 'main', 'upstream.tex'), 'the remote file is here');

// a conflicting pull changes nothing and lists the files
fs.writeFileSync(path.join(seed, 'main.tex'), MAIN.replace('A second sentence follows.', 'The repository rewrote this line.'));
sg('commit', '-qam', 'Remote rewrite'); sg('push', '-q', bare, 'main');
fs.writeFileSync(path.join(store.branchDir(id, 'main'), 'main.tex'), MAIN.replace('A second sentence follows.', 'Aldine rewrote this line.'));
const before = await gitops.branchHead(id, 'main');
r = await asAda('pull', { project: id });
eq([r.body.error, r.body.conflicts], ['merge_conflict', ['main.tex']], 'a conflicting pull is merge_conflict with the files');
check(/user resolves it in Aldine/.test(r.body.reason), 'and hands the merge to the user');
check(store.readFile(id, 'main', 'main.tex').toString().includes('Aldine rewrote this line.'), 'the local text is untouched');
check((await gitops.branchHead(id, 'main')) !== null && before !== null, 'main still has its head');

// members only; unlinked projects say so
r = await asNora('push', { project: id });
check(r.isError && /do not have access/.test(r.body), `someone the project is not shared with cannot push (got ${JSON.stringify(r.body)})`);
const plain = 'plainproj1';
const plainMeta = { id: plain, name: 'Plain', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(), ownerId: ada.id, share: { collaborators: [], links: [] } };
await store.writeMeta(plainMeta);
r = await asAda('sync_status', { project: plain });
check(r.isError && /not linked to a git repository/.test(r.body), `an unlinked project says so and points at Aldine (got ${JSON.stringify(r.body)})`);
check(hostLog().includes('Upstream change'), 'the host keeps its history');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP comments and sync: ALL PASSED');
process.exit(0);
