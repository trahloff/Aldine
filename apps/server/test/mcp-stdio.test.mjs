/**
 * The stdio transport's session end. Claude Code ends a session by closing
 * the child's stdin, then SIGTERM two seconds later, then SIGKILL. Every
 * write commits under Claude as it lands, so the process must exit with the
 * tree clean and nothing committed twice on the way out — on the stdin close
 * and on a bare SIGTERM alike. (The shutdown flush that lands work a refused
 * commit left in the ledger is pinned in autocommit-split.test.mjs.)
 *
 * ALDINE_AUTOCOMMIT_MS is set far beyond the test's lifetime so only the
 * tools themselves can have made the commits.
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
const exited = async (transport, maxMs = 8000) => {
  const started = Date.now();
  while (transport.pid !== null && Date.now() - started < maxMs) await sleep(100);
  return transport.pid === null;
};

// ---- stdin close (Client.close(), what Claude Code does at session end) ----
const s1 = await session();
const project = await call(s1.client, 'create_project', { name: 'Stdio paper' });
check(typeof project.id === 'string', 'create_project over stdio returns the project');
const w1 = await call(s1.client, 'write_file', { project: project.id, path: 'main.tex', content: 'A line from Claude.\n', message: 'Add a line' });
check(w1.ok === true && typeof w1.commit === 'string', `write_file over stdio lands and names its commit (got ${JSON.stringify(w1)})`);
let log = gitLog(project.id);
check(log[0]?.author === 'Claude' && log[0]?.message === 'Add a line', `the write is committed under Claude with its intent before the tool answers (got ${JSON.stringify(log.map((c) => `${c.author}: ${c.message}`))})`);
check(gitDirty(project.id) === '', 'nothing is left for a later anonymous autosave');
await s1.client.close();
check(await exited(s1.transport), `the process exits on the stdin close (stderr: ${JSON.stringify(s1.stderr())})`);
log = gitLog(project.id);
check(log.filter((c) => c.author === 'Claude').length === 1 && gitDirty(project.id) === '', 'the stdin close and the SIGTERM that may follow it commit nothing more');

// ---- bare SIGTERM (a wrapper or the OS stopping the process) ----
const s2 = await session();
const w2 = await call(s2.client, 'write_file', { project: project.id, path: 'main.tex', content: 'A line from Claude.\nA second line.\n', message: 'Add a second line' });
check(w2.ok === true && typeof w2.commit === 'string', 'a second session writes and commits');
log = gitLog(project.id);
check(log[0]?.author === 'Claude' && log[0]?.message === 'Add a second line', `the second write is committed at once (got ${JSON.stringify(log.slice(0, 2).map((c) => `${c.author}: ${c.message}`))})`);
process.kill(s2.transport.pid, 'SIGTERM');
check(await exited(s2.transport), `the process exits on SIGTERM (stderr: ${JSON.stringify(s2.stderr())})`);
check(gitDirty(project.id) === '' && gitLog(project.id).length === log.length, 'the tree is clean and SIGTERM committed nothing more');
await s2.client.close().catch(() => {});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP stdio shutdown flush: ALL PASSED');
process.exit(0);
