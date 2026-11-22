#!/usr/bin/env node
'use strict';
/**
 * Aldine runner, experimental preview (docs/RUNNER.md is the design and the
 * threat model; every decision referred to as D<n> is from there).
 *
 * The control process listens on a Unix socket and takes one job per
 * connection, one connection at a time. A request is a frame stream
 * (frames.js): HEADER { v: 1, command, timeoutS }, the project's files as
 * FILE frames, END. The answer is HEADER { ok, exitCode, signal, timedOut,
 * durationMs, log, deleted, runner: { version, packages } } followed by
 * the created or changed files (FILE) and the files left out (SKIP), END;
 * or HEADER { ok: false, error }, END.
 * HEADER { v: 1, health: true } answers HEADER { ok, ready, problem,
 * runner }, END.
 *
 * The control process never touches job files itself: unpacking, killing,
 * collecting and emptying run as the job user (helper.js), and the command
 * runs as the job user under prlimit.
 *
 * RUNNER_INSECURE_DEV=1 runs everything as the current user without the
 * container checks, for tests and development on a workstation only.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const frames = require('./frames.js');
const { pathProblem, foldKey } = require('./paths.js');

const DEV = process.env.RUNNER_INSECURE_DEV === '1';
const SOCKET = process.env.RUNNER_SOCKET || '/run/aldine-runner/runner.sock';
const WORK = process.env.RUNNER_WORK || '/work';
const PROJECT = path.join(WORK, 'project');
const HELPER = path.join(__dirname, 'helper.js');
const JOB_UID = 10101;
const JOB_GID = 10101;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/.test(process.env.RUNNER_VERSION || '') ? process.env.RUNNER_VERSION : 'dev';
const PACKAGES = (() => {
  try {
    const h = fs.readFileSync(process.env.RUNNER_PACKAGES_FILE || '/opt/aldine-runner/packages.sha256', 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(h) ? h : 'unknown';
  } catch { return 'unknown'; }
})();

const MB = 1024 * 1024;
const LIMITS = {
  inputFiles: 2000,
  inputBytes: 64 * MB,
  outputFiles: 50,
  outputFileBytes: 32 * MB,
  outputBytes: 64 * MB,
  logBytes: 200 * 1024,
  timeoutS: 120,
  maxTimeoutS: 600,
  // The job's own process limit; the container's pids_limit is the hard cap.
  processes: 96,
  openFiles: 256,
};
const UPLOAD_DEADLINE_MS = 60_000;
const STEP_DEADLINE_MS = 60_000;
/** Frame overhead allowance on top of the content limits. */
const SLACK = 4 * MB;

// --- container checks (D5) -------------------------------------------------

