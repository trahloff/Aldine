/**
 * Switching the tracked host branch hard-resets main to the target, so the
 * commits main has and the host lacks must reach the host first. When that
 * push fails the switch stops with a 409 and nothing moves: not the link, not
 * main, not the host. A main with nothing the host lacks still switches when
 * the push is refused for being behind. Edits that cannot be committed stop
 * the switch before anything is pushed.
 *
 * Real route table (Fastify inject) against a file:// bare repository linked
 * through the owner's stored connection. GITHUB_API_BASE points at a stub
 * that accepts the token, so a refused push is never read as a dead token.
 * Env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const stub = http.createServer((req, res) => {
  res.writeHead(req.url === '/user' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/user' ? { login: 'owner', name: 'Owner' } : { message: 'Not Found' }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-switchsave-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.GITHUB_API_BASE = `http://127.0.0.1:${stub.address().port}`;
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL', 'REMOTE_PROVIDERS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const remotes = await import('../src/remotes.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const owner = await auth.register('owner@example.com', 'password123', 'Owner');
const cookie = `${auth.COOKIE}=${await auth.createSession(owner.id)}`;

// ---- a host with main and dev, and a project tracking main ----
const bare = path.join(tmp, 'host.git');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
const seed = path.join(tmp, 'seed');
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
const sg = (...a) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...a], { cwd: seed, stdio: 'pipe' }).toString();
fs.writeFileSync(path.join(seed, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}\n');
sg('add', '-A'); sg('commit', '-qm', 'seed'); sg('push', '-q', bare, 'main'); sg('push', '-q', bare, 'main:dev');
/** A commit made on the host by someone else, on `branch`. */
const hostCommit = (branch, file, text) => {
  sg('fetch', '-q', bare, branch); sg('checkout', '-q', '-B', branch, 'FETCH_HEAD');
  fs.writeFileSync(path.join(seed, file), text);
  sg('add', '-A'); sg('commit', '-qm', `host edit to ${file}`); sg('push', '-q', bare, branch);
};
const hostShow = (ref) => execFileSync('git', ['--git-dir', bare, 'show', ref]).toString();
const hostHead = (branch) => execFileSync('git', ['--git-dir', bare, 'rev-parse', branch]).toString().trim();

const id = 'switchsave1';
await gitops.cloneRepo(id, `file://${bare}`);
const meta = { id, name: 'Linked', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(), ownerId: owner.id, share: { mode: 'private', collaborators: [] } };
store.setRemoteLink(meta, { provider: 'github', fullName: 'owner/paper', owner: 'owner', repo: 'paper', remoteBranch: 'main', cloneUrl: `file://${bare}`, connectedBy: owner.id });
await store.writeMeta(meta);
await remotes.setConnection(owner.id, 'github', { token: 'owner-token', login: 'owner' });
const work = store.repoDir(id);
const localEdit = (file, text) => fs.writeFileSync(path.join(work, file), text);
const localShow = (ref) => execFileSync('git', ['show', ref], { cwd: work }).toString();

const app = Fastify();
await registerRoutes(app);
await app.ready();
const post = (tail, payload) => app.inject({ method: 'POST', url: `/api/projects/${id}/remote/${tail}`, headers: { cookie }, payload });
const tracked = async () => store.remoteLink(await store.readMeta(id)).remoteBranch;

// ---- the host moved on and main has an unpushed commit: refused, nothing moves ----
hostCommit('main', 'host.tex', 'from the host\n');
const hostMain = hostHead('main');
const hostDev = hostHead('dev');
localEdit('main.tex', 'LOCAL WORK\n');
let r = await post('switch-branch', { branch: 'dev' });
eq(r.statusCode, 409, `the switch is refused (${r.body})`);
eq(r.json().error, 'GitHub has newer commits on main. Pull first, then switch.', 'and says to pull first');
eq(r.json().code, 'pull-first', 'with a code the editor offers Pull for');
eq(await tracked(), 'main', 'the project still tracks main');
eq(localShow('main:main.tex'), 'LOCAL WORK\n', 'the local work is still committed on main');
eq(fs.readFileSync(path.join(work, 'main.tex'), 'utf8'), 'LOCAL WORK\n', 'and still on disk');
eq(hostHead('main'), hostMain, "the host's main is untouched");
eq(hostHead('dev'), hostDev, "and so is the host's dev");

// ---- pull, then switch: the work reaches the host first ----
r = await post('pull');
eq(r.statusCode, 200, `pull merges the host's commit (${r.body})`);
r = await post('switch-branch', { branch: 'dev' });
eq(r.statusCode, 200, `the switch goes through after the pull (${r.body})`);
eq(r.json().branch, 'dev', 'to dev');
eq(await tracked(), 'dev', 'the project tracks dev');
eq(hostShow('main:main.tex'), 'LOCAL WORK\n', 'the local work is on the host before the reset');
eq(hostShow('main:host.tex'), 'from the host\n', "next to the host's commit");
check(!fs.readFileSync(path.join(work, 'main.tex'), 'utf8').includes('LOCAL WORK'), 'main now holds dev');

// ---- behind but with nothing of its own: the refused push loses nothing, so the switch goes on ----
hostCommit('dev', 'dev.tex', 'dev moved on\n');
r = await post('switch-branch', { branch: 'main' });
eq(r.statusCode, 200, `a main with nothing unpushed switches though its push is refused (${r.body})`);
eq(await tracked(), 'main', 'the project tracks main again');
eq(fs.readFileSync(path.join(work, 'main.tex'), 'utf8'), 'LOCAL WORK\n', "main holds the host's main");

// ---- the host refuses the push for another reason: refused, and the reason is passed on ----
const hook = path.join(bare, 'hooks', 'pre-receive');
fs.writeFileSync(hook, '#!/bin/sh\necho "pushes are closed" >&2\nexit 1\n', { mode: 0o755 });
localEdit('main.tex', 'MORE LOCAL WORK\n');
r = await post('switch-branch', { branch: 'dev' });
eq(r.statusCode, 409, `the switch is refused when the push fails (${r.body})`);
check(r.json().error.startsWith('Could not push to GitHub before switching, so nothing changed: '), `the message says nothing changed (${r.json().error})`);
check(r.json().error.includes('pushes are closed'), "and carries the host's reason");
eq(await tracked(), 'main', 'the project still tracks main');
eq(localShow('main:main.tex'), 'MORE LOCAL WORK\n', 'the new work is still committed on main');
fs.rmSync(hook);

// ---- the edits cannot be committed: refused before anything reaches the host ----
const lock = path.join(work, '.git', 'index.lock');
fs.writeFileSync(lock, '');
localEdit('main.tex', 'UNSAVED EDIT\n');
const hostMainBefore = hostHead('main');
r = await post('switch-branch', { branch: 'dev' });
eq(r.statusCode, 409, `the switch is refused when the save commit fails (${r.body})`);
eq(r.json().code, 'save-failed', 'with its own code');
eq(r.json().error, 'Could not save the latest edits before switching, so nothing changed. Try again in a moment.', 'in a plain sentence');
eq(await tracked(), 'main', 'the project still tracks main');
eq(fs.readFileSync(path.join(work, 'main.tex'), 'utf8'), 'UNSAVED EDIT\n', 'the uncommitted edit is still on disk');
eq(hostHead('main'), hostMainBefore, 'nothing was pushed');
fs.rmSync(lock);

await app.close();
stub.close();
console.log('switch-branch-save: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
