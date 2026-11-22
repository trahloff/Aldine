/**
 * The app's side of the runner, an experimental preview (docs/RUNNER.md is
 * the design and the threat model; D<n> refers to its decisions).
 *
 * The runner is assumed hostile (D3): everything it returns is checked here
 * again, its answer is read with byte and time limits, and nothing it says
 * reaches a commit message except two fields of a strict format.
 */
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AUTH_ENABLED, getUser, pub, type PublicUser } from './auth.js';
import { isBranchClosed } from './compile.js';
import { branchDir, readMeta, listFiles, writeFile, type ProjectMeta } from './store.js';
import * as gitops from './gitops.js';
import { flushBranchDocs, refreshBranchDocsFromDisk, scheduleCommit } from './collab.js';
import { noteEdit, editorOf } from './activity.js';
import { storageRefusal } from './storage.js';
import { safeJoin, isHiddenPath, optionLikePath, overlongPath } from './util.js';
import { normalizeEntry } from './invites.js';
import { rolesOf } from './sharelinks.js';

const MB = 1024 * 1024;
export const RUNNER_LIMITS = {
  inputFiles: 2000,
  inputBytes: 64 * MB,
  outputFiles: 50,
  outputFileBytes: 32 * MB,
  outputBytes: 64 * MB,
  logBytes: 200 * 1024,
  commandChars: 2000,
  waiting: 5,
};
/** On top of the job's timeout before the app treats the runner as dead: the
 *  runner's own worst case (wipe, unpack and collect at up to 60 s each, the
 *  log's 5 s) plus the upload. */
const ANSWER_MARGIN_MS = 4 * 60_000 + 30_000;
const FRAME_SLACK = 4 * MB;
const JOB_KEEP_MS = 15 * 60_000;

const SOCKET = process.env.ALDINE_RUNNER_SOCKET || '';
const USERS = new Set((process.env.ALDINE_RUNNER_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const TIMEOUT_S = Math.min(600, Math.max(1, Math.floor(Number(process.env.ALDINE_RUNNER_TIMEOUT_S) || 120)));

/** The instance turned the runner on, and sign-in is on (D10). */
export function runnerConfigured(): boolean {
  return !!SOCKET && AUTH_ENABLED;
}

if (SOCKET && !AUTH_ENABLED) console.warn('[runner] ALDINE_RUNNER_SOCKET is set but sign-in is off: the runner stays off, because without accounts there is nobody to allow (docs/RUNNER.md).');

/** This person may use the runner at all: a confirmed address on ALDINE_RUNNER_USERS. */
export function runnerAllowed(user: PublicUser | null): boolean {
  if (!runnerConfigured() || !user || user.guest || user.emailPending || !user.email) return false;
  return USERS.has(user.email.toLowerCase());
}

/**
 * The person may run jobs in this project: it has an owner, and they are the
 * owner or a collaborator named in it whose own role is edit. Rights that
 * come from a share link do not count (D10).
 */
export function mayRunIn(meta: ProjectMeta, user: PublicUser): boolean {
  if (!meta.ownerId) return false;
  if (meta.ownerId === user.id) return true;
  const email = user.emailPending ? undefined : user.email?.toLowerCase();
  const roles = rolesOf(meta);
  return (meta.share?.collaborators ?? []).some((c) =>
    ((email && c.toLowerCase() === email) || (user.orcid && c === user.orcid)) && roles[normalizeEntry(c)] === undefined); // a stored role narrows; none is edit
}

// --- paths (the same rules as apps/runner/paths.js, D8) ---------------------

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￸\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;

/** Why `rel` may not cross to or from the runner, or null. */
export function runnerPathProblem(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel === '') return 'empty path';
  if (Buffer.byteLength(rel) > 1024) return 'path too long';
  if (rel.includes('�')) return 'name is not valid UTF-8';
  if (rel.normalize('NFC') !== rel) return 'name is not in Unicode normal form C';
  if (CONTROL.test(rel)) return 'name contains a control character';
  if (INVISIBLE.test(rel)) return 'name contains an invisible or direction character';
  if (rel.includes('\\') || rel.includes(':')) return 'name contains \\ or :';
  const parts = rel.split('/');
  if (parts.length > 32) return 'folders nested too deep';
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return 'not a plain relative path';
    if (Buffer.byteLength(seg) > 255) return 'name too long';
    if (seg.startsWith('.')) return 'hidden names (starting with ".") are not copied';
    if (seg.startsWith('-')) return 'names starting with "-" are not copied';
    if (seg === '__pycache__') return 'Python caches are not copied';
  }
  if (isHiddenPath(rel) || optionLikePath(rel)) return 'not a project file name';
  const long = overlongPath(rel);
  if (long) return long;
  return null;
}