/** Why this container must not run jobs, or null. Checked once at start. */
function containerProblem() {
  if (DEV) return process.getuid && process.getuid() === 0 ? 'RUNNER_INSECURE_DEV=1 is for tests on a workstation and never runs as user 0' : null;
  try {
    if (process.getuid() !== 0) return 'the control process must run as user 0 inside the container (it starts jobs as uid 10101)';
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const field = (name) => (status.match(new RegExp(`^${name}:\\s*(\\S+)`, 'm')) || [])[1];
    // CAP_SETGID (6) and CAP_SETUID (7) only.
    if (BigInt(`0x${field('CapBnd') || 'f'}`) !== 0xc0n) return 'capabilities other than SETUID and SETGID are not dropped (cap_drop: ALL, cap_add: [SETUID, SETGID])';
    if (field('NoNewPrivs') !== '1') return 'no-new-privileges is not set';
    if (field('Seccomp') !== '2') return 'no seccomp filter is active (the Docker host runs containers unconfined)';
    // A network namespace always holds a few tunnel devices the kernel made,
    // switched off; what counts is an interface that is up, or any route.
    const up = fs.readdirSync('/sys/class/net').filter((n) => {
      if (n === 'lo') return false;
      try { return (parseInt(fs.readFileSync(`/sys/class/net/${n}/flags`, 'utf8'), 16) & 1) === 1; } catch { return false; }
    });
    const routes = ['/proc/net/route', '/proc/net/ipv6_route'].flatMap((f) => {
      try { return fs.readFileSync(f, 'utf8').split('\n').slice(f.endsWith('6_route') ? 0 : 1).filter((l) => l.trim() && !/\slo\s*$/.test(l)); } catch { return []; }
    });
    if (up.length || routes.length) return `the container has a network (${up.join(', ') || 'a route'}); it needs network_mode: none`;
    if (process.pid === 1) return 'the control process must not be the container\'s init (init: true)';
    const cg = (f) => { try { return fs.readFileSync(`/sys/fs/cgroup/${f}`, 'utf8').trim(); } catch { return null; } };
    if (cg('memory.max') === 'max') return 'the container has no memory limit (mem_limit)';
    if (cg('pids.max') === 'max') return 'the container has no process limit (pids_limit)';
    if (cg('cpu.max')?.startsWith('max')) return 'the container has no CPU limit (cpus)';
    // A permissive seccomp filter would still say "Seccomp: 2": the job user
    // must not be able to make a user namespace.
    const userns = require('child_process').spawnSync('unshare', ['--user', 'true'], { uid: JOB_UID, gid: JOB_GID, stdio: 'ignore', timeout: 5000 });
    if (userns.status === 0) return 'the job user can create user namespaces; use Docker\'s default seccomp profile';
    const work = fs.statSync(WORK);
    if (work.uid !== JOB_UID || (work.mode & 0o777) !== 0o700) return `${WORK} must be owned by uid ${JOB_UID} with mode 0700`;
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
    const workMount = mounts.find((l) => l.split(' ')[4] === WORK);
    if (!workMount || !/ - tmpfs /.test(workMount)) return `${WORK} must be a tmpfs`;
    const rootMount = mounts.find((l) => l.split(' ')[4] === '/');
    if (!rootMount || !/^ro[,\s]|,ro[,\s]|^ro$/.test(rootMount.split(' ')[5])) return 'the root filesystem must be read-only (read_only: true)';
  } catch (err) {
    return `the container could not be checked: ${err.message}`;
  }
  return null;
}

// --- killing the job (D6) -----------------------------------------------------

/** Every process of the job user, from /proc. */
function jobProcesses() {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let status;
    try { status = fs.readFileSync(`/proc/${name}/status`, 'utf8'); } catch { continue; }
    const uids = (status.match(/^Uid:\s+(.*)$/m) || [])[1];
    if (uids && uids.split(/\s+/).some((u) => Number(u) === JOB_UID)) out.push(Number(name));
  }
  return out;
}

/**
 * Kills every process of the job user from inside the control process, so
 * no job process can stop it before it acts (a separate helper could be
 * killed while it starts). With the effective uid switched to the job user,
 * kill(-1) reaches exactly that user's processes; the control process and
 * init are never hit. A survivor, or any failure, ends the control process:
 * the container restarts with fresh tmpfs mounts and no job process.
 */
