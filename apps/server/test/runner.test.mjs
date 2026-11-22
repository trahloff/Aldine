/**
 * The runner, experimental preview (docs/RUNNER.md): who may start a run
 * (D10), what comes back and how it lands (D8, D9), and the app's defences
 * against a hostile runner (D3, D7). Real route table (Fastify inject) on a
 * throwaway datastore, against apps/runner/server.js in its insecure dev
 * mode (no container, no second user), which keeps the protocol and the
 * output rules the container uses.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-runner-')));
const socket = path.join(tmp, 'r.sock');
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
process.env.ALDINE_RUNNER_SOCKET = socket;
process.env.ALDINE_RUNNER_USERS = 'Owner@example.com, ed@example.org';
process.env.ALDINE_RUNNER_TIMEOUT_S = '20';
process.env.ALDINE_RUNNER_ALLOW_INSECURE = '1';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SES_FROM', 'SMTP_HOST', 'ALDINE_PUBLIC_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_BASE_PATH', 'ALDINE_TEST_HOOKS']) delete process.env[k];

const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const runnerScript = fileURLToPath(new URL('../../runner/server.js', import.meta.url));
const runnerProc = spawn(process.execPath, [runnerScript], { env: { ...process.env, RUNNER_INSECURE_DEV: '1', RUNNER_SOCKET: socket, RUNNER_WORK: work }, stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => runnerProc.kill('SIGKILL'));
for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await new Promise((r) => setTimeout(r, 50));
check(fs.existsSync(socket), 'the dev runner started');

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const runner = await import('../src/runner.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);
await app.ready();

const call = (method, url, who, payload, headers = {}) => app.inject({ method, url, headers: { ...(who ? { cookie: who.cookie } : {}), ...headers }, ...(payload !== undefined ? { payload } : {}) });
const json = async (method, url, who, payload, code = 200) => {
  const res = await call(method, url, who, payload);
  eq(res.statusCode, code, `${method} ${url} as ${who?.name ?? 'nobody'}: ${res.body.slice(0, 300)}`);
  return res.json();
};
async function person(email, name) {
  const user = await auth.register(email, 'password123', name);
  await db().setEmailPending(user.id, null);
  return { id: user.id, name, email, cookie: `${auth.COOKIE}=${await auth.createSession(user.id)}` };
}
const owner = await person('owner@example.com', 'Olive');
const ed = await person('ed@example.org', 'Ed');
const stan = await person('stan@example.org', 'Stan');

async function waitFor(projectId, who, jobId) {
  // A loaded CI machine starts Python slowly; the server's own deadline is longer still.
  const until = Date.now() + 120_000;
  let job;
  while (Date.now() < until) {
    ({ job } = await json('GET', `/api/projects/${projectId}/runner/jobs/${jobId}`, who));
    if (job.status === 'done' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the run did not finish: ${JSON.stringify(job)}`);
}
const start = (projectId, who, command, branch = 'main') => call('POST', `/api/projects/${projectId}/runner/run`, who, { branch, command });
async function run(projectId, who, command) {
  const res = await start(projectId, who, command);
  eq(res.statusCode, 200, `run as ${who.name}: ${res.body.slice(0, 300)}`);
  return waitFor(projectId, who, res.json().job.id);
}

// ---- who may run (D10) ----
eq((await json('GET', '/api/auth/me', owner)).runner, true, 'a listed address, in any case, may use the runner');
eq((await json('GET', '/api/auth/me', stan)).runner, false, 'an address not on ALDINE_RUNNER_USERS may not');

const P = (await json('POST', '/api/projects', owner, { name: 'Figures' })).id;
await json('PUT', `/api/projects/${P}/file`, owner, { path: 'main.tex', content: '\\documentclass{article}\\begin{document}Hi\\end{document}\n' });
await json('PUT', `/api/projects/${P}/file`, owner, { path: 'data/values.csv', content: '1,2\n3,4\n' });

eq((await start(P, stan, 'true')).statusCode, 403, 'an unlisted person cannot run, even with access');
eq((await call('POST', `/api/projects/${P}/runner/run`, owner, 'command=true', { 'content-type': 'text/plain' })).statusCode, 415, 'a run is JSON only');
check([401, 403].includes((await call('POST', `/api/projects/${P}/runner/run`, owner, { command: 'true' }, { authorization: 'Bearer aldn_whatever' })).statusCode), 'a request carrying a token cannot run');
const token = (await json('POST', '/api/tokens', owner, { name: 'script' })).token;
check(typeof token === 'string', 'the owner has a real access token');
eq((await call('POST', `/api/projects/${P}/runner/run`, null, { command: 'true' }, { authorization: `Bearer ${token}` })).statusCode, 403, 'not even with the owner\'s own valid token');
eq((await call('POST', `/api/projects/${P}/runner/run`, owner, { command: 'true' }, { authorization: 'Basic eDp5' })).statusCode, 403, 'nor one with any other Authorization header');
eq((await call('POST', `/api/projects/${P}/runner/run`, owner, { command: 'true' }, { origin: 'https://evil.example' })).statusCode, 403, 'a request from another site cannot run');
eq((await start(P, owner, 'echo a\nInput: forged')).statusCode, 400, 'a command is one line');
eq((await start(P, owner, '   ')).statusCode, 400, 'an empty command is refused');

// Ed is listed but has no part in P; with an edit link he gets in, and still may not run.
eq((await start(P, ed, 'true')).statusCode, 403, 'a listed person outside the project cannot run in it');
const link = (await json('POST', `/api/projects/${P}/links`, owner, { role: 'edit' })).link;
await json('POST', '/api/share-links/join', ed, { project: P, token: link.token });
eq((await json('GET', `/api/projects/${P}`, ed)).role, 'edit', 'Ed edits through the link');
eq((await start(P, ed, 'true')).statusCode, 403, 'edit rights from a share link do not let a person run');

// A named collaborator with edit rights may; once narrowed to review, not.
const Q = (await json('POST', '/api/projects', owner, { name: 'Shared' })).id;
await json('PUT', `/api/projects/${Q}/file`, owner, { path: 'main.tex', content: 'x\n' });
await json('POST', `/api/projects/${Q}/share`, owner, { collaborators: [ed.email], previous: [] });
await json('POST', `/api/invitations/${(await json('GET', '/api/invitations', ed)).find((i) => i.project.id === Q).id}/accept`, ed);
const edRun = await run(Q, ed, 'true');
eq(edRun.status, 'done', `a named collaborator with edit rights may run: ${edRun.error}`);
const meta = await db().readMeta(Q);
await db().writeMeta({ ...meta, share: { ...meta.share, roles: { [ed.email]: 'review' } } });
eq((await start(Q, ed, 'true')).statusCode, 403, 'a collaborator whose role is review may not');

// ---- a run, and what comes back (D8, D9) ----
const job = await run(P, owner, 'cat data/values.csv > data/copy.csv; mkdir -p fig; echo plot > fig/a.pgf; ln -s /etc/passwd link.txt; echo h > .hidden; echo done; echo oops >&2; exit 0');
eq(job.status, 'done', `the run finished: ${job.error ?? ''}`);
eq(job.result.written.sort(), ['data/copy.csv', 'fig/a.pgf'], 'the new files come back');
check(job.result.log.includes('done') && job.result.log.includes('oops'), 'the log has stdout and stderr');
eq(job.result.skipped.map((s) => s.path), ['link.txt'], 'a symbolic link is listed as left out; a hidden file is silently not copied');
eq(fs.readFileSync(path.join(store.branchDir(P, 'main'), 'data/copy.csv'), 'utf8'), '1,2\n3,4\n', 'the file is in the project');
check(!('commit' in job.result), 'a run makes no commit of its own');
check(!execFileSync('git', ['-C', store.repoDir(P), 'log', '--format=%s', 'main'], { encoding: 'utf8' }).includes('Run: '), 'no Run: commit in the history');

const same = await run(P, owner, 'cat data/values.csv > data/copy.csv; rm main.tex');
eq([same.result.written, same.result.deleted], [[], 1], 'a run that changes nothing writes nothing, and a deletion is not brought back');
check(fs.existsSync(path.join(store.branchDir(P, 'main'), 'main.tex')), 'main.tex is still there');

// A file changed in Aldine while the job ran is not overwritten.
const slow = await start(P, owner, 'sleep 2; echo from-run > data/values.csv; echo new > fig/b.pgf');
eq(slow.statusCode, 200, 'the slow run starts');
eq((await start(P, owner, 'true')).statusCode, 409, 'one run per project at a time');
// The copy is taken when the job starts running; type after that.
for (let i = 0; i < 100 && (await json('GET', `/api/projects/${P}/runner/jobs/${slow.json().job.id}`, owner)).job.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
await new Promise((r) => setTimeout(r, 400));
await json('PUT', `/api/projects/${P}/file`, owner, { path: 'data/values.csv', content: 'typed meanwhile\n' });
const raced = await waitFor(P, owner, slow.json().job.id);
eq(raced.result.written, ['fig/b.pgf'], 'the untouched new file lands');
eq(raced.result.skipped, [{ path: 'data/values.csv', reason: 'changed in Aldine while the job ran' }], 'the file typed meanwhile is left out and named');
eq(fs.readFileSync(path.join(store.branchDir(P, 'main'), 'data/values.csv'), 'utf8'), 'typed meanwhile\n', 'what was typed stays');

const timed = await run(P, owner, 'sleep 60');
check(timed.result?.timedOut === true, `a job over the time limit is stopped: ${timed.error ?? ''}`);

// The runner answers before it wipes; a job sent meanwhile waits instead of failing.
const P2 = (await json('POST', '/api/projects', owner, { name: 'Second' })).id;
await json('PUT', `/api/projects/${P2}/file`, owner, { path: 'main.tex', content: 'x\n' });
const [first, second] = await Promise.all([start(P, owner, 'echo one > one.txt'), start(P2, owner, 'echo two > two.txt')]);
for (const [proj, res] of [[P, first], [P2, second]]) {
  const j = await waitFor(proj, owner, res.json().job.id);
  eq(j.status, 'done', `back-to-back jobs both run: ${j.error ?? ''}`);
}

// ---- the path rules (D8) ----
for (const [p, why] of [
  ['fig/a.pdf', null], ['é.txt'.normalize('NFC'), null],
  ['../x', 'not a plain relative path'], ['a//b', 'not a plain relative path'], ['/abs', 'not a plain relative path'],
  ['.git/config', 'hidden names (starting with ".") are not copied'], ['sub/.latexmkrc', 'hidden names (starting with ".") are not copied'],
  ['‌.git/hooks/x', 'name contains an invisible or direction character'], ['fig‮fdp.exe', 'name contains an invisible or direction character'],
  ['é.txt', 'name is not in Unicode normal form C'], ['a\u0007b', 'name contains a control character'], ['a\\b', 'name contains \\ or :'],
  ['-rf', 'names starting with "-" are not copied'], ['x/__pycache__/m.pyc', 'Python caches are not copied'], [`${'n'.repeat(256)}`, 'name too long'],
]) eq(runner.runnerPathProblem(p), why, `path ${JSON.stringify(p)}`);
eq((await start(P, owner, 'python x.py \u202e\u2066gnp.tob\u2069')).statusCode, 400, 'a command with direction characters is refused');

// ---- a hostile runner (D3, D7) ----
const hostile = path.join(tmp, 'h.sock');
const endless = net.createServer((s) => { s.on('error', () => {}); const junk = Buffer.alloc(1 << 20); const pump = () => { while (!s.destroyed && s.write(junk)); if (!s.destroyed) s.once('drain', pump); }; pump(); });
await new Promise((r) => endless.listen(hostile, r));
let err = await runner.exchange({ v: 1 }, [], 5000, hostile).then(() => null, (e) => e.message);
check(typeof err === 'string' && err.length > 0, 'an endless answer of junk is refused');
endless.close();
const flood = path.join(tmp, 'f.sock');
// Well-formed SKIP frames without end: the byte limit stops it, not memory.
const flooder = net.createServer((s) => { s.on('error', () => {}); const body = Buffer.from(JSON.stringify({ path: 'x', reason: 'y'.repeat(16000) })); const head = Buffer.alloc(5); head.writeUInt8(3, 0); head.writeUInt32BE(body.length, 1); const f = Buffer.concat([head, body]); const pump = () => { while (!s.destroyed && s.write(f)); if (!s.destroyed) s.once('drain', pump); }; pump(); });
await new Promise((r) => flooder.listen(flood, r));
err = await runner.exchange({ v: 1 }, [], 20000, flood).then(() => null, (e) => e.message);
eq(err, 'the runner sent more than allowed', 'an endless answer is cut off at the byte limit');
flooder.close();
const silent = path.join(tmp, 's.sock');
const mute = net.createServer((s) => { s.on('error', () => {}); });
await new Promise((r) => mute.listen(silent, r));
err = await runner.exchange({ v: 1 }, [], 300, silent).then(() => null, (e) => e.message);
eq(err, 'The runner did not answer in time', 'a silent runner is given up on');
mute.close();
const linked = path.join(tmp, 'l.sock');
fs.symlinkSync(socket, linked);
err = await runner.exchange({ v: 1, health: true }, [], 2000, linked).then(() => null, (e) => e.message);
eq(err, 'The runner is not running (no socket)', 'a symbolic link in place of the socket is not followed');

const r = new runner.FrameReader(10, 1000);
let threw = false;
try { r.push(Buffer.from([1, 0, 0, 0, 11])); } catch { threw = true; }
check(threw, 'a frame over the limit is refused before its bytes arrive');

console.log('runner: ok');
runnerProc.kill('SIGKILL');
process.exit(0);
