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
 * Env must be set before any src import; ALDINE_AUTOCOMMIT_MS shrinks the
 * 20 s debounce so the fire can be awaited.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-autocommit-'));
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
await gitops.checkpointPaths(p5.id, 'main', ['main.tex']);
store.writeFile(p5.id, 'main', 'main.tex', 'human paragraph one\nhuman paragraph two\nagent sentence\n');
scheduleCommit(p5.id, 'main', 'Edit main.tex', 'Claude', ['main.tex']);
log = await untilLog(p5.id, 'main', (l) => l.some((c) => c.author === 'Claude'));
const claude5 = log.find((c) => c.author === 'Claude');
check(claude5 !== undefined, 'the agent edit commits under Claude');
const patch5 = (await gitops.commitDiff(p5.id, claude5.hash)).patch;
check(patch5.includes('+agent sentence') && !patch5.includes('+human paragraph'), "the Claude commit's diff is exactly the agent's delta");
const checkpoint5 = log.find((c) => c.message === 'aldine: autosave');
check(checkpoint5 !== undefined && checkpoint5.author !== 'Claude', "the human's pending paragraphs were checkpointed as an anonymous autosave");
check((await gitops.commitDiff(p5.id, checkpoint5.hash)).patch.includes('+human paragraph two'), 'the checkpoint holds the human paragraphs');

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Auto-commit attribution split: ALL PASSED');
process.exit(0);
