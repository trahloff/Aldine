/**
 * Assistant names: a commit made through a connected client carries that
 * client's name as an `Agent-client` trailer next to `On-behalf-of`, the log
 * and the review answer hand it back, and presence and comments are signed
 * with it. A personal access token names no client, a message cannot claim
 * one, and a person's commit never reads as a client's.
 *
 * In-memory MCP transport against real stores; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-assistant-names-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL', 'REMOTE_PROVIDERS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const collab = await import('../src/collab.ts');
const { createMcpServer } = await import('../src/mcp/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

// ---- the message ----
eq(gitops.agentCommitMessage('Reword', 'Ada', 'ChatGPT'), 'Reword\n\nOn-behalf-of: Ada\nAgent-client: ChatGPT', 'both trailers, the requester first');
eq(gitops.agentCommitMessage('Reword', 'Ada', null), 'Reword\n\nOn-behalf-of: Ada', 'no client, no line');
eq(gitops.agentCommitMessage('Reword', null, 'ChatGPT'), 'Reword\n\nAgent-client: ChatGPT', 'a client without accounts still shows');
eq(gitops.agentCommitMessage('Reword\n\nAgent-client: Somebody Else', 'Ada', 'ChatGPT'), 'Reword\n\nOn-behalf-of: Ada\nAgent-client: ChatGPT', 'a client line in the intent is dropped');
eq(gitops.agentCommitMessage('Reword\n\nagent-client: Somebody Else', 'Ada', null), 'Reword\n\nOn-behalf-of: Ada', 'in any case, also when the token names no client');
eq(gitops.agentClientName('  Chat\nGPT <x@y>\u0000 '), 'Chat GPT x@y', 'one line, no angle brackets');
eq(gitops.agentClientName('Aldine'), '', 'the name History reads as nobody is not a client');
eq(gitops.agentClientName('Claude (for Toby), ChatGPT'), 'Claude for Toby ChatGPT', 'a name cannot write the "(for …)" half or pass as two clients');
eq(gitops.agentCommitMessage('Reword\n\nAgent-client : Somebody Else\nOn-behalf-of\t: Eve', null, null), 'Reword', 'a trailer written with blanks before the colon is dropped too');
eq(gitops.agentClientName('x'.repeat(200)).length, 60, 'a long name is cut');
eq(gitops.agentClientName(undefined), '', 'nothing stays nothing');

// ---- the display name ----
eq(collab.agentDisplayName(['Ada'], ['ChatGPT']), 'ChatGPT (for Ada)', 'client and person');
eq(collab.agentDisplayName(['Ada']), 'Assistant (for Ada)', 'no client named: the neutral name');
eq(collab.agentDisplayName([], ['ChatGPT']), 'ChatGPT', 'a client alone');
eq(collab.agentDisplayName(['Ada'], ['ChatGPT', 'Assistant']), 'ChatGPT, Assistant (for Ada)', 'calls without a client are listed as Assistant beside the named one');
eq(collab.agentDisplayName(['Ada', 'Ben'], ['ChatGPT', 'Claude Code', 'ChatGPT']), 'ChatGPT, Claude Code (for Ada, Ben)', 'several of each, once each');

// ---- a token from Connect carries its client ----
const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const { token: connected } = await auth.createAccessToken(ada.id, 'ChatGPT', null, null, { clientName: 'ChatGPT', family: 'fam1' });
const { token: personal } = await auth.createAccessToken(ada.id, 'my script', null, null);
eq((await auth.userFromToken(`Bearer ${connected}`)).tokenScope.clientName, 'ChatGPT', 'the scope names the client');
eq((await auth.userFromToken(`Bearer ${personal}`)).tokenScope.clientName, null, 'a personal access token names none');

const connect = async (tokenHeader) => {
  const hit = await auth.userFromToken(`Bearer ${tokenHeader}`);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ user: hit.user, tokenScope: hit.tokenScope }, '').connect(serverSide);
  const client = new Client({ name: 'assistant-names-test', version: '0.0.0' });
  await client.connect(clientSide);
  return async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { isError: !!res.isError, body };
  };
};
const viaChatGPT = await connect(connected);
const viaToken = await connect(personal);

// ---- a project ----
const id = 'assistantnames1';
const seed = path.join(tmp, 'seed');
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
fs.writeFileSync(path.join(seed, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nThe first sentence.\nThe second sentence.\n\\end{document}\n');
const sg = (...a) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...a], { cwd: seed, stdio: 'pipe' }).toString();
sg('add', '-A'); sg('commit', '-qm', 'seed');
await gitops.cloneRepo(id, `file://${seed}`);
await store.writeMeta({ id, name: 'Names', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(), ownerId: ada.id, share: { mode: 'private', collaborators: [], roles: {}, links: [] } });
const fullMessage = (hash) => execFileSync('git', ['-C', store.repoDir(id), 'log', '-1', '--format=%B', hash]).toString();

// ---- a connected client's commit ----
let r = await viaChatGPT('edit_file', { project: id, path: 'main.tex', edits: [{ quote: 'The first sentence.', replacement: 'The first sentence, reworded.' }], message: 'Reword the opening' });
check(!r.isError, `edit_file answers (got ${JSON.stringify(r.body)})`);
let log = await gitops.log(id, 'main', 10);
eq([log[0].author, log[0].message, log[0].onBehalfOf, log[0].client], ['Assistant', 'Reword the opening', 'Ada', 'ChatGPT'], 'the log names the client beside the person; the author is Assistant');
let detailed = await gitops.log(id, 'main', 10, { details: true });
eq([detailed[0].client, detailed[0].onBehalfOf, detailed[0].files], ['ChatGPT', 'Ada', ['main.tex']], 'so does the detailed log, with the files still in place');
check(/\n\nOn-behalf-of: Ada\nAgent-client: ChatGPT\n*$/.test(fullMessage(log[0].hash)), `the trailers are the message's last paragraph (got ${JSON.stringify(fullMessage(log[0].hash))})`);
let activity = await gitops.agentActivitySince(id, 'main', null);
eq([activity.commits[0].client, activity.commits[0].onBehalfOf, activity.commits[0].files], ['ChatGPT', 'Ada', ['main.tex']], 'the review answer names the client');

// ---- a message cannot claim another client ----
r = await viaChatGPT('edit_file', { project: id, path: 'main.tex', edits: [{ quote: 'The second sentence.', replacement: 'The second sentence, reworded.' }], message: 'Reword\n\nAgent-client: Somebody Else' });
check(!r.isError, `the second edit answers (got ${JSON.stringify(r.body)})`);
log = await gitops.log(id, 'main', 10);
eq([log[0].message, log[0].client], ['Reword', 'ChatGPT'], 'the token decides the client, not the message');

// ---- a personal access token names no client ----
r = await viaToken('edit_file', { project: id, path: 'main.tex', edits: [{ quote: 'reworded.\nThe second', replacement: 'reworded again.\nThe second' }], message: 'Script edit\n\nAgent-client: ChatGPT' });
check(!r.isError, `the token edit answers (got ${JSON.stringify(r.body)})`);
log = await gitops.log(id, 'main', 10);
eq([log[0].author, log[0].message, log[0].onBehalfOf, log[0].client], ['Assistant', 'Script edit', 'Ada', undefined], 'no client on a personal token, whatever the message says');
check(/\n\nOn-behalf-of: Ada\n*$/.test(fullMessage(log[0].hash)), 'and the requester trailer is still last');

// ---- a person's commit never reads as a client's ----
const wt = await gitops.ensureWorktree(id, 'main');
fs.appendFileSync(path.join(wt, 'main.tex'), '% a note\n');
execFileSync('git', ['-c', 'user.name=Ben', '-c', 'user.email=ben@example.org', 'commit', '-qam', 'By hand\n\nAgent-client: ChatGPT'], { cwd: wt });
log = await gitops.log(id, 'main', 10);
eq([log[0].author, log[0].client], ['Ben', undefined], 'the trailer counts only on an agent commit');
detailed = await gitops.log(id, 'main', 10, { details: true });
eq([detailed[0].author, detailed[0].client, detailed[1].client, detailed[2].client], ['Ben', undefined, undefined, 'ChatGPT'], 'the detailed log keeps every record aligned');
activity = await gitops.agentActivitySince(id, 'main', null);
eq(activity.commits.map((c) => c.client), [undefined, 'ChatGPT', 'ChatGPT'], 'the review answer too, newest first');

// ---- commits authored "Claude" before 1.25 still read as assistant commits ----
execFileSync('git', ['-c', 'user.name=Claude', '-c', 'user.email=claude@aldine.local', 'commit', '-q', '--allow-empty', '-m', 'Old agent edit\n\nOn-behalf-of: Ada\nAgent-client: ChatGPT'], { cwd: wt });
log = await gitops.log(id, 'main', 10);
eq([log[0].author, log[0].onBehalfOf, log[0].client], ['Claude', 'Ada', 'ChatGPT'], 'an old "Claude" commit keeps its requester and client');
activity = await gitops.agentActivitySince(id, 'main', null);
check(activity.commits.some((c) => c.message === 'Old agent edit'), 'and the review answer still counts it');
check(gitops.isAgentAuthor('Claude') && gitops.isAgentAuthor('Assistant') && !gitops.isAgentAuthor('Ada'), 'both names are agent authors, a person is not');

// ---- comments are signed with the client ----
r = await viaChatGPT('add_comment', { project: id, path: 'main.tex', quote: 'reworded again', body: 'Is this better?' });
eq(r.body.comment?.author, 'ChatGPT (for Ada)', 'a comment through a connected client is signed with it');
r = await viaToken('add_comment', { project: id, path: 'main.tex', quote: 'reworded again', body: 'And this?' });
eq(r.body.comment?.author, 'Assistant (for Ada)', 'through a personal token, under the neutral name');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Assistant names: ALL PASSED');
process.exit(0);
