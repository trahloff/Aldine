/**
 * Server-side autopush scheduling (#51 Stage B), with the push swapped for a
 * stub: a burst of commits is one push, failures back off with growing gaps
 * and reset the counter on success, the loop gives up after MAX_ATTEMPTS,
 * the real push resolves 'off' (never retries) for an unknown project and for
 * a linked project with autopush !== true, and cancel drops a pending timer.
 * Why pushes fail is kept on the project as a sentence until one lands.
 *
 * AUTOPUSH_DEBOUNCE_MS is read per call, so the give-up run shortens it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-autopush-'));
process.env.DATA_DIR = path.join(tmp, 'data'); process.env.META_DIR = path.join(tmp, 'secrets');
process.env.AUTOPUSH_DEBOUNCE_MS = '20';
delete process.env.GITLAB_TOKEN;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const store = await import('../src/store.ts');
const { scheduleAutopush, cancelAutopush, autopushStats, _setPushImpl, MAX_ATTEMPTS, debounceMs } = await import('../src/autopush.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(5); } return fn(); };
const idle = (id) => { const s = autopushStats(id); return !s.pending && !s.running; };

eq(debounceMs(), 20, 'debounce read from the env');

// ---------- (1) burst → one push ----------
let calls = [];
_setPushImpl(async (id) => { calls.push({ id, t: Date.now() }); return 'pushed'; });
for (let i = 0; i < 5; i++) { scheduleAutopush('p1'); await sleep(1); }
check(autopushStats('p1').pending === true, 'a timer is pending after scheduling');
await sleep(100);
eq(calls.length, 1, 'five schedules within 5 ms → exactly one push');
eq(calls[0].id, 'p1', 'pushed the right project');
eq(autopushStats('p1'), { pending: false, running: false, attempts: 0 }, 'idle after a successful push');

// ---------- (2) failures back off, success resets ----------
calls = [];
let n = 0;
_setPushImpl(async (id) => { n += 1; calls.push({ id, t: Date.now() }); if (n <= 2) throw new Error('remote hung up'); return 'pushed'; });
scheduleAutopush('p2');
check(await until(() => calls.length === 3), 'three attempts in total: ' + calls.length);
check(await until(() => idle('p2')), 'idle after the successful third attempt');
const gap1 = calls[1].t - calls[0].t, gap2 = calls[2].t - calls[1].t;
check(gap1 >= 35 && gap2 > gap1, `gaps grow (debounce 20: ~40 then ~80): ${gap1} then ${gap2}`);
await sleep(150);
eq(calls.length, 3, 'no further pushes after success');
eq(autopushStats('p2').attempts, 0, 'attempts back to 0 after success');

// ---------- (3) give up after MAX_ATTEMPTS ----------
process.env.AUTOPUSH_DEBOUNCE_MS = '5';
calls = [];
_setPushImpl(async (id) => { calls.push({ id, t: Date.now() }); throw new Error('always down'); });
const origWarn = console.warn; const warned = [];
console.warn = (...a) => warned.push(a.join(' '));
try {
  scheduleAutopush('p3');
  check(await until(() => calls.length === MAX_ATTEMPTS, 8000), `reached MAX_ATTEMPTS (${MAX_ATTEMPTS}): ` + calls.length);
  check(await until(() => idle('p3')), 'idle after giving up');
  await sleep(200);
  eq(calls.length, MAX_ATTEMPTS, 'no more attempts after giving up');
  eq(autopushStats('p3'), { pending: false, running: false, attempts: 0 }, 'stats cleared after giving up');
  check(warned.some((w) => /giving up after 8 attempts/.test(w)), 'gave up with a log line: ' + JSON.stringify(warned));
  // the next commit re-arms it
  calls = [];
  scheduleAutopush('p3');
  check(await until(() => calls.length >= 1, 500), 'a new schedule pushes again after a give-up');
  cancelAutopush('p3');
} finally { console.warn = origWarn; }
process.env.AUTOPUSH_DEBOUNCE_MS = '20';

// ---------- (4) the real push: 'off' never enters the retry loop ----------
_setPushImpl(null);
scheduleAutopush('does-not-exist', 0);
await sleep(60);
eq(autopushStats('does-not-exist'), { pending: false, running: false, attempts: 0 }, 'unknown project: resolved off, no retry');

const meta = await store.createProject('Unit', undefined, 'u1');
store.setRemoteLink(meta, { provider: 'gitlab', fullName: 'grp/unit', owner: 'grp', repo: 'unit', remoteBranch: 'main', cloneUrl: 'file:///nonexistent/unit.git', connectedBy: 'u1' });
await store.writeMeta(meta);
check((await store.readMeta(meta.id)).autopush !== true, 'autopush is not on');
scheduleAutopush(meta.id, 0);
check(await until(() => idle(meta.id), 1000), 'linked project without autopush: settled');
await sleep(60);
eq(autopushStats(meta.id), { pending: false, running: false, attempts: 0 }, 'autopush !== true → off (a push to the dead clone URL would have counted an attempt)');

meta.autopush = true; meta.deletedAt = new Date().toISOString();
await store.writeMeta(meta);
scheduleAutopush(meta.id, 0);
await sleep(60);
eq(autopushStats(meta.id), { pending: false, running: false, attempts: 0 }, 'a trashed project never pushes');

// ---------- (5) cancel drops a pending timer ----------
calls = [];
_setPushImpl(async (id) => { calls.push({ id, t: Date.now() }); return 'pushed'; });
scheduleAutopush('p5');
check(autopushStats('p5').pending === true, 'pending before cancel');
cancelAutopush('p5');
eq(autopushStats('p5'), { pending: false, running: false, attempts: 0 }, 'cleared by cancel');
await sleep(80);
eq(calls.length, 0, 'the cancelled push never ran');
cancelAutopush('never-scheduled');

// ---------- (6) the reason is kept on the project until a push lands ----------
_setPushImpl(null);
const kept = await store.createProject('Paused', undefined, 'u2');
store.setRemoteLink(kept, { provider: 'gitlab', fullName: 'grp/paused', owner: 'grp', repo: 'paused', remoteBranch: 'main', cloneUrl: 'file:///nonexistent/paused.git', connectedBy: 'u2' });
kept.autopush = true;
await store.writeMeta(kept);
scheduleAutopush(kept.id, 0);
check(await until(() => autopushStats(kept.id).attempts === 1, 2000), 'the push without a connection failed once');
let failure;
for (let i = 0; i < 100 && !failure; i++) { failure = (await store.readMeta(kept.id)).autopushFailure; if (!failure) await sleep(10); }
eq(failure?.message, 'The GitLab account that linked this project can no longer push it. Add a token for this project in Git access.', 'nobody can push: said in a sentence that names the fix');
check(!Number.isNaN(Date.parse(failure?.since)), 'with the time it started: ' + failure?.since);
cancelAutopush(kept.id);

let fail = true;
_setPushImpl(async () => { if (fail) throw new Error('remote hung up\nmore detail'); return 'pushed'; });
scheduleAutopush(kept.id, 0);
for (let i = 0; i < 100; i++) { if ((await store.readMeta(kept.id)).autopushFailure?.message !== failure.message) break; await sleep(10); }
const next = (await store.readMeta(kept.id)).autopushFailure;
eq(next?.message, 'The push failed: remote hung up', 'a new reason replaces the old, first line only');
eq(next?.since, failure.since, 'and the streak keeps its start');
cancelAutopush(kept.id);
fail = false;
scheduleAutopush(kept.id, 0);
for (let i = 0; i < 100; i++) { if (!(await store.readMeta(kept.id)).autopushFailure) break; await sleep(10); }
eq((await store.readMeta(kept.id)).autopushFailure, undefined, 'a push that lands clears it');
cancelAutopush(kept.id);

_setPushImpl(null);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('autopush unit (burst→backoff→give-up→off paths→cancel): ALL PASSED');
