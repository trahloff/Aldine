/**
 * The stdio transport's shutdown flush. Claude Code ends a session by closing
 * the child's stdin, then SIGTERM two seconds later, then SIGKILL. The
 * attribution ledger and the autosave debounce are process-local, so agent
 * work still pending at that moment must commit under Claude before the
 * process exits — otherwise the next autosave (the server's, or the next
 * stdio session's) sweeps the edit as an anonymous autosave. Both the stdin
 * close and a bare SIGTERM are pinned.
 *
 * ALDINE_AUTOCOMMIT_MS is set far beyond the test's lifetime so only the
 * flush can have made the commit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check } from './assert.mjs';

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mcp-stdio-'));
const dataDir = path.join(tmp, 'data');
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  META_DIR: path.join(tmp, 'meta'),
  CACHE_DIR: path.join(tmp, 'cache'),
  ALDINE_AUTOCOMMIT_MS: '60000',
};
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PUBLIC_URL', 'ALDINE_MCP_TOKEN', 'ALDINE_MCP_CLIENT_TOKEN']) delete env[k];

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));
const entry = path.join(here, '..', 'src', 'mcp', 'stdio.ts');

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

// stderr is captured: the flush line names the trigger, which is how the
// test tells a flush on the stdin close from one on the SIGTERM that the
// client sends two seconds later (a timing budget would flake on a loaded box).
const session = async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, entry], env, stderr: 'pipe' });
  const err = [];
  transport.stderr.on('data', (chunk) => err.push(chunk.toString()));
  const client = new Client({ name: 'aldine-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport, stderr: () => err.join('') };
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
};
const repo = (id) => path.join(dataDir, 'projects', id);
const gitLog = (id) => execSync('git log --format=%an%x1f%s', { cwd: repo(id) }).toString().trim().split('\n').map((l) => {
  const [author, ...message] = l.split('\x1f');
  return { author, message: message.join('\x1f') };
});
const gitDirty = (id) => execSync('git status --porcelain', { cwd: repo(id) }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the child flushes on its way out; poll the repo instead of trusting a timing budget
const until = async (pred, maxMs = 8000) => {
  const started = Date.now();
  while (!pred() && Date.now() - started < maxMs) await sleep(100);
};
const untilLog = async (id, pred) => { await until(() => pred(gitLog(id))); return gitLog(id); };
// the flush line reaches the parent's pipe after the commit it reports
const flushed = (s, reason) => s.stderr().includes(`aldine-mcp: ${reason} — flushed 1 project/branch(es)`);

// ---- stdin close (Client.close(), what Claude Code does at session end) ----
const s1 = await session();
const project = await call(s1.client, 'create_project', { name: 'Stdio paper' });
check(typeof project.id === 'string', 'create_project over stdio returns the project');
const w1 = await call(s1.client, 'write_file', { project: project.id, path: 'main.tex', content: 'A line from Claude.\n', message: 'Add a line' });
check(w1.ok === true, `write_file over stdio lands (got ${JSON.stringify(w1)})`);
check(gitDirty(project.id).includes('main.tex'), 'setup: the write is on disk and uncommitted (inside the debounce window)');
await s1.client.close();
let log = await untilLog(project.id, (l) => l[0]?.author === 'Claude');
await until(() => flushed(s1, 'stdin closed'));
check(flushed(s1, 'stdin closed'), `the flush runs on the stdin close, not on the SIGTERM the client sends 2 s later (stderr: ${JSON.stringify(s1.stderr())})`);
check(log[0]?.author === 'Claude' && log[0]?.message === 'Add a line', `closing the client commits the pending work under Claude with its intent (got ${JSON.stringify(log.map((c) => `${c.author}: ${c.message}`))})`);
check(gitDirty(project.id) === '', 'nothing is left for a later anonymous autosave');
check(log.filter((c) => c.author === 'Claude').length === 1, 'the stdin close and the SIGTERM that may follow it commit once, not twice');

// ---- bare SIGTERM (a wrapper or the OS stopping the process) ----
const s2 = await session();
const w2 = await call(s2.client, 'write_file', { project: project.id, path: 'main.tex', content: 'A line from Claude.\nA second line.\n', message: 'Add a second line' });
check(w2.ok === true, 'a second session writes');
check(gitDirty(project.id).includes('main.tex'), 'setup: the second write is pending');
process.kill(s2.transport.pid, 'SIGTERM');
log = await untilLog(project.id, (l) => l[0]?.message === 'Add a second line');
check(log[0]?.author === 'Claude' && log[0]?.message === 'Add a second line', `SIGTERM commits the pending work under Claude (got ${JSON.stringify(log.slice(0, 2).map((c) => `${c.author}: ${c.message}`))}; stderr: ${JSON.stringify(s2.stderr())})`);
await until(() => flushed(s2, 'SIGTERM'));
check(flushed(s2, 'SIGTERM'), `the SIGTERM handler is the one that flushed (stderr: ${JSON.stringify(s2.stderr())})`);
check(gitDirty(project.id) === '', 'the tree is clean after the SIGTERM flush');
await s2.client.close().catch(() => {});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP stdio shutdown flush: ALL PASSED');
process.exit(0);
