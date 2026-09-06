/**
 * Debounced auto-commit attribution (UX.md audit ledger): agent-scheduled
 * work commits under author Claude scoped to the paths it touched, anonymous
 * (human) work commits as 'aldine: autosave' — one debounce window holding
 * both must yield TWO commits, never one wrongly-attributed commit. Both
 * scheduling orders are pinned because the debounce is last-writer-wins on
 * its own args. Also pinned: an explicit whole-tree commit inside the window
 * consumes the attribution (else the human's NEXT keystrokes in that file
 * would be signed Claude), a same-file checkpoint keeps a human's pending
 * edits out of the agent's commit, and an agent path that vanished before the
 * fire does not drag the other agent paths into the anonymous sweep.
 *
 * The same-file cases use the tools' write shape — checkpoint, write and
 * register inside ONE repo-lock span; outside it a fire already in flight
 * can stage the agent's file between the write and the registration and
 * sweep it into the autosave.
 *
 * Env must be set before any src import; ALDINE_AUTOCOMMIT_MS shrinks the
 * 20 s debounce so the fire can be awaited.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-autocommit-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '250';
// Mock Zotero: one biblatex item, whatever is asked — zotero.ts reads the
// base URL at import time.
const zoteroMock = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/plain');
  res.setHeader('Last-Modified-Version', '7');
  res.setHeader('Total-Results', '1');
  res.end('@article{fromzotero,\n  title = {From Zotero},\n}\n');
});
await new Promise((r) => zoteroMock.listen(0, '127.0.0.1', r));
process.env.ZOTERO_API_BASE = `http://127.0.0.1:${zoteroMock.address().port}`;
delete process.env.AUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { scheduleCommit, shutdownFlushSet } = await import('../src/collab.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The debounce fires on a timer the test cannot observe; poll the log instead of
// sleeping a fixed budget so a loaded CI box cannot race it.
const untilLog = async (id, branch, pred, maxMs = 6000) => {
  const started = Date.now();
  for (;;) {
    const l = await gitops.log(id, branch);
    if (pred(l)) return l;
    if (Date.now() - started > maxMs) return l;
    await sleep(100);
  }
};
// The agent write shape the tools use: checkpoint, write and register in ONE lock span.
const agentWrite = (id, rel, content, message) => gitops.withRepoLock(id, async () => {
  await gitops.checkpointPathsHeld(id, 'main', [rel]);
  store.writeFile(id, 'main', rel, content);
  scheduleCommit(id, 'main', message, 'Claude', [rel]);
});

// ---- direction 1: human schedules first, agent second — before the fix the
// agent's message/author claimed the whole window, so the human's file landed
// in a Claude commit the session-review toast would offer to revert ----
const p1 = await store.createProject('Split human-then-agent', {});
store.writeFile(p1.id, 'main', 'human.tex', 'typed by a human\n');
scheduleCommit(p1.id, 'main');
store.writeFile(p1.id, 'main', 'agent.tex', 'written by the agent\n');
scheduleCommit(p1.id, 'main', 'Edit agent.tex', 'Claude', ['agent.tex']);
await sleep(1200);

let log = await gitops.log(p1.id, 'main');
const claude1 = log.find((c) => c.author === 'Claude');
check(claude1 !== undefined && claude1.message === 'Edit agent.tex', 'agent work commits with author Claude and the stated intent');
const claudeStat1 = (await gitops.commitDiff(p1.id, claude1.hash)).stat;
check(claudeStat1.includes('agent.tex'), 'the Claude commit contains the agent-touched file');
check(!claudeStat1.includes('human.tex'), "the human's file stays OUT of the Claude commit");
const autosave1 = log.find((c) => c.message === 'aldine: autosave');
check(autosave1 !== undefined && autosave1.author !== 'Claude', 'human work commits as an anonymous autosave');
check((await gitops.commitDiff(p1.id, autosave1.hash)).stat.includes('human.tex'), "the autosave sweep picks up the human's file");

// ---- direction 2: agent schedules first, human keystroke second — before
// the fix the later anonymous scheduling replaced the agent's attribution, so
// the agent mutation hid inside an autosave (no violet dot, no session toast,
// no revert coverage) ----
const p2 = await store.createProject('Split agent-then-human', {});
store.writeFile(p2.id, 'main', 'agent.tex', 'agent change\n');
scheduleCommit(p2.id, 'main', 'Update agent.tex', 'Claude', ['agent.tex']);
store.writeFile(p2.id, 'main', 'human.tex', 'human keystrokes\n');
scheduleCommit(p2.id, 'main');
await sleep(1200);

log = await gitops.log(p2.id, 'main');
const claude2 = log.find((c) => c.author === 'Claude');
check(claude2 !== undefined && claude2.message === 'Update agent.tex', "a later human scheduling does not bury the agent's attribution");
const claudeStat2 = (await gitops.commitDiff(p2.id, claude2.hash)).stat;
check(claudeStat2.includes('agent.tex') && !claudeStat2.includes('human.tex'), 'the Claude commit covers exactly the agent-touched paths');
const autosave2 = log.find((c) => c.message === 'aldine: autosave');
check(autosave2 !== undefined && autosave2.author !== 'Claude', "the human's later keystrokes land as an anonymous autosave");

// ---- agent-only window: the sweep finds a clean tree and commits nothing ----
const p3 = await store.createProject('Split agent-only', {});
const baseLen = (await gitops.log(p3.id, 'main')).length;
store.writeFile(p3.id, 'main', 'agent.tex', 'solo agent change\n');
scheduleCommit(p3.id, 'main', 'Add agent.tex', 'Claude', ['agent.tex']);
await sleep(1200);
log = await gitops.log(p3.id, 'main');
check(log.length === baseLen + 1, `an agent-only window makes exactly one commit (got ${log.length - baseLen})`);
check(log[0].author === 'Claude' && log[0].message === 'Add agent.tex', 'and it is the attributed one');

// ---- explicit commit inside the window consumes the attribution: the
// agent's edit lands under the explicit author, and what the human types
// into that file AFTERWARDS must not fire as a Claude commit ----
const p4 = await store.createProject('Split explicit commit', {});
store.writeFile(p4.id, 'main', 'main.tex', 'agent edit\n');
scheduleCommit(p4.id, 'main', 'Edit main.tex', 'Claude', ['main.tex']);
const explicit = await gitops.commitAll(p4.id, 'main', 'wip', 'Alice');
check(explicit.committed === true, 'the explicit commit lands the pending agent edit');
store.writeFile(p4.id, 'main', 'main.tex', 'agent edit\nhuman typing after the commit\n');
scheduleCommit(p4.id, 'main');
log = await untilLog(p4.id, 'main', (l) => l[0]?.message === 'aldine: autosave');
check(log[0].message === 'aldine: autosave' && log[0].author !== 'Claude', "the human's post-commit typing commits as an anonymous autosave");
check(!log.some((c) => c.author === 'Claude'), 'no Claude commit survives an explicit whole-tree commit');

// ---- same-file checkpoint: a human's uncommitted edits to the file the
// agent is about to touch commit as an autosave FIRST, so the attributed
// commit's diff is exactly the agent's delta ----
const p5 = await store.createProject('Split same-file checkpoint', {});
store.writeFile(p5.id, 'main', 'main.tex', 'human paragraph one\nhuman paragraph two\n');
scheduleCommit(p5.id, 'main'); // typing keeps re-arming the debounce; nothing has landed
await agentWrite(p5.id, 'main.tex', 'human paragraph one\nhuman paragraph two\nagent sentence\n', 'Edit main.tex');
log = await untilLog(p5.id, 'main', (l) => l.some((c) => c.author === 'Claude'));
const claude5 = log.find((c) => c.author === 'Claude');
check(claude5 !== undefined, 'the agent edit commits under Claude');
const patch5 = (await gitops.commitDiff(p5.id, claude5.hash)).patch;
check(patch5.includes('+agent sentence') && !patch5.includes('+human paragraph'), "the Claude commit's diff is exactly the agent's delta");
const checkpoint5 = log.find((c) => c.message === 'aldine: autosave');
check(checkpoint5 !== undefined && checkpoint5.author !== 'Claude', "the human's pending paragraphs were checkpointed as an anonymous autosave");
check((await gitops.commitDiff(p5.id, checkpoint5.hash)).patch.includes('+human paragraph two'), 'the checkpoint holds the human paragraphs');

// ---- fire in flight BEFORE the span: the autosave already running when the
// agent arrives commits the human's paragraphs; the checkpoint then finds the
// file clean and the attributed commit that follows is exactly the delta ----
const p5b = await store.createProject('Split fire before span', {});
store.writeFile(p5b.id, 'main', 'main.tex', 'human paragraph one\nhuman paragraph two\n');
scheduleCommit(p5b.id, 'main');
const fire5b = gitops.autoCommit(p5b.id, 'main'); // not awaited: in flight
await agentWrite(p5b.id, 'main.tex', 'human paragraph one\nhuman paragraph two\nagent sentence\n', 'Edit main.tex');
await fire5b;
log = await untilLog(p5b.id, 'main', (l) => l.some((c) => c.author === 'Claude'));
const claudes5b = log.filter((c) => c.author === 'Claude');
check(claudes5b.length === 1, `exactly one Claude commit after a fire in flight (got ${claudes5b.length})`);
const patch5b = claudes5b[0] ? (await gitops.commitDiff(p5b.id, claudes5b[0].hash)).patch : '';
check(patch5b.includes('+agent sentence') && !patch5b.includes('+human paragraph'), "the in-flight fire did not sweep the agent's delta: the Claude commit is exactly the delta");
const autosaves5b = log.filter((c) => c.message === 'aldine: autosave');
check(autosaves5b.length === 1 && autosaves5b[0].author !== 'Claude', `exactly one anonymous autosave (got ${autosaves5b.length})`);
check(autosaves5b[0] && (await gitops.commitDiff(p5b.id, autosaves5b[0].hash)).patch.includes('+human paragraph two'), 'the in-flight fire committed the human paragraphs');
check(log.indexOf(claudes5b[0]) < log.indexOf(autosaves5b[0]), 'the Claude commit is newer than the autosave');

// ---- fire queued BEHIND the span: the autosave that arrives while the agent
// span holds the lock takes the attribution the span registered, so the
// agent's delta commits under Claude and nothing is left for the sweep ----
const p5c = await store.createProject('Split fire behind span', {});
store.writeFile(p5c.id, 'main', 'main.tex', 'human paragraph one\nhuman paragraph two\n');
scheduleCommit(p5c.id, 'main');
const span5c = agentWrite(p5c.id, 'main.tex', 'human paragraph one\nhuman paragraph two\nagent sentence\n', 'Edit main.tex');
const fire5c = gitops.autoCommit(p5c.id, 'main');
await Promise.all([span5c, fire5c]);
log = await gitops.log(p5c.id, 'main');
check(log[0].author === 'Claude' && log[0].message === 'Edit main.tex', 'the queued fire commits the agent delta under Claude, newest');
const patch5c = (await gitops.commitDiff(p5c.id, log[0].hash)).patch;
check(patch5c.includes('+agent sentence') && !patch5c.includes('+human paragraph'), "the queued fire's Claude commit is exactly the agent's delta");
check(log[1].message === 'aldine: autosave' && log[1].author !== 'Claude', 'the checkpoint before it is the anonymous autosave');
check((await gitops.commitDiff(p5c.id, log[1].hash)).patch.includes('+human paragraph two'), 'and it holds the human paragraphs');
const len5c = log.length;
await sleep(600);
check((await gitops.log(p5c.id, 'main')).length === len5c, 'the re-armed debounce finds nothing: no duplicate or empty commit');

// ---- consecutive agent edits to one file: the checkpoint before the second
// edit must keep the first edit's attribution, not bury it in an autosave ----
const p6 = await store.createProject('Split consecutive agent edits', {});
const base6 = (await gitops.log(p6.id, 'main')).length;
store.writeFile(p6.id, 'main', 'main.tex', 'agent edit one\n');
scheduleCommit(p6.id, 'main', 'Edit main.tex', 'Claude', ['main.tex']);
await gitops.checkpointPaths(p6.id, 'main', ['main.tex']);
store.writeFile(p6.id, 'main', 'main.tex', 'agent edit one\nagent edit two\n');
scheduleCommit(p6.id, 'main', 'Edit main.tex', 'Claude', ['main.tex']);
await sleep(1200);
log = await gitops.log(p6.id, 'main');
check(log.length === base6 + 2 && log.slice(0, 2).every((c) => c.author === 'Claude'), 'two agent edits to one file yield two Claude commits, no autosave');

// ---- vanished agent path: an untracked agent-created file deleted before
// the fire must not sink the other agent paths into the anonymous sweep ----
const p7 = await store.createProject('Split vanished path', {});
store.writeFile(p7.id, 'main', 'new.tex', 'agent-created\n');
scheduleCommit(p7.id, 'main', 'Update new.tex', 'Claude', ['new.tex']);
store.writeFile(p7.id, 'main', 'other.tex', 'agent-edited\n');
scheduleCommit(p7.id, 'main', 'Edit other.tex', 'Claude', ['other.tex']);
store.deleteFile(p7.id, 'main', 'new.tex');
scheduleCommit(p7.id, 'main');
await sleep(1200);
log = await gitops.log(p7.id, 'main');
const claude7 = log.find((c) => c.author === 'Claude');
check(claude7 !== undefined && (await gitops.commitDiff(p7.id, claude7.hash)).stat.includes('other.tex'), 'the surviving agent path still commits under Claude');
check(!log.some((c) => c.message === 'aldine: autosave'), 'nothing is left for the anonymous sweep');

// ---- intents are per path, not per window: an edit_file to main.tex and a
// later write_file to notes.tex must land as two commits, each titled by its
// own message, and a checkpoint of main.tex before a third write must carry
// main.tex's intent — not the newer write's ----
const p8 = await store.createProject('Split per-path intents', {});
const base8 = (await gitops.log(p8.id, 'main')).length;
await agentWrite(p8.id, 'main.tex', 'tightened abstract\n', 'Tighten the abstract');
await agentWrite(p8.id, 'notes.tex', 'a note\n', 'Add reviewer notes');
// a third write to main.tex checkpoints the pending main.tex under ITS intent
await agentWrite(p8.id, 'main.tex', 'tightened abstract\nsecond pass\n', 'Second pass on the abstract');
await sleep(1200);
log = await gitops.log(p8.id, 'main');
const titles8 = log.slice(0, log.length - base8).map((c) => `${c.author}: ${c.message}`);
check(log.length === base8 + 3 && log.slice(0, 3).every((c) => c.author === 'Claude'), `three agent intents yield three Claude commits, no autosave (got ${JSON.stringify(titles8)})`);
const byMsg8 = Object.fromEntries(await Promise.all(log.slice(0, 3).map(async (c) => [c.message, (await gitops.commitDiff(p8.id, c.hash)).stat])));
check(byMsg8['Tighten the abstract']?.includes('main.tex') && !byMsg8['Tighten the abstract']?.includes('notes.tex'), 'the checkpoint of main.tex is titled with main.tex\'s own intent and holds only main.tex');
check(byMsg8['Add reviewer notes']?.includes('notes.tex') && !byMsg8['Add reviewer notes']?.includes('main.tex'), 'notes.tex commits under its own intent and never under main.tex\'s');
check(byMsg8['Second pass on the abstract']?.includes('main.tex') && !byMsg8['Second pass on the abstract']?.includes('notes.tex'), 'the fire commits the last main.tex write under the message it was scheduled with');

// ---- shutdown set: a branch with a pending intent and no open doc must be
// flushed too — an MCP client with no browser tab has no doc, and the
// ledger dies with the process ----
const p9 = await store.createProject('Split shutdown set', {});
await agentWrite(p9.id, 'main.tex', 'agent-only branch\n', 'Add a line');
check(shutdownFlushSet().some((d) => d.projectId === p9.id && d.branch === 'main'), 'a branch with pending agent work and no open doc is in the shutdown flush set');
await gitops.autoCommit(p9.id, 'main', 'aldine: autosave on shutdown');
check(!shutdownFlushSet().some((d) => d.projectId === p9.id), 'once committed it leaves the set');
log = await gitops.log(p9.id, 'main');
check(log[0].author === 'Claude' && log[0].message === 'Add a line', 'the shutdown flush lands the agent work under Claude');

// ---- a person's whole-tree commit inside the agent window (checkpoint,
// revert, merge, GitHub push) must not sign Claude's pending delta ----
const p10 = await store.createProject('Split manual checkpoint', {});
await agentWrite(p10.id, 'main.tex', 'agent sentence\n', 'Tighten the abstract');
store.writeFile(p10.id, 'main', 'human.tex', 'human paragraph\n');
const manual = await gitops.autoCommit(p10.id, 'main', 'Checkpoint', 'Alice');
log = await gitops.log(p10.id, 'main');
check(manual.committed === true && log[0].author === 'Alice' && log[0].message === 'Checkpoint', `the person's checkpoint is the newest commit under their name (got ${JSON.stringify(log.slice(0, 2).map((c) => `${c.author}: ${c.message}`))})`);
check((await gitops.commitDiff(p10.id, log[0].hash)).stat.includes('human.tex') && !(await gitops.commitDiff(p10.id, log[0].hash)).stat.includes('main.tex'), "the checkpoint holds the person's file only");
check(log[1].author === 'Claude' && log[1].message === 'Tighten the abstract' && (await gitops.commitDiff(p10.id, log[1].hash)).stat.includes('main.tex'), 'the agent delta committed first, under Claude and its intent');

// ---- fail closed, not stuck: an attributed commit that fails is retried
// under a neutral title, so a subject git cannot take never blocks the
// anonymous sweep of everyone else's work ----
const p11 = await store.createProject('Split failing intent', {});
store.writeFile(p11.id, 'main', 'main.tex', 'agent edit\n');
gitops.registerAttributedPaths(p11.id, 'main', 'bad\u0000subject', 'Claude', ['main.tex']);
const failed = await gitops.autoCommit(p11.id, 'main').then(() => null, (e) => e);
check(failed instanceof Error, 'a subject git cannot take fails that fire');
check(shutdownFlushSet().some((d) => d.projectId === p11.id), 'the attribution is kept for the next fire');
store.writeFile(p11.id, 'main', 'human.tex', 'human line\n');
await gitops.autoCommit(p11.id, 'main');
log = await gitops.log(p11.id, 'main');
check(log[0].message === 'aldine: autosave' && (await gitops.commitDiff(p11.id, log[0].hash)).stat.includes('human.tex'), `the next fire sweeps the person's file (got ${JSON.stringify(log.map((c) => `${c.author}: ${c.message}`))})`);
check(log[1].author === 'Claude' && log[1].message === 'aldine: agent edit' && (await gitops.commitDiff(p11.id, log[1].hash)).stat.includes('main.tex'), 'and the agent delta landed under Claude with the retry title');

// ---- a Zotero sync inside the agent window is a whole-tree commit a
// person triggers: it must land Claude's pending delta under Claude first
// and hold only the synced .bib itself ----
const { syncProject } = await import('../src/zotero.ts');
const p12 = await store.createProject('Split Zotero sync', {});
await agentWrite(p12.id, 'main.tex', 'agent sentence\n', 'Tighten the abstract');
await store.writeMeta({ ...(await store.readMeta(p12.id)), zotero: { apiKey: 'k', userId: 1, libraryPrefix: 'users/1', bibFile: 'references.bib' } });
const synced = await syncProject(p12.id);
check(synced.synced === true && synced.itemCount === 1, `the sync lands the mock library (got ${JSON.stringify(synced)})`);
log = await gitops.log(p12.id, 'main');
const titles12 = log.slice(0, 2).map((c) => `${c.author}: ${c.message}`);
check(log[0].message === 'aldine: sync Zotero library into references.bib' && log[0].author !== 'Claude', `the sync commit is newest and not Claude's (got ${JSON.stringify(titles12)})`);
const syncStat = (await gitops.commitDiff(p12.id, log[0].hash)).stat;
check(syncStat.includes('references.bib') && !syncStat.includes('main.tex'), 'the sync commit holds only the .bib');
check(log[1].author === 'Claude' && log[1].message === 'Tighten the abstract' && (await gitops.commitDiff(p12.id, log[1].hash)).stat.includes('main.tex'), "Claude's pending edit committed first, under Claude and its intent");

zoteroMock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Auto-commit attribution split: ALL PASSED');
process.exit(0);
