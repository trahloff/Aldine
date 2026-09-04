import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-push-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
// Fake timers aren't available here, so the debounce is env-tunable.
process.env.AUTOPUSH_DEBOUNCE_MS = '60';
// An auto-provisioned project pushes with the service token; without any
// credential autopush is a deliberate no-op (asserted below).
process.env.GITLAB_TOKEN = 'svc';

const { initDb } = await import('../src/db/index.ts'); await initDb();
const store = await import('../src/store.ts');
const { scheduleAutopush } = await import('../src/autopush.ts');

const BARES = path.join(tmp, 'bares'); fs.mkdirSync(BARES, { recursive: true });

/** A project whose remote is a local bare repo, so pushes really happen. */
async function makeProject(name, { autopush, linked = true }) {
  const meta = await store.createProject(name);
  if (linked) {
    const bare = path.join(BARES, `${meta.id}.git`);
    execSync(`git init --bare -b main "${bare}"`, { stdio: 'ignore' });
    store.setRemoteLink(meta, {
      provider: 'gitlab', fullName: `grp/${meta.id}`, owner: 'grp', repo: meta.id,
      remoteBranch: 'main', cloneUrl: `file://${bare}`, connectedBy: 'local',
    });
  }
  if (autopush !== undefined) meta.autopush = autopush;
  await store.writeMeta(meta);
  return meta.id;
}
const remoteHead = (id) => {
  try { return execSync(`git --git-dir="${path.join(BARES, `${id}.git`)}" rev-parse main`).toString().trim(); }
  catch { return null; }
};
const countCommits = (id) => {
  try { return Number(execSync(`git --git-dir="${path.join(BARES, `${id}.git`)}" rev-list --count main`).toString().trim()); }
  catch { return 0; }
};
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// --- a burst coalesces into one push ---
const on = await makeProject('Pushes', { autopush: true });
check(remoteHead(on) === null, 'remote starts empty');
for (let i = 0; i < 10; i++) scheduleAutopush(on);
await settle();
check(remoteHead(on) !== null, 'autopush pushed');
check(countCommits(on) === 1, `one commit on the remote, got ${countCommits(on)}`);

// --- autopush:false is never pushed ---
const off = await makeProject('Stays local', { autopush: false });
scheduleAutopush(off);
await settle();
check(remoteHead(off) === null, 'autopush:false projects are not pushed');

// --- an absent flag behaves as off, so existing projects never start pushing unbidden ---
const unset = await makeProject('Legacy', {});
scheduleAutopush(unset);
await settle();
check(remoteHead(unset) === null, 'an unset flag does not push');

// --- a project with no remote is a no-op, not a throw ---
const localOnly = await makeProject('No remote', { autopush: true, linked: false });
scheduleAutopush(localOnly);
await settle();
check(true, 'no remote is a no-op');

// --- an unknown project id is permanent, so it must not enter the retry loop ---
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };
scheduleAutopush('doesnotexist01');
await settle(500);
console.warn = realWarn;
check(warnings.length === 0, `a deleted project does not retry or log, got: ${warnings.join(' | ')}`);

// --- with no credential available, autopush is a no-op rather than a crash ---
const noCreds = await makeProject('No token', { autopush: true });
delete process.env.GITLAB_TOKEN;
scheduleAutopush(noCreds);
await settle();
check(remoteHead(noCreds) === null, 'no credential means no push');
process.env.GITLAB_TOKEN = 'svc';

// --- a second push after new commits lands too ---
fs.writeFileSync(path.join(process.env.DATA_DIR, 'projects', on, 'main.tex'), 'changed\n');
const { commitAll } = await import('../src/gitops.ts');
await commitAll(on, 'main', 'second');
scheduleAutopush(on);
await settle();
check(countCommits(on) === 2, `second push landed, got ${countCommits(on)}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('autopush: ALL PASSED');
process.exit(0);
