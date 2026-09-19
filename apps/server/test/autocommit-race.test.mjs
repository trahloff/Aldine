/**
 * Stress variant of the auto-commit attribution split: a 25 ms debounce so
 * the autosave fires constantly, a seeded PRNG interleaving human typing in
 * the agent's file and in another file, agent writes (the tools' lock-span
 * shape), and fires kicked in flight — before and during agent spans. Every
 * line must reach history exactly once under the right author, the tree must
 * end clean, and no git operation may fail (an `index.lock` collision or a
 * swept delta shows up as `[collab] autocommit failed` or an unhandled
 * rejection). Run with SEED=<n> to replay an interleaving.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-autocommit-race-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '25';
delete process.env.AUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const errors = [];
const originalError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
process.on('unhandledRejection', (e) => { originalError('unhandledRejection', e); process.exit(1); });

const SEED = Number(process.env.SEED) || (Date.now() % 100000);
console.log(`autocommit-race: SEED=${SEED}`);
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(SEED);
const rnd = (max) => Math.floor(rand() * max);

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { scheduleCommit } = await import('../src/collab.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The agent write shape the tools use: checkpoint, write and register in ONE
// lock span; `next` reads the file inside the span, after the checkpoint.
const agentWrite = (id, rel, next, message) => gitops.withRepoLock(id, async () => {
  await gitops.checkpointPathsHeld(id, 'main', [rel]);
  store.writeFile(id, 'main', rel, next(store.readFile(id, 'main', rel).toString('utf8')));
  scheduleCommit(id, 'main', message, 'Claude', [rel]);
});

const project = await store.createProject('Autocommit race', {});
const id = project.id;
store.writeFile(id, 'main', 'main.tex', 'base\n');
store.writeFile(id, 'main', 'human.tex', 'base\n');
await gitops.commitAll(id, 'main', 'seed');
const baseline = new Set((await gitops.log(id, 'main')).map((c) => c.hash));

const expected = { 'main.tex': 'base\n', 'human.tex': 'base\n' };
const append = (rel, line) => {
  const cur = store.readFile(id, 'main', rel).toString('utf8');
  store.writeFile(id, 'main', rel, cur + line + '\n');
  expected[rel] += line + '\n';
};

const OPS = ['human-other', 'human-same', 'agent', 'kick', 'kick-during-agent'];
const ROUNDS = 40;
let plan;
do {
  plan = Array.from({ length: ROUNDS }, () => OPS[rnd(OPS.length)]);
} while (plan.filter((o) => o === 'agent').length < 8 || plan.filter((o) => o === 'human-same').length < 8);
const record = (err) => console.error('[race] kicked fire failed', err.message);

const agentLines = [];
const humanLines = [];
for (let i = 0; i < ROUNDS; i++) {
  const op = plan[i];
  await sleep(rnd(41));
  if (op === 'human-other') {
    append('human.tex', `human-other-${i}`);
    humanLines.push(`human-other-${i}`);
    scheduleCommit(id, 'main');
  } else if (op === 'human-same') {
    // Drain first so this line is provably not pending under an agent
    // attribution (the p6 rule would otherwise sign it Claude).
    await gitops.autoCommit(id, 'main');
    append('main.tex', `human-same-${i}`);
    humanLines.push(`human-same-${i}`);
    scheduleCommit(id, 'main');
  } else if (op === 'agent') {
    expected['main.tex'] += `agent-${i}\n`;
    agentLines.push(`agent-${i}`);
    await agentWrite(id, 'main.tex', (cur) => cur + `agent-${i}\n`, 'Edit main.tex');
  } else if (op === 'kick') {
    void gitops.autoCommit(id, 'main').catch(record);
  } else {
    expected['main.tex'] += `agent-${i}\n`;
    agentLines.push(`agent-${i}`);
    const span = agentWrite(id, 'main.tex', (cur) => cur + `agent-${i}\n`, 'Edit main.tex');
    void gitops.autoCommit(id, 'main').catch(record);
    await span;
  }
}
await gitops.autoCommit(id, 'main');
await sleep(150);
await gitops.autoCommit(id, 'main'); // queue behind the last timer fire

const g = store.git(store.repoDir(id));
check((await g.status()).files.length === 0, 'nothing is left uncommitted');

const log = (await gitops.log(id, 'main', 1000)).filter((c) => !baseline.has(c.hash));
const seen = new Map();
let claudeCommits = 0;
let autosaves = 0;
for (const c of log) {
  const patch = (await gitops.commitDiff(id, c.hash)).patch;
  const added = patch.split('\n').filter((l) => /^\+(?!\+\+)/.test(l)).map((l) => l.slice(1));
  const isClaude = c.author === 'Claude';
  if (isClaude) {
    claudeCommits++;
    check(c.message === 'Edit main.tex', `Claude commit ${c.hash.slice(0, 7)} carries the agent's intent (got "${c.message}")`);
    check(added.every((l) => /^agent-\d+$/.test(l)), `Claude commit ${c.hash.slice(0, 7)} adds only agent lines (got ${JSON.stringify(added)})`);
  } else {
    autosaves++;
    check(c.message === 'aldine: autosave', `anonymous commit ${c.hash.slice(0, 7)} is an autosave (got "${c.message}")`);
    check(added.every((l) => /^human-(other|same)-\d+$/.test(l)), `autosave ${c.hash.slice(0, 7)} adds only human lines (got ${JSON.stringify(added)})`);
  }
  for (const l of added) seen.set(l, (seen.get(l) || 0) + 1);
}
for (const l of agentLines) check(seen.get(l) === 1, `${l} is added exactly once (got ${seen.get(l) || 0})`);
for (const l of humanLines) check(seen.get(l) === 1, `${l} is added exactly once (got ${seen.get(l) || 0})`);
check(seen.size === agentLines.length + humanLines.length, 'no commit adds a line the test did not write');
check(claudeCommits > 0 && autosaves > 0, `both kinds of commit exist (Claude ${claudeCommits}, autosave ${autosaves})`);

for (const rel of ['main.tex', 'human.tex']) {
  const disk = store.readFile(id, 'main', rel).toString('utf8');
  check(disk === expected[rel], `${rel} on disk is what the test wrote`);
  check((await g.show([`HEAD:${rel}`])) === disk, `${rel} at HEAD equals disk`);
}
check(errors.length === 0, `no git operation failed (got ${JSON.stringify(errors)})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Auto-commit race (SEED=${SEED}, ${log.length} commits): ALL PASSED`);
process.exit(0);
