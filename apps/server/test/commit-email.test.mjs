/**
 * An account's commit email (#294): commits made with an email-bearing author
 * carry that address on every commit path (commit argv, the empty checkpoint
 * commit, commit-tree), keep the name History groups by, and leave Aldine as
 * the committer. A plain name keeps the derived `…@aldine.local` address.
 * The address is validated before it can reach an ident.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-commit-email-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.AUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const auth = await import('../src/auth.ts');

const p = await store.createProject('Commit email', {});
const dir = await gitops.ensureWorktree(p.id, 'main');
/** author name, author email, committer email of a commit */
const ident = (rev = 'HEAD') => execFileSync('git', ['log', '-1', '--format=%an%x00%ae%x00%ce', rev], { cwd: dir, encoding: 'utf8' }).trim().split('\0');
const ada = { name: 'Ada Lovelace', email: '12345+ada@users.noreply.github.com' };

// ---- commit argv (the sweep of a person's checkpoint, publish, pull …) ----
store.writeFile(p.id, 'main', 'a.tex', 'one\n');
let r = await gitops.autoCommit(p.id, 'main', 'Save a', ada);
check(r.committed, 'the sweep commits');
const [name, email, committer] = ident();
eq([name, email], [ada.name, ada.email], 'the sweep is authored with the account commit email');
check(committer !== ada.email, 'Aldine stays the committer');

// ---- a plain name keeps the derived address ----
store.writeFile(p.id, 'main', 'a.tex', 'two\n');
await gitops.autoCommit(p.id, 'main', 'Save a again', 'Ada Lovelace');
eq(ident().slice(0, 2), ['Ada Lovelace', 'ada.lovelace@aldine.local'], 'a name without an email keeps …@aldine.local');

// ---- an object without an email is the plain name ----
store.writeFile(p.id, 'main', 'a.tex', 'three\n');
await gitops.autoCommit(p.id, 'main', 'Save a once more', { name: 'Ada Lovelace' });
eq(ident().slice(0, 2), ['Ada Lovelace', 'ada.lovelace@aldine.local'], 'no email on the identity is the derived address');

// ---- the empty checkpoint commit (History's Save after the autosave took the edit) ----
store.writeFile(p.id, 'main', 'a.tex', 'four\n');
await gitops.autosave(p.id, 'main');
r = await gitops.checkpoint(p.id, 'main', 'Named checkpoint', ada);
check(r.committed, 'the named checkpoint is made');
eq(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim(), 'Named checkpoint', 'the checkpoint is the head');
eq(ident().slice(0, 2), [ada.name, ada.email], 'the empty checkpoint commit carries the commit email');

// ---- commit-tree (find & replace across files) ----
r = await gitops.withRepoLock(p.id, () => gitops.commitWriteHeld(p.id, 'main', [{ path: 'a.tex', before: 'four\n', after: 'five\n' }], 'Replace four', ada));
check(r.committed, 'the replace commits');
eq(ident().slice(0, 2), [ada.name, ada.email], 'a commit-tree commit carries the commit email');

// ---- History groups by name, so the log reads the name ----
const log = await gitops.log(p.id, 'main');
eq(log[0].author, ada.name, 'the log names the author by name only');

// ---- validation ----
eq(auth.cleanCommitEmail('  ada@example.org  '), 'ada@example.org', 'trimmed');
eq(auth.cleanCommitEmail(''), null, 'empty clears');
eq(auth.cleanCommitEmail('   '), null, 'blank clears');
eq(auth.cleanCommitEmail(null), null, 'null clears');
for (const bad of ['ada', 'ada@', '@example.org', 'a@b@c', 'ada lovelace@example.org', 'ada@example.org>', '<ada@example.org', 'ada@exa\nmple.org', 'a"b@example.org', 'a,b@example.org', 'ada@exam\u0000ple.org', 42]) {
  let threw = false;
  try { auth.cleanCommitEmail(bad); } catch { threw = true; }
  check(threw, `rejects ${JSON.stringify(bad)}`);
}
let long = false;
try { auth.cleanCommitEmail(`${'a'.repeat(250)}@b.cd`); } catch (err) { long = /254/.test(err.message); }
check(long, 'rejects an address over 254 characters');

// ---- stored on the account, shown to the account ----
const u = await auth.register('ada@example.org', 'correct horse battery', 'Ada Lovelace');
check(u.commitEmail === undefined, 'a new account has no commit email');
eq((await auth.setCommitEmail(u.id, ' 12345+ada@users.noreply.github.com ')).commitEmail, '12345+ada@users.noreply.github.com', 'setCommitEmail stores the trimmed address');
eq((await auth.getUser(u.id)).commitEmail, '12345+ada@users.noreply.github.com', 'and it is on the account');
check((await auth.setCommitEmail(u.id, '')).commitEmail === undefined, 'an empty value clears it');
check((await auth.getUser(u.id)).commitEmail === undefined, 'and the account no longer has one');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('commit-email: ok');
