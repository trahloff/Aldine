/**
 * The agent's session is the branch's, not one file's (agent-1): it is
 * published on the branch signal doc every open editor is connected to,
 * with the files Claude is writing, so a person in another file sees it and
 * switching files ends nothing. A typeset Claude runs holds the session open
 * (agent-1), and the presence names whose token Claude works for (agent-9).
 * Real hooks on a throwaway datastore; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const TTL = 300;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-agent-session-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AGENT_PRESENCE_TTL_MS = String(TTL);
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');

const meta = await store.createProject('Session', { 'a.tex': 'A.\n', 'b.tex': 'B.\n' }, null);
const id = meta.id;
const name = (f) => collab.docName(id, 'main', f);
const open = (f) => collab.hocuspocus.openDirectConnection(name(f), {});
const loaded = (f) => collab.hocuspocus.documents.get(name(f));
const branchState = () => loaded(collab.FILES_SIGNAL)?.awareness.getLocalState() ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const signal = await open(collab.FILES_SIGNAL);
const fileA = await open('a.tex');
eq(branchState(), null, 'no session, nothing on the branch');

collab.markAgentPresence(id, 'main', 'b.tex', 'Ada'); // b.tex is open nowhere
let s = branchState();
check(s?.user?.isAgent === true && typeof s.user.startedAt === 'number', `the session is on the branch's signal doc (got ${JSON.stringify(s)})`);
eq(s.user.name, 'Claude (for Ada)', 'named for the token owner');
eq(s.files, ['b.tex'], 'with the file Claude is writing, which no editor has open');
const startedAt = s.user.startedAt;

collab.markAgentPresence(id, 'main', 'a.tex', 'Ben');
s = branchState();
eq(s.files, ['a.tex', 'b.tex'], 'every file it writes in the session');
eq(s.user.name, 'Claude (for Ada, Ben)', 'everyone whose token the session ran under');
eq(s.user.startedAt, startedAt, 'the session keeps its start');
const inA = loaded('a.tex').awareness.getLocalState();
eq(inA.user.name, 'Claude (for Ben)', "a file's own presence names whom the agent wrote it for");
eq(inA.user.startedAt, startedAt, 'with the session start');
check(collab.agentSessionActive(id, 'main'), 'the session is live');

await sleep(TTL + 150);
eq(branchState(), null, 'an idle session ends on the branch');
eq(loaded('a.tex').awareness.getLocalState(), null, 'and in the file');
check(!collab.agentSessionActive(id, 'main'), 'and the away check hears it ended');

// a typeset holds the session open past the idle timeout
const noHold = collab.holdAgentSession(id, 'main');
check(!collab.agentSessionActive(id, 'main'), 'a typeset with no session starts none');
noHold();
collab.markAgentPresence(id, 'main', 'a.tex', null);
const release = collab.holdAgentSession(id, 'main');
await sleep(TTL + 150);
check(collab.agentSessionActive(id, 'main'), 'the session outlives its idle timeout while the typeset runs');
s = branchState();
check(s?.user?.isAgent === true, 'and stays on the branch');
eq(s.files, [], 'with no file being written meanwhile');
eq(s.user.name, 'Claude', 'a token without an owner names Claude alone');
release();
check(collab.agentSessionActive(id, 'main'), 'the typeset ending starts the idle timeout again');
await sleep(TTL + 150);
check(!collab.agentSessionActive(id, 'main'), 'which ends the session');
eq(branchState(), null, 'on the branch too');

// a signal doc loaded mid-session (the first editor to open) gets the session
await signal.disconnect();
for (let i = 0; i < 100 && loaded(collab.FILES_SIGNAL); i++) await sleep(20);
collab.markAgentPresence(id, 'main', 'b.tex', 'Ada');
const again = await open(collab.FILES_SIGNAL);
eq(branchState()?.files, ['b.tex'], 'a branch channel opened during the session carries it');
await again.disconnect();
await fileA.disconnect();

console.log('collab-agent-session: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
