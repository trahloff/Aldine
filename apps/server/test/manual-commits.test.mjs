/**
 * Manual commits (meta.manualCommits): the edit debounce and the shutdown
 * flush leave a person's edits in the working tree for their own commit and
 * message, while agent work still lands under its author. The ZIP download
 * carries the uncommitted edits without committing them. Unreadable meta
 * falls back to the sweep, so edits can never drop out of history.
 *
 * Env must be set before any src import; ALDINE_AUTOCOMMIT_MS shrinks the
 * 20 s debounce so the fire can be awaited.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check } from './assert.mjs';

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-manual-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '250';
delete process.env.AUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { scheduleCommit } = await import('../src/collab.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const p = await store.createProject('Manual commits', {});
const meta = await store.readMeta(p.id);
meta.manualCommits = true;
await store.writeMeta(meta);
const base = (await gitops.log(p.id, 'main')).length;

// ---- a human edit and an agent edit in one debounce window ----
store.writeFile(p.id, 'main', 'human.tex', 'typed by a person\n');
scheduleCommit(p.id, 'main');
store.writeFile(p.id, 'main', 'agent.tex', 'written by the agent\n');
scheduleCommit(p.id, 'main', 'Edit agent.tex', 'Claude', ['agent.tex']);
await sleep(1200);

let log = await gitops.log(p.id, 'main');
check(!log.some((c) => c.message === 'aldine: autosave'), 'no autosave commit on a manual-commit project');
const claude = log.find((c) => c.author === 'Claude');
check(claude !== undefined && claude.message === 'Edit agent.tex', 'agent work still commits under its own name');
check(log.length === base + 1, `exactly one new commit, the agent's (got ${log.length - base})`);
let pending = await gitops.uncommittedPaths(p.id, 'main');
check(pending.includes('human.tex') && !pending.includes('agent.tex'), `the person's edit waits uncommitted (got ${pending.join(',')})`);
check(!pending.some((x) => x.startsWith('.aldine-out')), 'build output never counts as a change');

// ---- the shutdown flush leaves it too ----
await gitops.autosave(p.id, 'main', 'aldine: autosave on shutdown');
check((await gitops.log(p.id, 'main')).length === base + 1, 'the shutdown flush does not commit the person\'s edit');

// ---- the ZIP carries the uncommitted edit without committing it ----
const tree = await gitops.workingTreeId(p.id, 'main');
const zip = await gitops.archiveZip(p.id, 'main', tree);
const zipPath = path.join(tmp, 'out.zip');
fs.writeFileSync(zipPath, zip);
const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
check(listing.includes('human.tex') && listing.includes('agent.tex'), 'the archive holds the working tree');
check(!listing.includes('.aldine-out'), 'the archive leaves build output out');
check((await gitops.log(p.id, 'main')).length === base + 1, 'archiving commits nothing');
pending = await gitops.uncommittedPaths(p.id, 'main');
check(pending.includes('human.tex'), 'archiving leaves the edit uncommitted (the throwaway index did not touch the real one)');

// ---- the person's own commit takes it, with their message ----
const r = await gitops.autoCommit(p.id, 'main', 'Rewrite the introduction', 'Ada');
check(r.committed, 'the manual commit lands');
log = await gitops.log(p.id, 'main');
check(log[0].message === 'Rewrite the introduction' && log[0].author === 'Ada', 'the commit carries the person\'s message and name');
check((await gitops.uncommittedPaths(p.id, 'main')).length === 0, 'nothing waits after the commit');

// ---- switching back to automatic resumes the sweep ----
meta.manualCommits = false;
await store.writeMeta(meta);
store.writeFile(p.id, 'main', 'human.tex', 'typed again\n');
scheduleCommit(p.id, 'main');
await sleep(1200);
check((await gitops.log(p.id, 'main'))[0].message === 'aldine: autosave', 'automatic mode autosaves again');

// ---- unreadable meta falls back to the sweep ----
const q = await store.createProject('Broken meta', {});
store.writeFile(q.id, 'main', 'x.tex', 'x\n');
const qm = await store.readMeta(q.id);
qm.manualCommits = true;
await store.writeMeta(qm);
const metaFile = fs.readdirSync(process.env.META_DIR, { recursive: true }).map(String).find((f) => f.includes(q.id) && f.endsWith('.json'));
if (metaFile) {
  fs.writeFileSync(path.join(process.env.META_DIR, metaFile), '{not json');
  const res = await gitops.autosave(q.id, 'main');
  check(res.committed, 'a project whose meta cannot be read still autosaves');
} else {
  console.log('  (meta file layout not found; broken-meta case skipped)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Manual commits: ALL PASSED');
process.exit(0);