const foldKey = (rel: string) => rel.normalize('NFKC').toLowerCase();
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Why the command cannot run, or null. One line: the panel's input is one. */
export function commandProblem(command: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return 'Type a command to run, for example python plot.py';
  if (command.length > RUNNER_LIMITS.commandChars) return `The command is longer than ${RUNNER_LIMITS.commandChars} characters`;
  if (/[\r\n\u0000]/.test(command)) return 'The command must be one line';
  if (INVISIBLE.test(command)) return 'The command contains invisible or direction characters';
  return null;
}

const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const PACKAGES_RE = /^(?:[0-9a-f]{64}|unknown)$/;

// --- frames (apps/runner/frames.js) ------------------------------------------

const F_END = 0, F_HEADER = 1, F_FILE = 2, F_SKIP = 3;

function frame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
function fileFrame(rel: string, content: Buffer): Buffer {
  const p = Buffer.from(rel, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(p.length, 0);
  return frame(F_FILE, Buffer.concat([len, p, content]));
}

type Frame = { type: 0 } | { type: 1 | 3; value: any } | { type: 2; path: string; content: Buffer };

/** Splits the runner's answer into frames, linear in the bytes read (a
 *  chunk is copied once, when its frame is whole). */
export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  total = 0;
  ended = false;
  constructor(private maxFrame: number, private maxTotal: number) {}

  private take(n: number): Buffer {
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const c = this.chunks[0];
      if (c.length <= need) { parts.push(c); this.chunks.shift(); need -= c.length; } else {
        parts.push(c.subarray(0, need));
        this.chunks[0] = c.subarray(need);
        need = 0;
      }
    }
    this.buffered -= n;
    return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, n);
  }

  push(chunk: Buffer): Frame[] {
    this.total += chunk.length;
    if (this.total > this.maxTotal) throw new Error('the runner sent more than allowed');
    if (chunk.length) { this.chunks.push(chunk); this.buffered += chunk.length; }
    const out: Frame[] = [];
    while (!this.ended && this.buffered >= 5) {
      const head = this.chunks[0].length >= 5 ? this.chunks[0] : Buffer.concat(this.chunks, 5);
      const type = head.readUInt8(0);
      const len = head.readUInt32BE(1);
      if (len > this.maxFrame) throw new Error('the runner sent a frame over the limit');
      if (this.buffered < 5 + len) break;
      this.take(5);
      const payload = this.take(len);
      if (type === F_END) {
        if (len) throw new Error('bad end frame');
        this.ended = true;
        out.push({ type: F_END });
      } else if (type === F_HEADER || type === F_SKIP) out.push({ type, value: JSON.parse(payload.toString('utf8')) });
      else if (type === F_FILE) {
        if (len < 2) throw new Error('short file frame');
        const n = payload.readUInt16BE(0);
        if (len < 2 + n) throw new Error('short file frame');
        out.push({ type: F_FILE, path: payload.subarray(2, 2 + n).toString('utf8'), content: payload.subarray(2 + n) });
      } else throw new Error(`unknown frame type ${type}`);
    }
    if (this.ended && this.buffered) throw new Error('bytes after the end frame');
    return out;
  }
}

/** One exchange with the runner: sends `head` and the files, reads the answer
 *  with limits. Rejects when the runner is missing, slow or breaks the format. */
export async function exchange(head: object, files: Array<{ path: string; read: () => Promise<Buffer> }>, deadlineMs: number, socketPath = SOCKET): Promise<Frame[]> {
  // connect() follows a symbolic link; the socket must be the socket (D7).
  const st = await fs.promises.lstat(socketPath).catch(() => null);
  if (!st || !st.isSocket()) throw new Error('The runner is not running (no socket)');
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: socketPath, allowHalfOpen: true });
    const reader = new FrameReader(RUNNER_LIMITS.outputFileBytes + 70_000, RUNNER_LIMITS.outputBytes + FRAME_SLACK);
    const got: Frame[] = [];
    let settled = false;
    const done = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(got);
    };
    const timer = setTimeout(() => done(new Error('The runner did not answer in time')), deadlineMs);
    sock.on('error', (e) => done(new Error(`The runner could not be reached: ${e.message}`)));
    sock.on('data', (c: Buffer) => {
      try { got.push(...reader.push(c)); } catch (e) { done(e as Error); return; }
      if (reader.ended) done(null);
    });
    sock.on('end', () => done(reader.ended ? null : new Error('The runner closed the connection early')));
    const write = (b: Buffer) => new Promise<void>((ok) => { if (sock.write(b)) ok(); else sock.once('drain', () => ok()); });
    sock.on('connect', async () => {
      try {
        await write(frame(F_HEADER, Buffer.from(JSON.stringify(head))));
        for (const f of files) {
          if (settled) return;
          await write(fileFrame(f.path, await f.read()));
        }
        sock.end(frame(F_END));
      } catch (e) { done(e as Error); }
    });
  });
}

