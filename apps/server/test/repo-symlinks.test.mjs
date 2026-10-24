/**
 * Symbolic links never take a project read or write outside the project.
 *
 * Source: clone, pull, reset to the remote and a new branch's worktree check
 * a link out as a plain file holding its target, and the tree keeps the link
 * entry when the project commits again.
 *
 * Sink: a link already on disk (a project cloned before that, or made by
 * hand) is refused on every path to it — store, REST /file and /output, the
 * MCP file tools and a collab document — and the file listing leaves it out.
 * The link targets are another account's record in META_DIR and files
 * outside DATA_DIR.
 *
 * Real route table (Fastify inject), real MCP server over an in-memory
 * transport, file:// upstream; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-symlinks-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const collab = await import('../src/collab.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { createMcpServer } = await import('../src/mcp/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const Fastify = (await import('fastify')).default;

await auth.register('victim@example.com', 'victim-password-1', 'Victim');
const mallory = await auth.register('mallory@example.com', 'password123', 'Mallory');
const secretFile = path.join(process.env.META_DIR, 'users.json');
check(fs.readFileSync(secretFile, 'utf8').includes('victim@example.com'), 'setup: META_DIR holds the victim record');
const outsideFile = path.join(tmp, 'outside-write.txt');
const outsideDir = path.join(tmp, 'outside-dir');
fs.mkdirSync(outsideDir);

// ---- upstream with links ----
const up = path.join(tmp, 'upstream');
fs.mkdirSync(up);
const ug = (...a) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...a], { cwd: up, stdio: 'pipe' }).toString();
ug('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(up, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}\n');
fs.symlinkSync(secretFile, path.join(up, 'abs.tex'));
fs.symlinkSync(outsideFile, path.join(up, 'out.tex'));
fs.symlinkSync(outsideDir, path.join(up, 'figs'));
ug('add', '-A'); ug('commit', '-qm', 'links');
const url = `file://${up}`;

const id = 'symlinks01';
await gitops.cloneRepo(id, url);
await store.writeMeta({ id, name: 'Imported', rootFile: 'main.tex', engine: 'pdf', createdAt: new Date().toISOString(), ownerId: mallory.id, share: { mode: 'private', collaborators: [] } });
const repo = store.repoDir(id);

/** The checkout holds `rel` as a regular file whose bytes are the link target. */
const plain = (dir, rel, target) => {
  const st = fs.lstatSync(path.join(dir, rel));
  check(st.isFile() && !st.isSymbolicLink(), `${rel} is a regular file in ${path.basename(dir)}`);
  eq(fs.readFileSync(path.join(dir, rel), 'utf8'), target, `${rel} holds its link target, not the target's bytes`);
};

// ---- source ----
plain(repo, 'abs.tex', secretFile);
plain(repo, 'out.tex', outsideFile);
plain(repo, 'figs', outsideDir);

fs.symlinkSync(secretFile, path.join(up, 'later.tex'));
ug('add', '-A'); ug('commit', '-qm', 'another link');
eq((await gitops.pullFromRemote(id, 'main', url)).ok, true, 'pull succeeds');
plain(repo, 'later.tex', secretFile);

fs.rmSync(path.join(repo, 'later.tex'));
await gitops.resetToRemote(id, 'main', url);
plain(repo, 'later.tex', secretFile);

await gitops.createBranch(id, 'draft');
plain(store.branchDir(id, 'draft'), 'abs.tex', secretFile);

store.writeFile(id, 'main', 'main.tex', '\\documentclass{article}\\begin{document}edited\\end{document}\n');
const wt = execFileSync('git', ['ls-tree', await gitops.workingTreeId(id, 'main'), '--', 'abs.tex', 'figs'], { cwd: repo }).toString();
check(/^120000 blob \S+\tabs\.tex$/m.test(wt) && /^120000 blob \S+\tfigs$/m.test(wt), `the working-tree archive keeps the link entries (got ${JSON.stringify(wt)})`);
await gitops.autoCommit(id, 'main', 'edit');
const entry = execFileSync('git', ['ls-tree', 'HEAD', '--', 'abs.tex', 'figs'], { cwd: repo }).toString();
check(/^120000 blob \S+\tabs\.tex$/m.test(entry) && /^120000 blob \S+\tfigs$/m.test(entry), `a later commit keeps the link entries (got ${JSON.stringify(entry)})`);
check(!fs.existsSync(outsideFile), 'nothing was written outside the project');

// ---- sink: links already on disk ----
fs.symlinkSync(secretFile, path.join(repo, 'planted.tex'));
fs.symlinkSync(outsideFile, path.join(repo, 'planted-out.tex'));
fs.symlinkSync(outsideDir, path.join(repo, 'planteddir'));
fs.mkdirSync(path.join(repo, '.aldine-out'), { recursive: true });
fs.symlinkSync(secretFile, path.join(repo, '.aldine-out', 'main.pdf'));
const untouched = (msg) => {
  check(!fs.existsSync(outsideFile), `${msg}: no file appeared outside the project`);
  eq(fs.readdirSync(outsideDir), [], `${msg}: the directory outside the project stays empty`);
};