function killAllJobProcesses() {
  if (DEV) return;
  try {
    process.seteuid(JOB_UID);
    try { process.kill(-1, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  } catch (e) {
    restart(`killing the job's processes failed: ${e.message}`);
  } finally {
    try { process.seteuid(0); } catch (e) { restart(`could not switch back after killing: ${e.message}`); }
  }
  // SIGKILL is delivered at once, but a dying process stays in /proc until reaped.
  const until = Date.now() + 3000;
  let left = jobProcesses();
  while (left.length && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    left = jobProcesses().filter((pid) => {
      try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; }
    });
  }
  if (left.length) restart(`job processes survived the kill: ${left.join(', ')}`);
}

/** Leaves the container to restart it from nothing (restart: unless-stopped). */
function restart(why) {
  console.error(`[runner] ${why}; exiting so the container starts fresh`);
  process.exit(1);
}

// --- steps run as the job user ---------------------------------------------

const asJob = DEV ? {} : { uid: JOB_UID, gid: JOB_GID };
const helperEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', RUNNER_WORK: WORK, ...(DEV ? { RUNNER_INSECURE_DEV: '1' } : {}), ...(process.env.RUNNER_MPL_CACHE ? { RUNNER_MPL_CACHE: process.env.RUNNER_MPL_CACHE } : {}) };

/** Empties every place a job writes, with no job process alive (the kill
 *  comes first). Anything left over ends the control process (restart). */
async function wipe() {
  killAllJobProcesses();
  try { await step('wipe'); } catch (e) { restart(`emptying ${WORK} failed: ${e.message}`); }
  killAllJobProcesses();
  if (!DEV) {
    let left = [];
    // /work is the job user's (mode 0700): read it as that user, with no job process alive.
    try { process.seteuid(JOB_UID); left = fs.readdirSync(WORK); } catch (e) { restart(`${WORK} could not be read: ${e.message}`); } finally { process.seteuid(0); }
    if (left.length) restart(`${WORK} is not empty after the wipe (${left.slice(0, 5).join(', ')})`);
  }
}

/** Runs helper.js <step> as the job user; resolves with its stdout. */
function step(name, input, { maxOut = 1 * MB } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, name], { ...asJob, env: helperEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let outBytes = 0;
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, STEP_DEADLINE_MS);
    child.stdout.on('data', (c) => {
      outBytes += c.length;
      if (outBytes > maxOut) { child.kill('SIGKILL'); return; }
      out.push(c);
    });
    child.stderr.on('data', (c) => { if (err.length < 4000) err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (outBytes > maxOut) return reject(new Error(`${name}: more output than allowed`));
      if (code !== 0) return reject(new Error(`${name} failed: ${err.trim() || `exit ${code}`}`));
      resolve(Buffer.concat(out));
    });
    child.stdin.on('error', () => { /* the step exited early; its exit code says why */ });
    if (input) for (const b of input) child.stdin.write(b);
    child.stdin.end();
  });
}

/** Keeps the first and the last half of `max` bytes of a stream. */
class LogTail {
  constructor(max) { this.half = Math.floor(max / 2); this.head = []; this.headBytes = 0; this.tail = []; this.tailBytes = 0; this.total = 0; }
  push(c) {
    this.total += c.length;
    if (this.headBytes < this.half) {
      const take = c.subarray(0, this.half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      c = c.subarray(take.length);
    }
    if (!c.length) return;
    this.tail.push(c);
    this.tailBytes += c.length;
    while (this.tailBytes - this.tail[0].length >= this.half) { this.tailBytes -= this.tail[0].length; this.tail.shift(); }
  }
  text() {
    const head = Buffer.concat(this.head).toString('utf8');
    if (this.total <= this.headBytes + this.tailBytes) return head + Buffer.concat(this.tail).toString('utf8');
    const tail = Buffer.concat(this.tail);
    const cut = this.total - this.headBytes - Math.min(tail.length, this.half);
    return `${head}\n[… ${Math.ceil(cut / 1000)} KB of output left out …]\n${tail.subarray(Math.max(0, tail.length - this.half)).toString('utf8')}`;
  }
}

function jobEnv() {
  const home = path.join(WORK, 'home');
  return {
    PATH: '/opt/venv/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: home,
    TMPDIR: path.join(WORK, 'tmp'),
    MPLCONFIGDIR: path.join(home, '.config', 'matplotlib'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TEXMFVAR: path.join(home, '.texlive'),
    MPLBACKEND: 'Agg',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    // The container has one core: math libraries that start a thread per
    // host core only spin against the CPU limit.
    OMP_NUM_THREADS: '1',
    OPENBLAS_NUM_THREADS: '1',
    MKL_NUM_THREADS: '1',
  };
}

/** Runs the command; resolves once the command ended or timed out and every
 *  job process is gone. */
function runCommand(command, timeoutS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = new LogTail(LIMITS.logBytes);
    const argv = DEV
      ? ['/bin/sh', ['-c', command]]
      // The folder is entered as the job user: the control process itself may
      // not enter /work (mode 0700, owned by the job user), and Node changes
      // directory before it changes user.
      : ['prlimit', [`--cpu=${timeoutS}`, `--fsize=${LIMITS.outputFileBytes}`, `--nofile=${LIMITS.openFiles}`, `--nproc=${LIMITS.processes}`, '--core=0', '--',
        // oom_score_adj 1000: under memory pressure the kernel kills the job
        // first, never the control process (a process may raise its own).
        '/bin/sh', '-c', 'echo 1000 > /proc/self/oom_score_adj; cd "$1" && exec /bin/sh -c "$2"', 'sh', PROJECT, command]];
    const child = spawn(argv[0], argv[1], { ...asJob, ...(DEV ? { cwd: PROJECT } : {}), env: jobEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    let exit = null;
    let open = 2;
    let finished = false;
    const killJob = async () => {
      if (DEV) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } return; }
      killAllJobProcesses();
    };
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Background processes the command left behind die here, before
      // anything is collected (D6).
      await killJob();
      // Their copies of the pipes close with them; wait briefly for the rest of the log.
      await new Promise((r) => { if (open === 0) r(); else { const t = setTimeout(r, 5000); const check = setInterval(() => { if (open === 0) { clearTimeout(t); clearInterval(check); r(); } }, 20); setTimeout(() => clearInterval(check), 5100); } });
      resolve({ exitCode: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, durationMs: Date.now() - started, log: log.text() });
    };
    const timer = setTimeout(() => { timedOut = true; finish(); }, timeoutS * 1000);
    for (const s of [child.stdout, child.stderr]) {
      s.on('data', (c) => log.push(c));
      s.on('close', () => { open -= 1; });
    }
    child.on('error', (e) => { log.push(Buffer.from(`\n${e.message}\n`)); exit = { code: null, signal: null }; finish(); });
    child.on('exit', (code, signal) => { exit = { code, signal }; finish(); });
  });
}