/** Whether the runner answers and passed its container checks, for the admin's log. */
export async function runnerHealth(): Promise<{ ready: boolean; problem: string | null; version: string | null }> {
  try {
    const got = await exchange({ v: 1, health: true }, [], 5000);
    const h = got.find((f): f is { type: 1; value: any } => f.type === F_HEADER)?.value ?? {};
    return { ready: h.ready === true, problem: typeof h.problem === 'string' ? h.problem.slice(0, 300) : null, version: VERSION_RE.test(h.runner?.version ?? '') ? h.runner.version : null };
  } catch (e) {
    return { ready: false, problem: (e as Error).message, version: null };
  }
}

// --- jobs ---------------------------------------------------------------------

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  log: string;
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
  deleted: number;
  input: string;
  runner: { version: string; packages: string };
}

export interface RunJob {
  id: string;
  projectId: string;
  branch: string;
  userId: string;
  command: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: number;
  error?: string;
  result?: RunResult;
}

const jobs = new Map<string, RunJob>();
const waiting: Array<{ job: RunJob; user: PublicUser }> = [];
let running: RunJob | null = null;

setInterval(() => {
  const cutoff = Date.now() - JOB_KEEP_MS;
  for (const [id, j] of jobs) if ((j.status === 'done' || j.status === 'failed') && j.createdAt < cutoff) jobs.delete(id);
}, 60_000).unref?.();

/** A job of this person, with its place in the line while it waits. */
export function jobView(id: string, userId: string): (RunJob & { position?: number }) | null {
  const j = jobs.get(id);
  if (!j || j.userId !== userId) return null;
  const position = waiting.findIndex((w) => w.job.id === id);
  return { ...j, ...(position >= 0 ? { position: position + 1 } : {}) };
}

/** Queues a job (D4). Returns the job, or why it cannot be queued. */
export function enqueue(projectId: string, branch: string, user: PublicUser, command: string): RunJob | string {
  const busy = (j: RunJob) => j.projectId === projectId && (j.status === 'queued' || j.status === 'running');
  if ((running && busy(running)) || waiting.some((w) => busy(w.job))) return 'A run of this project is already waiting or running';
  if (waiting.length >= RUNNER_LIMITS.waiting) return 'The runner has too many jobs waiting; try again in a minute';
  const job: RunJob = { id: crypto.randomBytes(12).toString('hex'), projectId, branch, userId: user.id, command, status: 'queued', createdAt: Date.now() };
  jobs.set(job.id, job);
  waiting.push({ job, user });
  void next();
  return job;
}

async function next(): Promise<void> {
  if (running) return;
  const item = waiting.shift();
  if (!item) return;
  running = item.job;
  try {
    item.job.result = await runJob(item.job, item.user);
    item.job.status = 'done';
  } catch (e) {
    item.job.status = 'failed';
    item.job.error = (e as Error).message.slice(0, 500);
  } finally {
    running = null;
    void next();
  }
}

