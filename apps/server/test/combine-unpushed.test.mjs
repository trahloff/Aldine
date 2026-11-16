/**
 * gitops.combineUnpushed (#316): the commits a host lacks become one commit
 * of the files as they are now, the old history stays on a local branch, and
 * a host that moved on is pulled first. A bare file:// upstream stands in
 * for the host; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-combine-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL']) delete process.env[k];

const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');

const bare = path.join(tmp, 'host.git');
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
const seed = path.join(tmp, 'seed');
const sg = (...a) => execFileSync('git', ['-c', 'user.name=Host', '-c', 'user.email=host@example.org', ...a], { cwd: seed, stdio: 'pipe' }).toString();
execFileSync('git', ['clone', '-q', bare, seed], { stdio: 'pipe' });
fs.writeFileSync(path.join(seed, 'main.tex'), 'first\n');
sg('add', '-A'); sg('commit', '-qm', 'seed'); sg('push', '-q', 'origin', 'main');
const url = `file://${bare}`;
const hostHead = () => execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main']).toString().trim();

const id = 'combine01';
await gitops.cloneRepo(id, url);
const repo = store.repoDir(id);
const rg = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
const commit = async (rel, content, author) => {
  if (content === null) fs.rmSync(path.join(repo, rel));
  else { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content); }
  return gitops.commitAll(id, 'main', `edit ${rel}`, author);
};

// nothing the host lacks: nothing happens
const seedHead = hostHead();
eq(await gitops.combineUnpushed(id, 'main', url, 'my-version-x', 'Combined'), { combined: 0, kept: null, hash: null, forked: [] }, 'nothing to combine');

// three commits by two people, one adding a file deleted again
await commit('photo.png', 'png', { name: 'Ada', email: 'ada@example.edu' });
await commit('notes.tex', 'notes\n', { name: 'Grace', email: 'grace@example.edu' });
await gitops.createBranch(id, 'draft'); // started while the image was still in
await commit('photo.png', null, { name: 'Ada', email: 'ada@example.edu' });
fs.writeFileSync(path.join(repo, 'typing.tex'), 'not saved yet\n');
const before = rg('rev-parse', 'main');
const r = await gitops.combineUnpushed(id, 'main', url, 'my-version-x', 'Combined', { name: 'Ada', email: 'ada@example.edu' });
eq([r.combined, r.kept, r.forked], [3, 'my-version-x', ['draft']], 'three commits combined, the old history kept, the branch started inside them named');
eq(fs.readFileSync(path.join(repo, 'typing.tex'), 'utf8'), 'not saved yet\n', 'an edit not yet committed is untouched');
fs.rmSync(path.join(repo, 'typing.tex'));
eq(rg('rev-parse', 'my-version-x'), before, 'the kept branch is the old main');
eq(rg('rev-parse', 'main~1'), seedHead, 'main is one commit on top of the host');
eq(rg('rev-parse', 'main'), r.hash, 'that commit is the one reported');
eq(rg('show', '--name-only', '--format=', 'main'), 'notes.tex', 'it holds the files as they are, never the deleted image');
eq(rg('log', '-1', '--format=%an <%ae>', 'main'), 'Ada <ada@example.edu>', 'by the person who combined');
check(rg('log', '-1', '--format=%B', 'main').includes('Co-authored-by: Grace <grace@example.edu>'), 'with the other author as co-author');
check(!rg('log', '-1', '--format=%B', 'main').includes('Co-authored-by: Ada'), 'and not the combiner twice');
eq(rg('status', '--porcelain'), '', 'the working tree matches the new commit');

// one commit is already one: nothing rewritten, nothing kept
await commit('one.tex', 'one\n');
const single = rg('rev-parse', 'main');
eq(await gitops.combineUnpushed(id, 'main', url, 'my-version-x', 'Combined'), { combined: 2, kept: 'my-version-x-2', hash: rg('rev-parse', 'main'), forked: [] }, 'two commits are still combined, no branch started inside them');
await gitops.pushToRemote(id, 'main', url);
await commit('two.tex', 'two\n');
const lone = rg('rev-parse', 'main');
eq(await gitops.combineUnpushed(id, 'main', url, 'my-version-x', 'Combined'), { combined: 1, kept: null, hash: lone, forked: [] }, 'a single commit is pushed as it is');
eq(rg('rev-parse', 'main'), lone, 'main unchanged');
check(single !== lone, 'setup: a new commit');

// a second combine keeps under the next free name
await commit('more.tex', 'more\n');
await commit('more2.tex', 'more\n');
eq((await gitops.combineUnpushed(id, 'main', url, 'my-version-x', 'Combined')).kept, 'my-version-x-3', 'a taken name gets a suffix');

// only a refused file, deleted again: main simply becomes the host's head
await gitops.pushToRemote(id, 'main', url);
const pushed = hostHead();
await commit('big.pdf', 'pdf');
await commit('big.pdf', null);
const same = await gitops.combineUnpushed(id, 'main', url, 'my-version-y', 'Combined');
eq([same.combined, same.hash, same.kept], [2, null, 'my-version-y'], 'nothing left to push, old history kept');
eq(rg('rev-parse', 'main'), pushed, 'main is the host\'s head');

// the host moved on: pull first, nothing changes
sg('pull', '-q', 'origin', 'main');
fs.writeFileSync(path.join(seed, 'host.tex'), 'host\n');
sg('add', '-A'); sg('commit', '-qm', 'on the host'); sg('push', '-q', 'origin', 'main');
await commit('local.tex', 'local\n');
const mine = rg('rev-parse', 'main');
const diverged = await gitops.combineUnpushed(id, 'main', url, 'my-version-z', 'Combined');
eq(diverged.diverged, true, 'a host with newer commits is reported');
eq(rg('rev-parse', 'main'), mine, 'and main is left alone');
check(!rg('branch', '--list', 'my-version-z'), 'without a kept branch');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('combine-unpushed: all assertions passed');