// --- one job ----------------------------------------------------------------

async function runJob(head, inputFiles) {
  const command = typeof head.command === 'string' ? head.command : '';
  if (!command.trim() || command.length > 2000) return { error: 'The command must be 1 to 2000 characters' };
  const timeoutS = Math.min(LIMITS.maxTimeoutS, Math.max(1, Math.floor(Number(head.timeoutS) || LIMITS.timeoutS)));

  const manifest = {};
  for (const f of inputFiles) manifest[f.path] = crypto.createHash('sha256').update(f.content).digest('hex');

  await wipe();
  await step('unpack', [...inputFiles.map((f) => frames.file(f.path, f.content)), frames.end()]);
  const result = await runCommand(command, timeoutS);
  const collected = await step('collect', [frames.header({ manifest, limits: { maxFiles: LIMITS.outputFiles, maxFileBytes: LIMITS.outputFileBytes, maxTotalBytes: LIMITS.outputBytes } }), frames.end()], { maxOut: LIMITS.outputBytes + SLACK });

  // The collector ran as the job user: its output is checked like the job's own.
  const reader = new frames.Reader({ maxFrame: LIMITS.outputFileBytes + 70_000, maxTotal: LIMITS.outputBytes + SLACK });
  const files = [];
  const skipped = [];
  const keys = new Set();
  let deleted = 0;
  let total = 0;
  for (const f of reader.push(collected)) {
    if (f.type === frames.FILE) {
      const problem = pathProblem(f.path) || (keys.has(foldKey(f.path)) ? 'another returned file has the same name' : null)
        || (files.length >= LIMITS.outputFiles || total + f.content.length > LIMITS.outputBytes ? 'over the limit for files a run may bring back' : null);
      if (problem) { skipped.push({ path: String(f.path).slice(0, 300), reason: problem }); continue; }
      keys.add(foldKey(f.path));
      total += f.content.length;
      files.push(f);
    } else if (f.type === frames.SKIP) {
      if (skipped.length < 200) skipped.push({ path: String(f.value?.path ?? '').slice(0, 300), reason: String(f.value?.reason ?? '').slice(0, 200) });
    } else if (f.type === frames.HEADER) {
      deleted = Number.isSafeInteger(f.value?.deleted) ? f.value.deleted : 0;
    }
  }
  if (!reader.ended) throw new Error('the collector stopped early');
  return { ...result, deleted, files, skipped };
}