await throws(() => store.readFile(id, 'main', 'planted.tex'), 'symbolic link', 'store.readFile refuses a link');
await throws(() => store.readFile(id, 'main', 'planteddir/x.tex'), 'symbolic link', 'store.readFile refuses a path through a linked folder');
await throws(() => store.writeFile(id, 'main', 'planted-out.tex', 'x'), 'symbolic link', 'store.writeFile refuses a link');
await throws(() => store.writeFile(id, 'main', 'planteddir/new.tex', 'x'), 'symbolic link', 'store.writeFile refuses a path through a linked folder');
await throws(() => store.renameFile(id, 'main', 'main.tex', 'planteddir/main.tex'), 'symbolic link', 'store.renameFile refuses a target through a linked folder');
check(fs.existsSync(path.join(repo, 'main.tex')), 'the refused rename left main.tex in place');
eq(store.fileExists(id, 'main', 'planted.tex'), false, 'store.fileExists answers false for a link');
eq(store.isDirectory(id, 'main', 'planteddir'), false, 'store.isDirectory answers false for a linked folder');
untouched('store');
const listed = store.listFiles(id, 'main').map((f) => f.path);
check(!listed.some((p) => p.startsWith('planted')), `the listing leaves links out (got ${JSON.stringify(listed)})`);
check(listed.includes('main.tex') && listed.includes('abs.tex'), 'the listing keeps files, including a link checked out as a file');

// REST, signed in as the project's owner
const app = Fastify();
await registerRoutes(app);
const cookie = auth.sessionCookie(await auth.createSession(mallory.id)).split(';')[0];
const api = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
let res = await api('GET', `/api/projects/${id}/file?path=planted.tex`);
eq(res.statusCode, 404, 'GET /file refuses a link');
check(!res.body.includes('victim@example.com'), 'GET /file does not serve the link target');
res = await api('GET', `/api/projects/${id}/file?path=planteddir%2Fx.tex`);
eq(res.statusCode, 404, 'GET /file refuses a path through a linked folder');
res = await api('PUT', `/api/projects/${id}/file`, { path: 'planted-out.tex', content: 'attacker bytes\n' });
eq(res.statusCode, 400, 'PUT /file refuses a link');
res = await api('PUT', `/api/projects/${id}/file`, { path: 'planteddir/new.tex', content: 'attacker bytes\n' });
eq(res.statusCode, 400, 'PUT /file refuses a path through a linked folder');
untouched('REST');
res = await api('GET', `/api/projects/${id}/output?path=.aldine-out%2Fmain.pdf`);
eq(res.statusCode, 404, 'GET /output refuses a linked artifact');
check(!res.body.includes('victim@example.com'), 'GET /output does not serve the link target');
res = await api('GET', `/api/projects/${id}/files`);
check(res.statusCode === 200 && !res.json().files.some((f) => f.path.startsWith('planted')), 'GET /files leaves links out');
res = await api('GET', `/api/projects/${id}/file?path=main.tex`);
check(res.statusCode === 200 && res.body.includes('edited'), 'GET /file still serves an ordinary file');
res = await api('PUT', `/api/projects/${id}/file`, { path: 'sections/new.tex', content: 'fresh\n' });
check(res.statusCode === 200 && fs.readFileSync(path.join(repo, 'sections', 'new.tex'), 'utf8') === 'fresh\n', 'PUT /file still creates a file in a new folder');

// MCP, as the owner
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const mcp = createMcpServer({ user: mallory, tokenScope: null }, 'http://localhost');
await mcp.connect(serverSide);
const client = new Client({ name: 'aldine-test-symlinks', version: '0.0.0' });
await client.connect(clientSide);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text };
};
let r = await call('read_file', { project: id, path: 'planted.tex' });
check(r.isError && /symbolic link/.test(r.text) && !r.text.includes('victim@example.com'), `read_file refuses a link (got ${JSON.stringify(r.text)})`);
r = await call('read_file', { project: id, path: 'planteddir/x.tex' });
check(r.isError && /symbolic link/.test(r.text), `read_file refuses a path through a linked folder (got ${JSON.stringify(r.text)})`);
r = await call('write_file', { project: id, path: 'planted-out.tex', content: 'attacker bytes\n' });
check(r.isError && /symbolic link/.test(r.text), `write_file refuses a link (got ${JSON.stringify(r.text)})`);
r = await call('write_file', { project: id, path: 'planteddir/new.tex', content: 'attacker bytes\n' });
check(r.isError && /symbolic link/.test(r.text), `write_file refuses a path through a linked folder (got ${JSON.stringify(r.text)})`);
r = await call('edit_file', { project: id, path: 'planted.tex', edits: [{ quote: 'victim', replacement: 'x' }] });
check(r.isError && /symbolic link/.test(r.text), `edit_file refuses a link (got ${JSON.stringify(r.text)})`);
r = await call('batch_write', { project: id, message: 'Add a', files: [{ path: 'planteddir/a.tex', content: 'x' }] });
check(r.isError && /symbolic link/.test(r.text), `batch_write refuses a path through a linked folder (got ${JSON.stringify(r.text)})`);
untouched('MCP');
r = await call('read_file', { project: id, path: 'abs.tex' });
check(!r.isError && JSON.parse(r.text).content === secretFile, 'read_file serves a link checked out as a file: its target path, nothing more');
check(fs.readFileSync(secretFile, 'utf8').includes('victim@example.com'), 'the META_DIR record is intact');

// collab: no document is created for a link
for (const p of ['planted.tex', 'planteddir/x.tex']) {
  let refused = false;
  try { await (await collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', p), {})).disconnect(); } catch { refused = true; }
  check(refused, `a collab document for ${p} is refused`);
  eq(collab.openDocContent(id, 'main', p), null, `no document stays loaded for ${p}`);
}
untouched('collab');

await client.close();
await mcp.close();
await app.close();
console.log('repo-symlinks: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
