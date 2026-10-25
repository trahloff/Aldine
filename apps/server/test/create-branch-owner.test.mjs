/**
 * Starting a branch on the git host repoints the branch the project tracks
 * for everyone, so it is the owner's call, like switching it: a collaborator
 * and a link visitor get 403 and nothing changes on the host or in the link.
 * The owner's request creates the branch and repoints. Collaborators keep
 * branches that live only on this server.
 *
 * Real route table (Fastify inject) against a file:// bare repository linked
 * through the owner's stored connection; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-createbranch-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL', 'REMOTE_PROVIDERS']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const remotes = await import('../src/remotes.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const owner = await auth.register('owner@example.com', 'password123', 'Owner');
const member = await auth.register('member@example.com', 'password123', 'Member');
await db().setEmailPending(member.id, null); // a collaborator by a confirmed address
const visitor = await auth.register('visitor@example.com', 'password123', 'Visitor');
const session = async (u) => `${auth.COOKIE}=${await auth.createSession(u.id)}`;

// ---- a host repository and a project linked to it ----
const bare = path.join(tmp, 'host.git');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
const seed = path.join(tmp, 'seed');
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
fs.writeFileSync(path.join(seed, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}\n');
const sg = (...a) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...a], { cwd: seed, stdio: 'pipe' }).toString();
sg('add', '-A'); sg('commit', '-qm', 'seed'); sg('push', '-q', bare, 'main');
const url = `file://${bare}`;
const hostBranches = () => execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']).toString().split('\n').filter(Boolean).sort();

const id = 'createbranch1';
await gitops.cloneRepo(id, url);
const meta = { id, name: 'Linked', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(), ownerId: owner.id, share: { mode: 'link', collaborators: ['member@example.com'] } };
store.setRemoteLink(meta, { provider: 'github', fullName: 'owner/paper', owner: 'owner', repo: 'paper', remoteBranch: 'main', cloneUrl: url, connectedBy: owner.id });
await store.writeMeta(meta);
await remotes.setConnection(owner.id, 'github', { token: 'owner-token', login: 'owner' });

const app = Fastify();
await registerRoutes(app);
await app.ready();
const post = async (u, tail, payload) => app.inject({ method: 'POST', url: `/api/projects/${id}/${tail}`, headers: { cookie: await session(u) }, payload });
const tracked = async () => store.remoteLink(await store.readMeta(id)).remoteBranch;

// ---- not the owner: refused, nothing moves ----
const asMember = await post(member, 'remote/create-branch', { name: 'member-branch' });
eq(asMember.statusCode, 403, 'a collaborator cannot start a branch on the host');
eq(asMember.json().error, 'Only the owner can start a branch on the git host', 'and is told who can');
eq((await post(member, 'github/create-branch', { name: 'member-branch' })).statusCode, 403, 'nor through the older github/ path');
eq((await post(visitor, 'remote/create-branch', { name: 'visitor-branch' })).statusCode, 403, 'nor can a link visitor');
eq(hostBranches(), ['main'], 'the host has no new branch');
eq(await tracked(), 'main', 'the project still tracks main');
eq((await post(member, 'remote/switch-branch', { branch: 'main' })).statusCode, 403, 'switching stays owner-only too');

// ---- the owner: created on the host and tracked ----
const asOwner = await post(owner, 'remote/create-branch', { name: 'owner-branch' });
eq(asOwner.statusCode, 200, 'the owner starts a branch on the host');
eq(asOwner.json().branch, 'owner-branch', 'named as asked');
eq(hostBranches(), ['main', 'owner-branch'], 'it exists on the host');
eq(await tracked(), 'owner-branch', 'and the project tracks it');

// ---- collaborators keep branches on this server ----
const local = await post(member, 'branches', { name: 'member-draft', from: 'main' });
check(local.statusCode === 200, `a collaborator still creates a branch on this server (${local.statusCode} ${local.body})`);
eq(hostBranches(), ['main', 'owner-branch'], 'which does not reach the host');

await app.close();
console.log('create-branch-owner: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