// --- the socket ---------------------------------------------------------------

let busy = false;
const problem = containerProblem();
if (problem) console.error(`[runner] NOT READY: ${problem}. Every job is refused until the container is fixed (docs/RUNNER.md).`);

function answer(sock, head, files = [], skipped = []) {
  if (sock.destroyed) return;
  sock.write(frames.header(head));
  for (const s of skipped) sock.write(frames.skip(s.path, s.reason));
  for (const f of files) sock.write(frames.file(f.path, f.content));
  sock.end(frames.end());
}

function handle(sock) {
  if (busy) { answer(sock, { ok: false, error: 'The runner is busy with another job' }); return; }
  busy = true;
  const reader = new frames.Reader({ maxFrame: LIMITS.inputBytes + 70_000, maxTotal: LIMITS.inputBytes + SLACK });
  const got = [];
  let done = false;
  let inputBytes = 0;
  const release = () => { busy = false; };
  const fail = (error) => { if (done) return; done = true; clearTimeout(deadline); answer(sock, { ok: false, error }); release(); };
  const deadline = setTimeout(() => fail('The job was not sent in time'), UPLOAD_DEADLINE_MS);
  sock.on('error', () => {});
  sock.on('close', () => { if (!done) { done = true; clearTimeout(deadline); release(); } });
  sock.on('data', (chunk) => {
    if (done) return;
    let parsed;
    try { parsed = reader.push(chunk); } catch (e) { fail(`The job could not be read: ${e.message}`); return; }
    for (const f of parsed) {
      if (f.type === frames.FILE) {
        inputBytes += f.content.length;
        const p = pathProblem(f.path);
        if (p) return fail(`The project file ${JSON.stringify(f.path).slice(0, 200)} cannot be sent to the runner: ${p}`);
        if (got.filter((g) => g.type === frames.FILE).length >= LIMITS.inputFiles) return fail(`The project has more than ${LIMITS.inputFiles} files`);
        if (inputBytes > LIMITS.inputBytes) return fail(`The project is larger than ${LIMITS.inputBytes / MB} MB`);
      }
      got.push(f);
    }
    if (!reader.ended) return;
    done = true;
    clearTimeout(deadline);
    sock.pause();
    const head = got.find((f) => f.type === frames.HEADER)?.value || {};
    const runner = { version: VERSION, packages: PACKAGES };
    if (head.health) { answer(sock, { ok: true, ready: !problem, problem, insecure: DEV, runner }); release(); return; }
    if (head.v !== 1) { answer(sock, { ok: false, error: 'This runner does not understand the request; update the app and the runner together' }); release(); return; }
    if (problem) { answer(sock, { ok: false, error: `The runner container is not set up safely: ${problem}` }); release(); return; }
    runJob(head, got.filter((f) => f.type === frames.FILE))
      .then((r) => {
        if (r.error) return answer(sock, { ok: false, error: r.error });
        const { files, skipped, ...rest } = r;
        answer(sock, { ok: true, ...rest, insecure: DEV, runner }, files, skipped);
      })
      .catch((e) => answer(sock, { ok: false, error: `The runner failed: ${e.message}` }))
      // Nothing of this job may reach the next one (D6): the next job waits for the wipe.
      .finally(() => wipe().then(release));
  });
}

function listen() {
  const dir = path.dirname(SOCKET);
  if (!DEV) {
    // The job user may connect (and learn the runner is busy) but never
    // replace or remove the socket.
    fs.chmodSync(dir, 0o755);
  }
  try { fs.unlinkSync(SOCKET); } catch { /* none yet */ }
  const server = net.createServer({ allowHalfOpen: true }, handle);
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o666);
    console.log(`[runner] listening on ${SOCKET}, version ${VERSION}, packages ${PACKAGES.slice(0, 12)}, ${problem ? 'NOT READY' : 'ready'}${DEV ? ' (INSECURE DEV MODE)' : ''}`);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); try { fs.unlinkSync(SOCKET); } catch { /* gone */ } process.exit(0); });
}

if (require.main === module) listen();

module.exports = { LIMITS, LogTail };