async function runJob(job: RunJob, user: PublicUser): Promise<RunResult> {
  const { projectId: id, branch } = job;
  // 1. The run starts from the files as they are: pending typing is flushed.
  const { input, sent: listed, contents } = await gitops.withRepoLock(id, async () => {
    await gitops.ensureWorktree(id, branch);
    flushBranchDocs(id, branch);
    const head = await gitops.branchHead(id, branch);
    const entries = listFiles(id, branch).filter((e) => e.type === 'file');
    // Read under the repo lock, so no commit or checkout moves files meanwhile.
    const contents = new Map<string, Buffer>();
    let bytes = 0;
    for (const e of entries) {
      if (runnerPathProblem(e.path)) continue;
      bytes += e.size ?? 0;
      if (bytes > RUNNER_LIMITS.inputBytes) throw new Error(`The project is larger than ${RUNNER_LIMITS.inputBytes / MB} MB`);
      contents.set(e.path, await fs.promises.readFile(safeJoin(branchDir(id, branch), e.path)));
    }
    return { input: head, sent: entries, contents };
  });
  // "running" means the copy is taken: typing from here on is not in the run.
  job.status = 'running';
  // Hidden files (.gitignore, .latexmkrc) stay out of the copy, as they would
  // stay out of what comes back; other names the runner refuses are named.
  const notSent: Array<{ path: string; reason: string }> = [];
  const sent = listed.filter((e) => {
    const problem = runnerPathProblem(e.path);
    if (problem && !e.path.split('/').some((seg) => seg.startsWith('.'))) notSent.push({ path: e.path.slice(0, 300), reason: `not sent to the runner: ${problem}` });
    return !problem;
  });
  if (sent.length > RUNNER_LIMITS.inputFiles) throw new Error(`The project has more than ${RUNNER_LIMITS.inputFiles} files`);
  let total = 0;
  for (const e of sent) total += e.size ?? 0;
  if (total > RUNNER_LIMITS.inputBytes) throw new Error(`The project is larger than ${RUNNER_LIMITS.inputBytes / MB} MB`);

  // 2. What was sent, as the app itself read it (D8: never the runner's claim).
  const sentHash = new Map<string, string>();
  const base = branchDir(id, branch);
  for (const [p, c] of contents) sentHash.set(p, sha256(c));
  const files = sent.filter((e) => contents.has(e.path)).map((e) => ({ path: e.path, read: async () => contents.get(e.path)! }));
  const got = await exchange({ v: 1, command: job.command, timeoutS: TIMEOUT_S }, files, TIMEOUT_S * 1000 + ANSWER_MARGIN_MS);

  const head = got.find((f): f is { type: 1; value: any } => f.type === F_HEADER)?.value;
  if (!head || typeof head !== 'object') throw new Error('The runner sent no answer');
  if (head.ok !== true) throw new Error(typeof head.error === 'string' ? head.error.slice(0, 500) : 'The runner refused the job');
  // The development mode runs jobs without the container's protections.
  if (head.insecure !== false && process.env.ALDINE_RUNNER_ALLOW_INSECURE !== '1') throw new Error('The runner runs in its insecure development mode (RUNNER_INSECURE_DEV); its result is not used');
  const runner = {
    version: VERSION_RE.test(head.runner?.version ?? '') ? head.runner.version : 'unknown',
    packages: PACKAGES_RE.test(head.runner?.packages ?? '') ? head.runner.packages : 'unknown',
  };

  // 3. Every returned file is checked again (D3, D8).
  const skipped: Array<{ path: string; reason: string }> = [...notSent.slice(0, 50)];
  const skip = (p: unknown, reason: string) => { if (skipped.length < 200) skipped.push({ path: String(p).slice(0, 300), reason: String(reason).slice(0, 200) }); };
  for (const f of got) if (f.type === F_SKIP) skip(f.value?.path ?? '', f.value?.reason ?? 'left out by the runner');
  // Every file and folder of the project, by its folded name: "Figs/x.png"
  // must not land next to a folder "figs".
  const existing = new Map<string, string>();
  for (const e of listFiles(id, branch)) existing.set(foldKey(e.path), e.path);
  const prefixes = (p: string) => p.split('/').map((_, i, segs) => segs.slice(0, i + 1).join('/'));
  const acceptedPrefix = new Map<string, string>();
  const existingTypes = new Map(listFiles(id, branch).map((e) => [e.path, e.type]));
  const accepted: Array<{ path: string; content: Buffer; hash: string }> = [];
  const keys = new Set<string>();
  let outBytes = 0;
  for (const f of got) {
    if (f.type !== F_FILE) continue;
    const problem = runnerPathProblem(f.path);
    if (problem) { skip(f.path, problem); continue; }
    const hash = sha256(f.content);
    if (sentHash.get(f.path) === hash) continue;
    const key = foldKey(f.path);
    if (keys.has(key)) { skip(f.path, 'another returned file has the same name'); continue; }
    const clash = prefixes(f.path).map((p) => {
      const k = foldKey(p);
      const there = existing.get(k) ?? acceptedPrefix.get(k);
      return there !== undefined && there !== p ? there : null;
    }).find((x) => x !== null);
    if (clash) { skip(f.path, `the project has "${clash}", which differs only in case or form`); continue; }
    if (existingTypes.get(f.path) === 'dir') { skip(f.path, 'the project has a folder with this name'); continue; }
    const segs = f.path.split('/');
    const parentFile = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('/')).find((p) => existingTypes.get(p) === 'file');
    if (parentFile) { skip(f.path, `"${parentFile}" is a file in the project`); continue; }
    if (f.content.length > RUNNER_LIMITS.outputFileBytes) { skip(f.path, `larger than ${RUNNER_LIMITS.outputFileBytes / MB} MB`); continue; }
    if (accepted.length >= RUNNER_LIMITS.outputFiles || outBytes + f.content.length > RUNNER_LIMITS.outputBytes) { skip(f.path, 'over the limit for files a run may bring back'); continue; }
    keys.add(key);
    for (const p of prefixes(f.path)) acceptedPrefix.set(foldKey(p), p);
    outBytes += f.content.length;
    accepted.push({ path: f.path, content: f.content, hash });
  }
  // A returned file inside another returned file's name ("a" and "a/b").
  const acceptedPaths = new Set(accepted.map((a) => a.path));
  for (let i = accepted.length - 1; i >= 0; i--) {
    const segs = accepted[i].path.split('/');
    const outer = segs.slice(0, -1).map((_, k) => segs.slice(0, k + 1).join('/')).find((p) => acceptedPaths.has(p));
    if (outer) { skip(accepted[i].path, `"${outer}" is also a returned file`); accepted.splice(i, 1); }
  }

  const result = (written: string[]): RunResult => ({
    exitCode: Number.isSafeInteger(head.exitCode) ? head.exitCode : null,
    signal: typeof head.signal === 'string' && /^SIG[A-Z0-9]{1,10}$/.test(head.signal) ? head.signal : null,
    timedOut: head.timedOut === true,
    durationMs: Number.isFinite(head.durationMs) ? Math.max(0, Math.round(head.durationMs)) : 0,
    log: typeof head.log === 'string' ? head.log.slice(0, RUNNER_LIMITS.logBytes + 200) : '',
    written,
    skipped,
    deleted: Number.isSafeInteger(head.deleted) ? Math.max(0, head.deleted) : 0,
    input,
    runner,
  });
  if (!accepted.length) return result([]);

  // 4. Storage first (it awaits); then flush, check and write with no await
  //    in between, the way a save from the editor does (D8).
  const growth = accepted.reduce((n, a) => n + a.content.length - (existingTypes.get(a.path) === 'file' ? fs.statSync(safeJoin(base, a.path), { throwIfNoEntry: false })?.size ?? 0 : 0), 0);
  const meta = await readMeta(id);
  const refusal = growth > 0 ? await storageRefusal(meta.ownerId, user.id, growth, 'upload') : null;
  if (refusal) {
    for (const a of accepted) skip(a.path, 'the project owner\'s storage is full');
    return result([]);
  }
  return gitops.withRepoLock(id, async () => {
    // Up to the queue's length times the timeout may have passed since the
    // job was accepted: the person, the project and the branch are checked again.
    const metaNow = await readMeta(id).catch(() => null);
    const userNow = await getUser(user.id).catch(() => null);
    const stillAllowed = !!metaNow && !metaNow.deletedAt && !!userNow && !userNow.disabledAt && runnerAllowed(pub(userNow)) && mayRunIn(metaNow, pub(userNow));
    if (!stillAllowed || isBranchClosed(id, branch) || !(await gitops.branchHead(id, branch))) {
      for (const a of accepted) skip(a.path, 'not written: access to the project or the branch changed while the job ran');
      return result([]);
    }
    flushBranchDocs(id, branch);
    const written: string[] = [];
    for (const a of accepted) {
      const abs = safeJoin(base, a.path);
      let now: Buffer | null = null;
      try { now = fs.readFileSync(abs); } catch { now = null; }
      const before = sentHash.get(a.path);
      if (before !== undefined && (now === null || sha256(now) !== before)) { skip(a.path, now === null ? 'deleted or renamed in Aldine while the job ran' : 'changed in Aldine while the job ran'); continue; }
      if (before === undefined && now !== null) { skip(a.path, 'created in Aldine while the job ran'); continue; }
      try { writeFile(id, branch, a.path, a.content); written.push(a.path); } catch { skip(a.path, 'could not be written'); }
    }
    if (!written.length) return result([]);
    refreshBranchDocsFromDisk(id, branch, written);
    noteEdit(id, branch, editorOf(user));
    // Like any other save: the files reach history with the next autosave.
    scheduleCommit(id, branch);
    return result(written);
  });
}

/** Test hook: the queue, emptied. */
export function _resetRunnerForTests(): void {
  jobs.clear();
  waiting.length = 0;
  running = null;
}
