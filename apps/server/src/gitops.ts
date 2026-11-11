import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { projectsDir } from './config.js';
import { repoDir, branchDir, git, readMeta, removeTree } from './store.js';
import { spawn } from 'node:child_process';
import { BRANCH_RE } from './util.js';

export interface BranchInfo { name: string; current?: boolean; head: string; message: string; date: string }

export async function listBranches(id: string): Promise<BranchInfo[]> {
  const g = git(repoDir(id));
  const raw = await g.raw(['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(objectname:short)%09%(committerdate:iso8601)%09%(contents:subject)']);
  return raw.trim().split('\n').filter(Boolean).map((line) => {
    const [name, head, date, ...msg] = line.split('\t');
    return { name, head, date, message: msg.join('\t') };
  });
}

/** The most recently committed branch and its commit time; null when the
 *  repository has no commit. Read-only, no lock. */
export async function newestBranchTip(id: string): Promise<{ branch: string; at: string } | null> {
  const raw = await git(repoDir(id)).raw(['for-each-ref', '--sort=-committerdate', '--count=1', '--format=%(committerdate:iso-strict)%09%(refname:short)', 'refs/heads']);
  const [date, branch] = raw.trim().split('\t');
  const t = Date.parse(date);
  return branch && !Number.isNaN(t) ? { branch, at: new Date(t).toISOString() } : null;
}

/** Per-repository write serialisation: every operation that changes an index,
 *  a ref or a worktree of project `id` runs inside this lock, in arrival
 *  order. NOT reentrant — an operation that already holds it calls the `…Held`
 *  variants below. A rejection reaches only that caller and never breaks the
 *  chain for the next one. Per process: two app nodes writing one repo are
 *  outside the supported topology (docs/SCALING.md). Keyed by project, not
 *  branch: worktrees share one `.git`, and `merge` spans two branches. */
const repoLocks = new Map<string, Promise<void>>();
export function withRepoLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(id) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => undefined, () => undefined);
  repoLocks.set(id, tail);
  void tail.then(() => { if (repoLocks.get(id) === tail) repoLocks.delete(id); });
  return run;
}

/** Create branch from a base and materialize its worktree. */
export async function createBranch(id: string, name: string, from = 'main'): Promise<void> {
  if (!BRANCH_RE.test(name) || name.includes('..')) throw new Error('bad branch name');
  if (!BRANCH_RE.test(from) || from.includes('..')) throw new Error('bad base branch name');
  if (name === 'main') throw new Error('main already exists');
  return withRepoLock(id, async () => {
    const g = git(repoDir(id));
    const dir = branchDir(id, name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await g.raw(['worktree', 'add', '-b', name, dir, from]);
  });
}

/**
 * Checkpoints on `name` that main does not have, newest first message
 * included: what a delete would throw away. Deleting is `branch -D`, and
 * nothing in the app can bring a commit back after it.
 */
export async function unmergedCommits(id: string, name: string): Promise<{ count: number; newest: string | null }> {
  if (!BRANCH_RE.test(name) || name.includes('..')) throw new Error('bad branch name');
  const g = git(repoDir(id));
  const count = Number((await g.raw(['rev-list', '--count', `main..${name}`])).trim()) || 0;
  if (!count) return { count: 0, newest: null };
  const newest = (await g.raw(['log', '-1', '--format=%s', name])).trim() || null;
  return { count, newest };
}

export async function deleteBranch(id: string, name: string): Promise<void> {
  if (name === 'main') throw new Error('cannot delete main');
  return withRepoLock(id, async () => {
    const g = git(repoDir(id));
    const dir = branchDir(id, name);
    try { await g.raw(['worktree', 'remove', '--force', dir]); } catch { /* worktree may be gone */ }
    // `worktree remove` gives up on a directory that gains a file while it is
    // emptied (a thumbnail landing in .aldine-out) and keeps the worktree
    // registered, which makes `branch -D` refuse a checked-out branch.
    await removeTree(dir);
    await g.raw(['worktree', 'prune']);
    await g.raw(['branch', '-D', name]);
    // A deleted branch must not keep a stale attribution: nothing can commit
    // under it, and a later branch of the same name would inherit it.
    pendingAttributed.delete(attributionKey(id, name));
  });
}

/** Ensure a worktree exists for an already-existing branch (e.g. after container restart). */
export async function ensureWorktree(id: string, name: string): Promise<string> {
  const dir = branchDir(id, name);
  if (name === 'main' || fs.existsSync(dir)) return dir;
  const g = git(repoDir(id));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await g.raw(['worktree', 'add', dir, name]);
  return dir;
}

/**
 * Compile output must never enter git history (or get pushed to GitHub). New
 * projects get `.aldine-out/` in their generated .gitignore; this covers
 * pre-existing and GitHub-cloned repos via the shared .git/info/exclude
 * (worktrees read the common dir's exclude file, so one write covers all branches).
 */
function ensureOutputExcluded(id: string): void {
  try {
    const info = path.join(repoDir(id), '.git', 'info');
    const file = path.join(info, 'exclude');
    let cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // '.papyr-out/' is the pre-rename output dir — keep excluding it so
    // projects created before the Aldine rename never re-track old output.
    const missing = ['.aldine-out/', '.papyr-out/'].filter((d) => !cur.split('\n').includes(d));
    if (missing.length) {
      fs.mkdirSync(info, { recursive: true });
      cur += (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n';
      fs.writeFileSync(file, cur);
    }
  } catch { /* best-effort; commit path must not fail on this */ }
}

/** Attributed (agent) work awaiting the debounced auto-commit of a branch:
 *  the touched paths, each under the intent it was scheduled with. Lives
 *  next to the commit primitives because a whole-tree commit must consume it
 *  — after commitAll the tree is clean, so a surviving entry would attribute
 *  whatever a human types into those files NEXT to the agent
 *  (HistoryPanel/session review key on the author string, and "Revert these
 *  changes" would undo the human's work). Intents are per path, not per
 *  window: one message for the window would title an earlier edit_file's
 *  checkpoint with a later write's intent, and a reviewer reading History
 *  could not trust the titles. */
export interface PendingAttributedCommit { projectId: string; branch: string; author: string; paths: Map<string, string> }
const pendingAttributed = new Map<string, PendingAttributedCommit>();
const attributionKey = (id: string, branch: string) => `${id}::${branch}`;

export function registerAttributedPaths(id: string, branch: string, message: string, author: string, paths: string[]): void {
  const key = attributionKey(id, branch);
  const cur = pendingAttributed.get(key) || { projectId: id, branch, author, paths: new Map<string, string>() };
  cur.author = author;
  for (const p of paths) cur.paths.set(p, message); // a re-edit of a pending path carries the newer intent
  pendingAttributed.set(key, cur);
}

/** Branches with agent work registered but not yet committed. The shutdown
 *  flush must cover these as well as the open docs: an agent writing with no
 *  browser tab open has no doc, and the ledger dies with the process — the
 *  next autosave after a restart would sweep its delta anonymously. */
export function pendingAttributionKeys(): Array<{ projectId: string; branch: string }> {
  return [...pendingAttributed.values()].map((e) => ({ projectId: e.projectId, branch: e.branch }));
}

/** Remove and return the pending attribution for a branch (the debounce fire).
 *  Call only while holding the repo lock: taken outside it, an agent write
 *  that registers between the take and the commit is swept anonymously. */
export function takeAttributedPaths(id: string, branch: string): PendingAttributedCommit | undefined {
  const key = attributionKey(id, branch);
  const cur = pendingAttributed.get(key);
  pendingAttributed.delete(key);
  return cur;
}

/** Paths grouped by intent, in first-scheduled order — one commit per group. */
function byIntent(paths: Map<string, string>): Array<{ message: string; paths: string[] }> {
  const groups = new Map<string, string[]>();
  for (const [p, message] of paths) {
    const g = groups.get(message);
    if (g) g.push(p); else groups.set(message, [p]);
  }
  return [...groups].map(([message, ps]) => ({ message, paths: ps }));
}

/**
 * `git commit` as one argv with `--` before the pathspec and the author
 * before it: simple-git's commit(message, files, opts) appends options after
 * the files, so a path named `--amend` or `-a` would be read as an option
 * (rewriting the previous commit, or folding every tracked edit in). The
 * boundaries refuse such names too; this holds even if one of them does not.
 * `--` ends option parsing only: the path is still a pathspec, and `*`, `?`,
 * `[` and a leading `:` are legal in a file name — `*.tex` would stage every
 * dirty .tex file into the attributed commit, an all-negative `:!x` the whole
 * tree, `:(icase)MAIN.TEX` main.tex instead of itself. --literal-pathspecs
 * (here and on the add in commitPathsHeld) keeps the name a name; directory
 * prefixes still match. Argv, not GIT_LITERAL_PATHSPECS in the child env:
 * simple-git refuses a supplied env that carries the operator's GIT_EDITOR.
 */
const authorEmail = (author: string) => `${author.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@aldine.local`;

async function commitArgv(g: ReturnType<typeof git>, message: string, author: string | undefined, paths?: string[]): Promise<string> {
  const args = ['--literal-pathspecs', 'commit', '-m', message];
  if (author) args.push(`--author=${author} <${authorEmail(author)}>`);
  if (paths?.length) args.push('--', ...paths);
  await g.raw(args);
  return (await g.revparse(['HEAD'])).trim();
}

/** Takes the repo lock; callers already inside withRepoLock use the Held variant. */
export function commitAll(id: string, branch: string, message: string, author?: string): Promise<{ committed: boolean; hash?: string }> {
  return withRepoLock(id, () => commitAllHeld(id, branch, message, author));
}

export async function commitAllHeld(id: string, branch: string, message: string, author?: string): Promise<{ committed: boolean; hash?: string }> {
  const dir = await ensureWorktree(id, branch);
  const g = git(dir);
  ensureOutputExcluded(id);
  // Self-heal projects that committed compile output before it was excluded
  // (.papyr-out is the pre-rename output dir).
  await g.raw(['rm', '-r', '--cached', '--ignore-unmatch', '--quiet', '--', '.aldine-out', '.papyr-out']).catch(() => {});
  await g.add(['-A']);
  const status = await g.status();
  // Consumed only once the tree is known clean (or committed below): a failed
  // add/status must leave the attribution for the debounce to retry.
  if (status.staged.length === 0 && status.files.length === 0) {
    pendingAttributed.delete(attributionKey(id, branch));
    return { committed: false };
  }
  const hash = await commitArgv(g, message, author);
  pendingAttributed.delete(attributionKey(id, branch));
  return { committed: true, hash };
}

/**
 * Commit ONLY the given paths (already-written files or their deletions).
 * Used by the debounced auto-commit to keep agent-attributed work out of the
 * anonymous autosave sweep and vice versa — a whole-tree commit here would
 * attribute a human collaborator's concurrent edits to the agent.
 * Paths that are neither changed nor untracked are dropped before the add:
 * a single `git add` with one unmatched pathspec (an agent-created file a
 * human deleted before the debounce fired) stages NOTHING, which would push
 * every other agent path in the window into the anonymous sweep.
 */
export async function commitPathsHeld(id: string, branch: string, paths: string[], message: string, author?: string): Promise<{ committed: boolean; hash?: string; files: string[] }> {
  if (!paths.length) return { committed: false, files: [] };
  const dir = await ensureWorktree(id, branch);
  const g = git(dir);
  ensureOutputExcluded(id);
  const changed = new Set((await g.status()).files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])));
  const present = paths.filter((p) => changed.has(p));
  if (!present.length) return { committed: false, files: [] };
  await g.raw(['--literal-pathspecs', 'add', '--', ...present]);
  const status = await g.status();
  const staged = new Set(status.staged);
  if (!present.some((p) => staged.has(p))) return { committed: false, files: [] };
  // Committing the explicit pathspec (not the whole index) keeps anything else
  // that happens to be staged out of the attributed commit.
  const hash = await commitArgv(g, message, author, present);
  // `present`, not `paths`: a requested path git saw no change in was never
  // staged, so a caller reporting what landed must not name it.
  return { committed: true, hash, files: present };
}

/** Takes the repo lock; callers already inside withRepoLock use the Held variant. */
export function commitPaths(id: string, branch: string, paths: string[], message: string, author?: string): Promise<{ committed: boolean; hash?: string; files: string[] }> {
  return withRepoLock(id, () => commitPathsHeld(id, branch, paths, message, author));
}

/** Commit the removal of `rel` — a file, or a folder with everything git
 *  tracked inside it — and nothing else that is dirty on the branch. */
export async function commitRemovalHeld(id: string, branch: string, rel: string, message: string, author?: string): Promise<{ committed: boolean; hash?: string; files: string[] }> {
  const dir = await ensureWorktree(id, branch);
  const gone = (await git(dir).status()).deleted.filter((p) => p === rel || p.startsWith(`${rel}/`));
  return commitPathsHeld(id, branch, gone, message, author);
}

/** One git invocation with stdin and extra env — the plumbing below needs
 *  both, which simple-git's raw() does not offer. */
function gitPlumb(dir: string, args: string[], opts: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: dir, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
    // git may exit before it has read its input (most of the plumbing here
    // reads none). The write then fails with EPIPE on the pipe itself, and an
    // 'error' event with no listener takes the whole process down. The exit
    // status above already reports whether the command worked.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });
}

/** `content` as a Buffer keeps bytes that are not UTF-8 (a Latin-1 .tex, an image) exact. */
export interface FileSnapshot { path: string; content: string | Buffer }

/**
 * Commit exactly `content` for each path — the bytes the caller holds, not
 * whatever the working tree holds by the time git reads it. Built with
 * plumbing (hash-object, a private index, write-tree, commit-tree) so a
 * store of a collaborator's keystrokes, a REST write or a flush landing
 * during the commit can never enter it: `git commit -- path` always reads
 * the working tree, and that window is where a person's typing used to end
 * up under Claude's name. Paths whose blob equals HEAD's are dropped; with
 * none left nothing is committed. The working tree is not touched — later
 * typing simply shows as the uncommitted change it is — and the real index
 * is pointed at the committed blobs so status does not read them as staged
 * reversals. An unborn branch (no HEAD) falls back to a working-tree commit.
 */
export async function commitSnapshotHeld(id: string, branch: string, files: FileSnapshot[], message: string, author?: string): Promise<{ committed: boolean; hash?: string; files: string[] }> {
  if (!files.length) return { committed: false, files: [] };
  const dir = await ensureWorktree(id, branch);
  const head = await gitPlumb(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((h) => h.trim(), () => '');
  if (!head) {
    for (const f of files) { const abs = path.join(dir, f.path); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, f.content); }
    return commitPathsHeld(id, branch, files.map((f) => f.path), message, author);
  }
  // Mode and blob per path as HEAD has them: the mode is kept (a 100755 must
  // not silently become 100644), the blob decides whether anything changed.
  const inHead = new Map<string, { mode: string; blob: string }>();
  const listed = await gitPlumb(dir, ['--literal-pathspecs', 'ls-tree', '-z', head, '--', ...files.map((f) => f.path)]);
  for (const rec of listed.split('\0')) {
    const m = /^(\d{6}) blob ([0-9a-f]{40})\t(.*)$/s.exec(rec);
    if (m) inHead.set(m[3], { mode: m[1], blob: m[2] });
  }
  const staged: Array<{ path: string; mode: string; blob: string }> = [];
  for (const f of files) {
    const blob = (await gitPlumb(dir, ['hash-object', '-w', '--stdin', '--path', f.path], { input: f.content })).trim();
    const prev = inHead.get(f.path);
    if (prev?.blob === blob) continue;
    staged.push({ path: f.path, mode: prev?.mode ?? '100644', blob });
  }
  if (!staged.length) return { committed: false, files: [] };
  const index = path.join(os.tmpdir(), `aldine-index-${crypto.randomBytes(8).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await gitPlumb(dir, ['read-tree', head], { env });
    for (const s of staged) await gitPlumb(dir, ['update-index', '--add', '--cacheinfo', `${s.mode},${s.blob},${s.path}`], { env });
    const tree = (await gitPlumb(dir, ['write-tree'], { env })).trim();
    const ident: Record<string, string> = author ? { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: authorEmail(author) } : {};
    const hash = (await gitPlumb(dir, ['commit-tree', tree, '-p', head, '-m', message], { env: ident })).trim();
    // The worktree's HEAD is the branch ref; the old value guards against a
    // ref that moved underneath (impossible under the repo lock, fatal if not).
    await gitPlumb(dir, ['update-ref', 'HEAD', hash, head]);
    for (const s of staged) await gitPlumb(dir, ['update-index', '--add', '--cacheinfo', `${s.mode},${s.blob},${s.path}`]);
    return { committed: true, hash, files: staged.map((s) => s.path) };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/**
 * The commit pair a server-side write makes, from the snapshots the caller
 * held while it applied the edit: first whatever a person had in those files
 * that HEAD does not (typing that landed after the working-tree checkpoint,
 * an out-of-band write), as an anonymous autosave; then the result under
 * `author` and `message`. By construction the named commit's diff is the
 * write's delta and nothing else, whatever lands on disk meanwhile. `before`
 * null = the file did not exist. Callers hold the repo lock.
 */
export async function commitWriteHeld(id: string, branch: string, files: Array<{ path: string; before: string | Buffer | null; after: string }>, message: string, author?: string): Promise<{ committed: boolean; hash?: string; files: string[] }> {
  const typed = files.filter((f) => f.before !== null).map((f) => ({ path: f.path, content: f.before as string | Buffer }));
  if (typed.length) await commitSnapshotHeld(id, branch, typed, 'aldine: autosave');
  return commitSnapshotHeld(id, branch, files.map((f) => ({ path: f.path, content: f.after })), message, author);
}

/** commitWriteHeld under Claude: the commit pair every agent write makes. */
export function commitAgentWriteHeld(id: string, branch: string, files: Array<{ path: string; before: string | Buffer | null; after: string }>, message: string): Promise<{ committed: boolean; hash?: string; files: string[] }> {
  return commitWriteHeld(id, branch, files, message, AGENT_COMMIT_AUTHOR);
}

/**
 * Commit the current on-disk state of `paths` BEFORE an agent overwrites
 * them, so the attributed commit that follows carries exactly the agent's
 * delta. Without this the human's uncommitted edits to the same file — up to
 * a whole session's worth, since continuous typing keeps resetting the
 * autosave debounce — would land under author Claude. A path already pending
 * under an agent attribution checkpoints under THAT attribution (an
 * anonymous checkpoint would bury the agent's earlier edit in an autosave);
 * the rest checkpoint as an anonymous autosave. Callers flush open docs
 * first so unflushed keystrokes are part of the checkpoint.
 */
export async function checkpointPathsHeld(id: string, branch: string, paths: string[]): Promise<void> {
  const key = attributionKey(id, branch);
  const pending = pendingAttributed.get(key);
  const attributed = pending ? paths.filter((p) => pending.paths.has(p)) : [];
  const anonymous = pending ? paths.filter((p) => !pending.paths.has(p)) : paths;
  if (pending && attributed.length) {
    // Under the intent each path was scheduled with, never the incoming write's.
    for (const g of byIntent(new Map(attributed.map((p) => [p, pending.paths.get(p)!])))) {
      await commitPathsHeld(id, branch, g.paths, g.message, pending.author);
    }
    for (const p of attributed) pending.paths.delete(p);
    if (!pending.paths.size) pendingAttributed.delete(key);
  }
  if (anonymous.length) await commitPathsHeld(id, branch, anonymous, 'aldine: autosave');
}

/** Takes the repo lock; callers already inside withRepoLock use the Held variant. */
export function checkpointPaths(id: string, branch: string, paths: string[]): Promise<void> {
  return withRepoLock(id, () => checkpointPathsHeld(id, branch, paths));
}

/** Title an attributed group retries under after its commit failed: the
 *  original subject is the one input the ledger cannot vouch for, and a
 *  subject that fails git twice would block the branch's sweep for good. */
const RETRY_INTENT = 'aldine: agent edit';

/** The debounced auto-commit, and the shape of every whole-tree commit a
 *  person triggers (checkpoint, revert, merge, GitHub sync): attributed
 *  (agent) paths first under their author + intent, then a sweep of whatever
 *  remains under `sweepMessage`/`sweepAuthor`. The attribution is taken only
 *  once the lock is held: a fire queued behind an agent write sees the
 *  attribution that write registered, a fire that ran before it sees the
 *  tree the checkpoint then finds clean — neither can stage the agent's
 *  delta as an autosave. When an attributed commit fails the remaining groups
 *  are put back (the failed one under RETRY_INTENT) and the sweep is skipped
 *  (sweeping would sign the agent's delta anonymously, or under the person);
 *  the next edit re-arms the debounce. */
export async function autoCommitHeld(id: string, branch: string, sweepMessage = 'aldine: autosave', sweepAuthor?: string, sweep = true): Promise<{ committed: boolean; hash?: string }> {
  const attributed = takeAttributedPaths(id, branch);
  let last: { committed: boolean; hash?: string } = { committed: false };
  if (attributed) {
    // One commit per intent, so History titles name what each commit holds.
    const groups = byIntent(attributed.paths);
    for (let i = 0; i < groups.length; i++) {
      try {
        const r = await commitPathsHeld(id, branch, groups[i].paths, groups[i].message, attributed.author);
        if (r.committed) last = { committed: true, hash: r.hash };
      } catch (err) {
        registerAttributedPaths(id, branch, RETRY_INTENT, attributed.author, groups[i].paths);
        for (const g of groups.slice(i + 1)) registerAttributedPaths(id, branch, g.message, attributed.author, g.paths);
        throw err;
      }
    }
  }
  if (!sweep) return last;
  return commitAllHeld(id, branch, sweepMessage, sweepAuthor);
}

/** The commit nobody asked for: the edit debounce and the shutdown flush. On
 *  a project whose people commit by hand (`manualCommits`) only the agent's
 *  attributed work lands; everything else stays in the working tree for the
 *  person's own commit and message. Unreadable meta falls back to the sweep,
 *  so a broken meta file can never leave edits out of history. */
export async function autosave(id: string, branch: string, message = 'aldine: autosave'): Promise<{ committed: boolean; hash?: string }> {
  const manual = await readMeta(id).then((m) => m.manualCommits === true, () => false);
  return withRepoLock(id, () => autoCommitHeld(id, branch, message, undefined, !manual));
}

/** Paths that differ from the branch's last commit (untracked ones included),
 *  build output excluded. Read-only: no lock, no index write. */
export async function uncommittedPaths(id: string, branch: string): Promise<string[]> {
  const dir = await ensureWorktree(id, branch);
  ensureOutputExcluded(id);
  const status = await git(dir).status(['--untracked-files=all']);
  return status.files.map((f) => f.path).filter((p) => !/^\.(aldine|papyr)-out\//.test(p));
}

/** Takes the repo lock; callers already inside withRepoLock use the Held variant. */
export function autoCommit(id: string, branch: string, sweepMessage = 'aldine: autosave', sweepAuthor?: string): Promise<{ committed: boolean; hash?: string }> {
  return withRepoLock(id, () => autoCommitHeld(id, branch, sweepMessage, sweepAuthor));
}

/**
 * A person's named checkpoint (History's Save): autoCommit, then, when the
 * branch still differs from its diff baseline, an empty commit under the
 * message. The autosaves may already hold every edit, leaving the sweep
 * nothing; without the empty commit the checkpoint would never be made and
 * the editor's change marks would never clear. Not with manual commits,
 * where the head is the baseline.
 */
export function checkpoint(id: string, branch: string, message: string, author?: string): Promise<{ committed: boolean; hash?: string }> {
  return withRepoLock(id, async () => {
    const r = await autoCommitHeld(id, branch, message, author);
    // A commit under this title would not be a baseline either (a client
    // that asks for an autosave, or Claude's name): nothing to add.
    if (!mayBeBaseline(author, message)) return r;
    const manual = await readMeta(id).then((m) => m.manualCommits === true, () => false);
    const base = await diffBaselineCommit(id, branch, manual);
    const head = await branchHead(id, branch);
    if (!base || base === head) return r;
    const g = git(await ensureWorktree(id, branch));
    const tree = (rev: string) => g.revparse([`${rev}^{tree}`]).then((t) => t.trim());
    if ((await tree(base)) === (await tree(head))) return r;
    const args = ['commit', '--allow-empty', '-m', message];
    if (author) args.push(`--author=${author} <${authorEmail(author)}>`);
    await g.raw(args);
    return { committed: true, hash: (await g.revparse(['HEAD'])).trim() };
  });
}

/**
 * Commit ONLY the agent work the ledger holds for this branch, as one commit
 * under `message`: the named checkpoint the MCP `commit` tool makes. The
 * caller is stating the intent of the checkpoint, so the per-path intents the
 * individual writes registered are replaced, not grouped — byIntent here would
 * title the checkpoint with an earlier write's message. Whatever else is dirty
 * stays for the anonymous sweep: a whole-tree commit would sign a
 * collaborator's flushed typing as the agent (HistoryPanel and the session
 * review key on the author string). No pending work is `committed:false`, not
 * a failure — the debounce may already have committed it.
 * Held-only on purpose: the caller must hold the lock across its own flush, so
 * a lock-taking wrapper would be dead code and an invitation to nest
 * withRepoLock inside that span (the lock is a promise chain: a nested take
 * never resolves).
 */
export async function commitAttributedHeld(id: string, branch: string, message: string): Promise<{ committed: boolean; hash?: string; files: string[] }> {
  const pending = takeAttributedPaths(id, branch);
  if (!pending) return { committed: false, files: [] };
  const paths = [...pending.paths.keys()];
  try {
    // The author comes from the ledger, never from the caller: no call site
    // can sign a commit as somebody else.
    return await commitPathsHeld(id, branch, paths, message, pending.author);
  } catch (err) {
    // Same rule as autoCommitHeld: the subject is the one input the ledger
    // cannot vouch for, and dropping the attribution would let the next sweep
    // sign the agent's delta anonymously.
    registerAttributedPaths(id, branch, RETRY_INTENT, pending.author, paths);
    throw err;
  }
}

/** Short HEAD of a branch — the `{branch, head}` echo every MCP tool result
 *  carries so the agent can narrate what it touched. '' when the ref cannot
 *  be resolved (echo is informational; it must never fail the tool call). */
export async function branchShortHead(id: string, branch: string): Promise<string> {
  try { return (await git(repoDir(id)).revparse(['--short', branch])).trim(); } catch { return ''; }
}

export interface LogEntry {
  hash: string;
  date: string;
  message: string;
  author: string;
  /** With `details`: how many parents (0 for the first commit, 2 for a merge). */
  parents?: number;
  /** With `details`: the paths the commit changed (a merge's against its first
   *  parent), at most LOG_FILES_MAX of them; `fileCount` is the full count. */
  files?: string[];
  fileCount?: number;
  /** For an agent commit, whose token it was made with. */
  onBehalfOf?: string;
}

const LOG_FILES_MAX = 20;

/** Fields are split on NUL, the one byte no git field can hold: a commit
 *  subject may carry any other byte, including the control characters a
 *  parser might pick as markers, and simple-git's default parser splits on a
 *  printable one, letting a message move itself into the author field — the
 *  field the History panel and the session review key on. %an, not %aN: a
 *  .mailmap committed into the project would otherwise rename authors.
 *  `skip` pages back from the newest commit; `details` adds the parent count
 *  and the changed paths. */
export async function log(id: string, branch: string, limit = 50, { skip = 0, details = false }: { skip?: number; details?: boolean } = {}): Promise<LogEntry[]> {
  if (!BRANCH_RE.test(branch) || branch.includes('..')) throw new Error('bad branch name');
  const paging = [`--max-count=${limit}`, ...(skip > 0 ? [`--skip=${skip}`] : [])];
  const out: LogEntry[] = [];
  if (details) {
    // The record separator LEADS the format, as in agentActivitySince:
    // --name-only prints the paths after the header. quotePath off keeps a
    // non-ASCII name readable instead of octal-escaped.
    const raw = await git(repoDir(id)).raw(['-c', 'core.quotePath=false', 'log', branch, ...paging,
      `--format=%x00%H%x00%aI%x00%an%x00%P%x00${REQUESTER_FORMAT}%x00%s`, '--name-only', '--diff-merges=first-parent', '--']);
    const f = raw.split('\0');
    for (let i = 1; i + 5 < f.length; i += 6) {
      const hash = f[i].trim();
      if (!/^[0-9a-f]{40}$/.test(hash)) continue;
      const lines = f[i + 5].split('\n');
      const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);
      const onBehalfOf = f[i + 2] === AGENT_COMMIT_AUTHOR ? f[i + 4].trim() : '';
      out.push({
        hash, date: f[i + 1], author: f[i + 2], message: lines[0] ?? '',
        parents: f[i + 3].split(' ').filter(Boolean).length,
        files: files.slice(0, LOG_FILES_MAX), fileCount: files.length,
        ...(onBehalfOf ? { onBehalfOf } : {}),
      });
    }
    return out;
  }
  const raw = await git(repoDir(id)).raw(['log', branch, ...paging, `--format=%H%x00%aI%x00%an%x00%s%x00${REQUESTER_FORMAT}%x00`, '--']);
  const f = raw.split('\0');
  for (let i = 0; i + 4 < f.length; i += 5) {
    const hash = f[i].trim(); // the newline git prints after each record leads the next hash
    if (!/^[0-9a-f]{40}$/.test(hash)) continue;
    const onBehalfOf = f[i + 2] === AGENT_COMMIT_AUTHOR ? f[i + 4].trim() : '';
    out.push({ hash, date: f[i + 1], author: f[i + 2], message: f[i + 3], ...(onBehalfOf ? { onBehalfOf } : {}) });
  }
  return out;
}

/** The branch's head, or '' when the project or the branch does not exist.
 *  Read-only, no lock. */
export async function branchHead(id: string, branch: string): Promise<string> {
  if (!BRANCH_RE.test(branch) || branch.includes('..')) return '';
  try {
    return await git(repoDir(id)).revparse(['--verify', '--quiet', `refs/heads/${branch}`]).then((h) => h.trim());
  } catch { return ''; }
}

/** Author string every agent write commits under; the History dot, the
 *  session review and this answer all key on it. */
export const AGENT_COMMIT_AUTHOR = 'Claude';

const AUTOSAVE_SUBJECT = /^aldine: autosave( on shutdown)?$/;
/** search.ts replaceCommitMessage: commits only the files it changed. */
const REPLACE_SUBJECT = /^(Replace|Delete) (".*"|\/.*\/) (with ".*" )?in .+$/;
/** Commits read per `git log` while looking for the baseline. */
const BASELINE_PAGE = 500;
/** Past this many commits the oldest one read is the baseline: a branch of
 *  nothing but autosaves must not walk its whole history on every request. */
const BASELINE_SCAN_MAX = 20_000;

/** Whether a commit by `author` titled `subject` can be the diff baseline,
 *  short of what its files say (isRemovalCommit). */
function mayBeBaseline(author: string | undefined, subject: string): boolean {
  return !AUTOSAVE_SUBJECT.test(subject) && author !== AGENT_COMMIT_AUTHOR && !REPLACE_SUBJECT.test(subject);
}

/** The file route's removal commit (`Delete <path>`, `Delete folder <path>`),
 *  which holds only that removal. */
async function isRemovalCommit(id: string, hash: string, subject: string): Promise<boolean> {
  const raw = await git(repoDir(id)).raw(['-c', 'core.quotePath=false', 'show', '--name-only', '--no-renames', '--format=', hash, '--']).catch(() => '');
  const files = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!files.length) return false;
  if (subject.startsWith('Delete folder ')) {
    const dir = subject.slice('Delete folder '.length);
    return files.every((f) => f.startsWith(`${dir}/`));
  }
  return files.length === 1 && subject === `Delete ${files[0]}`;
}

/**
 * The commit the editor's change marks compare against, the same for every
 * collaborator on the branch. With manual commits it is the branch head.
 * Otherwise the head moves on every autosave, so it is the newest commit on
 * the branch's own line (first parents) that a person made of the whole
 * tree: a checkpoint, merge, revert, sync or the save before one. Skipped:
 * autosaves, Claude's commits, and the commits that hold only some paths (a
 * file's removal, a project-wide replace), whose other files are still at
 * the autosave before them — any of those as the baseline would fold typing
 * nobody checkpointed into it. '' when the branch has no commit.
 */
export async function diffBaselineCommit(id: string, branch: string, manual: boolean): Promise<string> {
  const head = await branchHead(id, branch);
  if (!head || manual) return head;
  const g = git(repoDir(id));
  let oldest = head;
  for (let skip = 0; skip < BASELINE_SCAN_MAX; skip += BASELINE_PAGE) {
    const raw = await g.raw(['log', '--first-parent', `--max-count=${BASELINE_PAGE}`, `--skip=${skip}`, '--format=%H%x00%an%x00%s%x00', head, '--']);
    const f = raw.split('\0');
    let n = 0;
    for (let i = 0; i + 2 < f.length; i += 3) {
      const hash = f[i].trim(); // the newline after each record leads the next hash
      if (!/^[0-9a-f]{40}$/.test(hash)) continue;
      n++;
      oldest = hash;
      const author = f[i + 1], subject = f[i + 2];
      if (!mayBeBaseline(author, subject)) continue;
      if (subject.startsWith('Delete ') && await isRemovalCommit(id, hash, subject)) continue;
      return hash;
    }
    if (n < BASELINE_PAGE) break;
  }
  return oldest;
}

/** Past this size a file's baseline is not sent: the editor compares lines
 *  on every pause in typing. */
export const DIFF_BASELINE_MAX_BYTES = 2 * 1024 * 1024;

/** `rel` as it was at `commit`: null when it was not a file there; `large`
 *  past DIFF_BASELINE_MAX_BYTES, or when it is binary. */
export async function fileAtCommit(id: string, commit: string, rel: string): Promise<{ content: string | null; large?: boolean }> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('bad commit hash');
  const g = git(repoDir(id));
  // ls-tree, not `show <commit>:<path>`: the path stays a literal name, never
  // revision syntax.
  const raw = await g.raw(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', rel]);
  const entry = raw.split('\0').find((e) => e.slice(e.indexOf('\t') + 1) === rel);
  if (!entry) return { content: null };
  const [type, oid] = entry.slice(0, entry.indexOf('\t')).split(' ').slice(1);
  if (type !== 'blob' || !/^[0-9a-f]{40,64}$/.test(oid ?? '')) return { content: null };
  const size = Number((await g.raw(['cat-file', '-s', oid])).trim());
  if (!(size <= DIFF_BASELINE_MAX_BYTES)) return { content: null, large: true };
  const content = await g.raw(['cat-file', 'blob', oid]);
  if (content.includes('\0')) return { content: null, large: true };
  return { content };
}

/** Trailer naming whose access token an agent commit was made with: the
 *  author stays AGENT_COMMIT_AUTHOR, which everything that tells Claude's
 *  commits apart keys on. */
export const AGENT_REQUESTER_TRAILER = 'On-behalf-of';
const REQUESTER_LINE = new RegExp(`^${AGENT_REQUESTER_TRAILER}:.*$`, 'gim');

/** An agent commit message: the intent, then the token owner as a trailer.
 *  A requester line already in the intent is dropped, so a message cannot
 *  name somebody else. */
export function agentCommitMessage(intent: string, requester: string | null | undefined): string {
  const who = (requester ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200);
  const text = intent.replace(REQUESTER_LINE, '').replace(/\n{3,}/g, '\n\n').trim() || 'aldine: agent edit';
  return who ? `${text}\n\n${AGENT_REQUESTER_TRAILER}: ${who}` : text;
}

/** The %(trailers) placeholder that reads the requester back, '' when absent. */
const REQUESTER_FORMAT = `%(trailers:key=${AGENT_REQUESTER_TRAILER},valueonly,separator=%x2C )`;
/** Commits walked per answer. Past this the counts are a floor
 *  (`truncated`), which is the honest reading of "Claude wrote 300 commits". */
const AGENT_SCAN_LIMIT = 500;
/** Commits handed back with a hash — the reviewer pays one diff request each. */
const AGENT_REVIEW_LIMIT = 20;

export interface AgentCommit { hash: string; date: string; message: string; files: string[]; onBehalfOf?: string }
export interface AgentActivity {
  since: { head: string; at: string } | null;
  head: string;
  /** Newest first, at most AGENT_REVIEW_LIMIT. */
  commits: AgentCommit[];
  /** Claude commits newer than the mark, over the whole scan. */
  commitCount: number;
  /** Distinct paths across those commits. */
  fileCount: number;
  /** Those paths, over the whole scan: the files the editor marks as changed by Claude. */
  paths: string[];
  /** The scan hit its ceiling: the counts are a floor, not a total. */
  truncated: boolean;
}

/**
 * What Claude committed on `branch` past the caller's mark. Only ever runs
 * revparse / merge-base / log in the repo dir: no flush, no commit, no
 * `withRepoLock` — git reads take no index lock, so this is safe to answer
 * while an autosave holds the write lock.
 */
export async function agentActivitySince(id: string, branch: string, mark: { head: string; at: string } | null): Promise<AgentActivity> {
  if (!BRANCH_RE.test(branch) || branch.includes('..')) throw new Error('bad branch name');
  const head = await branchHead(id, branch);
  if (!head) return { since: mark, head: '', commits: [], commitCount: 0, fileCount: 0, paths: [], truncated: false };
  const g = git(repoDir(id));

  // A mark whose commit is no longer on the branch (a reset to the remote, a
  // recreated branch) cannot bound a range; the date bound below is one
  // second early on purpose — re-showing a commit is a smaller failure than
  // hiding one.
  // Counted rather than `merge-base --is-ancestor`, whose "no" (exit 1, empty
  // stderr) simple-git resolves like a "yes".
  let usable = false;
  if (mark?.head && /^[0-9a-f]{4,40}$/.test(mark.head)) {
    usable = await g.raw(['rev-list', '--count', mark.head, `^refs/heads/${branch}`, '--']).then((s) => Number(s.trim()) === 0, () => false);
  }
  // NUL-separated like log(), but the record separator LEADS the format here:
  // --name-only prints the file list after the header, so a trailing one
  // would attach each commit's files to the next record. %an, not %aN: a
  // committed .mailmap must not be able to rename the agent.
  const args = ['log', usable ? `${mark!.head}..${branch}` : branch,
                `--max-count=${AGENT_SCAN_LIMIT}`,
                `--format=%x00%H%x00%aI%x00%an%x00${REQUESTER_FORMAT}%x00%s`, '--name-only'];
  if (!usable && mark?.at) {
    const t = Date.parse(mark.at);
    if (!Number.isNaN(t)) args.push(`--since=${new Date(t - 1000).toISOString()}`);
  }
  args.push('--');
  const raw = await g.raw(args).catch(() => '');

  const f = raw.split('\0'); // opens with the text before the first separator: nothing
  const files = new Set<string>();
  const commits: AgentCommit[] = [];
  let records = 0;
  let commitCount = 0;
  for (let i = 1; i + 4 < f.length; i += 5) {
    const hash = f[i].trim();
    if (!/^[0-9a-f]{40}$/.test(hash)) continue;
    records++;
    const [date, author, onBehalfOf, rest] = [f[i + 1], f[i + 2], f[i + 3].trim(), f[i + 4]];
    if (author !== AGENT_COMMIT_AUTHOR) continue;
    const lines = rest.split('\n');
    const message = lines[0] ?? '';
    const touched = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    for (const f of touched) files.add(f);
    if (commits.length < AGENT_REVIEW_LIMIT) commits.push({ hash, date, message, files: touched, ...(onBehalfOf ? { onBehalfOf } : {}) });
    commitCount++;
  }
  return { since: mark, head, commits, commitCount, fileCount: files.size, paths: [...files], truncated: records >= AGENT_SCAN_LIMIT };
}

export interface MergeResult { ok: boolean; conflicts?: string[]; message?: string }
/** `changed`: whether the files of `into` differ from before the merge. */
export interface BranchMergeResult extends MergeResult { changed?: boolean }

/** Merge `from` into `into`. On conflict: abort and report conflicting files,
 *  or with `keepConflicts` commit the merge with both versions of each
 *  conflicted file between git's markers, for the person to settle on `into`
 *  (the caller keeps that off main). `checkpoint` titles the commit of edits
 *  still waiting on either branch.
 *  `from` must be a local branch; git gets it fully qualified, so it can be
 *  neither an option nor any other revision. */
export async function merge(id: string, from: string, into: string, author?: string, { keepConflicts = false, checkpoint = 'aldine: checkpoint before merge' }: { keepConflicts?: boolean; checkpoint?: string } = {}): Promise<BranchMergeResult> {
  if (!BRANCH_RE.test(from) || from.includes('..')) throw new Error('bad branch name');
  const fromRef = `refs/heads/${from}`;
  return withRepoLock(id, async () => {
    const known = await git(repoDir(id)).raw(['rev-parse', '-q', '--verify', fromRef]).then((s) => !!s.trim(), () => false);
    if (!known) return { ok: false, message: `No branch named "${from}"` };
    // commit any pending changes in both branches first so the merge sees latest state
    await autoCommitHeld(id, from, checkpoint, author).catch(() => {});
    await autoCommitHeld(id, into, checkpoint, author).catch(() => {});
    const dir = await ensureWorktree(id, into);
    const g = git(dir);
    // Trees, not heads: the checkpoint commits move heads without changing
    // what `into` holds, and edits checkpointed on an already merged `from`
    // do change it.
    const tree = () => g.raw(['rev-parse', 'HEAD^{tree}']).then((t) => t.trim(), () => '');
    const before = await tree();
    let mergeErr: unknown = null;
    try { await g.raw(['merge', '--no-ff', '-m', `Merge ${from} into ${into}`, fromRef]); } catch (e) { mergeErr = e; }
    const conflicts = (await g.status()).conflicted;
    if (conflicts.length && keepConflicts) {
      try {
        await g.raw(['add', '-A']);
        await commitArgv(g, `Merge ${from} into ${into}`, author);
        return { ok: true, changed: true, conflicts };
      } catch (e) {
        await g.raw(['merge', '--abort']).catch(() => {});
        return { ok: false, conflicts, message: String((e as Error)?.message || e) };
      }
    }
    if (conflicts.length) {
      await g.raw(['merge', '--abort']).catch(() => {});
      return { ok: false, conflicts };
    }
    if (mergeErr) return { ok: false, message: String((mergeErr as Error)?.message || mergeErr) };
    return { ok: true, changed: (await tree()) !== before };
  });
}

/** A revert refused before anything ran: the request named commits that are
 *  not in the branch's history. The message is a sentence for the person. */
export class RevertRefusedError extends Error {}

/**
 * Revert the given commits as ONE new commit — session "undo" is additive
 * history, never a rewrite. Hashes must arrive newest-first so each revert
 * applies against the state it expects. On conflict the revert is aborted and
 * nothing is committed. A merge is undone against its first parent: what it
 * brought into this branch goes, the branch's own line stays.
 */
export async function revertCommits(id: string, branch: string, hashes: string[], message: string, author?: string): Promise<{ ok: boolean; hash?: string }> {
  if (!hashes.length || hashes.some((h) => !/^[0-9a-f]{4,40}$/.test(h))) throw new Error('bad commit hash');
  return withRepoLock(id, async () => {
    const dir = await ensureWorktree(id, branch);
    const g = git(dir);
    // Only the branch's own history: reverting another branch's commit here
    // applies the inverse of changes this branch never had. Counted rather
    // than `merge-base --is-ancestor`, whose "no" (exit 1, empty stderr)
    // simple-git resolves like a "yes".
    const foreign: string[] = [];
    for (const h of hashes) {
      const outside = await g.raw(['rev-list', '--count', h, '^HEAD', '--']).then((s) => Number(s.trim()) !== 0, () => true);
      if (outside) foreign.push(h);
    }
    if (foreign.length) {
      const title = await g.raw(['show', '-s', '--format=%s', foreign[0]]).then((s) => s.trim(), () => '');
      const named = `${title ? `"${title}" ` : ''}(${foreign[0].slice(0, 7)})`;
      throw new RevertRefusedError(foreign.length === 1
        ? `Could not revert ${named} — it is not on ${branch}. Open the branch it was made on and revert it there`
        : `Could not revert ${named} and ${foreign.length - 1} more — they are not on ${branch}. Open the branch they were made on and revert them there`);
    }
    // -m 1 applies to every hash given; git takes it for a non-merge as well.
    const merges = await g.raw(['rev-list', '--no-walk', '--merges', ...hashes, '--']).then((s) => s.trim() !== '', () => false);
    try {
      await g.raw(['revert', '--no-commit', ...(merges ? ['-m', '1'] : []), ...hashes]);
    } catch {
      // REVERT_HEAD is the commit the sequencer stopped on: the one a later
      // edit overlaps. Read it before the abort clears it.
      const at = await g.raw(['rev-parse', '-q', '--verify', 'REVERT_HEAD']).then((s) => s.trim(), () => '');
      const title = at ? await g.raw(['show', '-s', '--format=%s', at]).then((s) => s.trim(), () => '') : '';
      await g.raw(['revert', '--abort']).catch(() => {});
      throw new Error(at
        ? `Could not revert "${title}" (${at.slice(0, 7)}) — later edits overlap it. Undo them by hand (History shows both diffs), then revert again`
        : 'Could not revert cleanly — later edits overlap these changes. Undo them by hand (History shows both diffs), then revert again');
    }
    const status = await g.status();
    if (status.staged.length === 0 && status.files.length === 0) return { ok: false };
    return { ok: true, hash: await commitArgv(g, message, author) };
  });
}

/** Author name of each commit, in the order given (a hash that does not
 *  resolve is skipped). Used to tell a revert of Claude's work from one of a
 *  human's, which the revert route reports as a success metric. */
export async function commitAuthors(id: string, hashes: string[]): Promise<string[]> {
  if (!hashes.length || hashes.some((h) => !/^[0-9a-f]{4,40}$/.test(h))) throw new Error('bad commit hash');
  const raw = await git(repoDir(id)).raw(['show', '-s', '--format=%an', ...hashes]).catch(() => '');
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Unified patch for a single commit (handles root commits, which have no parent).
 *  A merge shows what it brought into its branch, against the first parent:
 *  git's default combined diff is empty for a merge without conflicts. */
export async function commitDiff(id: string, hash: string): Promise<{ patch: string; stat: string }> {
  if (!/^[0-9a-f]{4,40}$/.test(hash)) throw new Error('bad commit hash');
  const g = git(repoDir(id));
  const patch = await g.raw(['show', '-m', '--first-parent', hash, '--no-color', '--pretty=format:', '--']);
  const stat = await g.raw(['show', '-m', '--first-parent', hash, '--no-color', '--stat', '--pretty=format:', '--']);
  return { patch: patch.replace(/^\n+/, ''), stat: stat.replace(/^\n+/, '') };
}

// ---------- remote sync (GitHub, GitLab) ----------
// SECURITY: the projects dir is shared with the compiler, so the auth token must
// never land in .git/config. We pass a tokenized URL inline per network op and
// keep only a credential-free URL as `origin`.

/** Strip any `user:token@` credentials from an http(s) URL (or from every URL in a message). */
export function stripCreds(url: string): string {
  return url.replace(/(https?:\/\/)[^@/\s]+@/gi, '$1');
}

/**
 * git echoes the URL it was given, token included, in transport and auth
 * failures. Every network op below rethrows through this so no caller can
 * forward a credential in an error message, a toast or a log line.
 */
async function scrubbed<T>(op: () => Promise<T>): Promise<T> {
  try { return await op(); }
  catch (err: any) {
    if (err && typeof err.message === 'string') {
      const clean = stripCreds(err.message);
      if (clean !== err.message) {
        const e = new Error(clean); e.name = err.name; throw e;
      }
    }
    throw err;
  }
}

/**
 * Put `user:token@` into an http(s) clone URL for one git network op. The
 * user name is what the host expects (`x-access-token` on GitHub, `oauth2` on
 * GitLab). Non-http URLs pass through unchanged: the tests clone `file://`.
 * The result is used inline and never written to .git/config.
 */
export function injectToken(cloneUrl: string, user: string, token: string): string {
  if (!/^https?:\/\//i.test(cloneUrl)) return cloneUrl;
  return stripCreds(cloneUrl).replace(/^(https?:\/\/)/i, `$1${encodeURIComponent(user)}:${encodeURIComponent(token)}@`);
}

/**
 * Clone a remote into a (new) project's repo dir. Aldine is main-centric, so the
 * checked-out default branch is renamed to `main` locally; the original name is
 * returned as `remoteBranch` for push/pull mapping. The token is scrubbed from origin.
 */
export async function cloneRepo(id: string, tokenUrl: string): Promise<{ remoteBranch: string }> {
  const dir = repoDir(id);
  if (fs.existsSync(dir)) throw new Error('project already exists');
  fs.mkdirSync(projectsDir, { recursive: true });
  await scrubbed(() => git(projectsDir).clone(tokenUrl, dir, ['--no-single-branch']));
  const g = git(dir);
  await g.remote(['set-url', 'origin', stripCreds(tokenUrl)]); // never persist the token
  await g.addConfig('user.name', 'Aldine');
  await g.addConfig('user.email', 'aldine@localhost');
  const remoteBranch = (await g.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main';
  if (remoteBranch !== 'main') await g.raw(['branch', '-m', 'main']);
  ensureOutputExcluded(id); // cloned repos have no Aldine .gitignore; keep compile output out of their history
  return { remoteBranch };
}

/** Push local `main` to the remote branch. Assumes commits already made.
 *  A refused push forgets the cached fetch too: the refusal is usually the
 *  host having moved on, which the next status poll must see. */
export async function pushToRemote(id: string, remoteBranch: string, tokenUrl: string): Promise<void> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
  try { await scrubbed(() => git(repoDir(id)).raw(['push', tokenUrl, `refs/heads/main:refs/heads/${remoteBranch}`])); }
  finally { forgetRemoteStatus(id); }
}

/** Current HEAD commit hash of the project's main branch (cheap, local). */
export async function headCommit(id: string): Promise<string> {
  return (await git(repoDir(id)).revparse(['HEAD'])).trim();
}

// remoteStatus fetches into a ref of its own, never FETCH_HEAD, so a status
// poll needs no repo lock and cannot change what a concurrent pull or reset
// merges. Editors poll it, so one fetch per project, branch and credential
// serves everyone for REMOTE_STATUS_TTL_MS; the counts are recomputed locally
// on every call, so a local commit shows at once.
const STATUS_REF = 'refs/aldine/remote-status';
const REMOTE_STATUS_TTL_MS = Number(process.env.REMOTE_STATUS_TTL_MS ?? 30_000);
const statusFetches = new Map<string, { at: number; done: Promise<void> }>();

/** Drop cached fetches for a project: its remote moved under us (push, pull, reset). */
export function forgetRemoteStatus(id: string): void {
  for (const k of statusFetches.keys()) if (k.startsWith(`${id}\0`)) statusFetches.delete(k);
}

/** How many commits local `main` is ahead/behind the remote branch (fetches at most once per TTL). */
export async function remoteStatus(id: string, remoteBranch: string, tokenUrl: string): Promise<{ ahead: number; behind: number }> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
  const g = git(repoDir(id));
  const key = `${id}\0${remoteBranch}\0${tokenUrl}`;
  let f = statusFetches.get(key);
  if (!f || Date.now() - f.at > REMOTE_STATUS_TTL_MS) {
    f = { at: Date.now(), done: scrubbed(() => g.raw(['fetch', '--no-write-fetch-head', tokenUrl, `+refs/heads/${remoteBranch}:${STATUS_REF}`])).then(() => {}) };
    statusFetches.set(key, f);
    f.done.catch(() => { if (statusFetches.get(key) === f) statusFetches.delete(key); });
  }
  await f.done;
  const ahead = Number((await g.raw(['rev-list', '--count', `${STATUS_REF}..refs/heads/main`])).trim()) || 0;
  const behind = Number((await g.raw(['rev-list', '--count', `refs/heads/main..${STATUS_REF}`])).trim()) || 0;
  return { ahead, behind };
}

/** Discard all local changes and hard-reset local `main` to the remote branch. */
/** Resolves to whether the files of `main` changed: a new head, or tracked
 *  edits the hard reset threw away (untracked files survive it). */
export async function resetToRemote(id: string, remoteBranch: string, tokenUrl: string): Promise<boolean> {
  return (await resetMain(id, remoteBranch, tokenUrl, null)).changed;
}

/**
 * resetToRemote that first saves `main` as a local branch named `keepAs`
 * (`keepAs-2`, `keepAs-3`… when taken), when main holds commits the remote
 * branch lacks. The branch is never pushed: it stays on this server, where
 * the branch menu lists it. `kept` is null when there was nothing to keep.
 * Uncommitted edits are not kept: commit them first.
 */
export async function keepThenResetToRemote(id: string, remoteBranch: string, tokenUrl: string, keepAs: string): Promise<{ changed: boolean; kept: string | null }> {
  if (!BRANCH_RE.test(keepAs) || keepAs.includes('..') || keepAs === 'main') throw new Error('bad branch name');
  return resetMain(id, remoteBranch, tokenUrl, keepAs);
}

/** `base`, else `base-2`, `base-3`…: the first name neither a branch nor a
 *  leftover worktree directory uses. Read-only. */
export async function freeBranchName(id: string, base: string): Promise<string> {
  const taken = new Set((await git(repoDir(id)).raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').map((l) => l.trim()));
  let name = base;
  for (let n = 2; taken.has(name) || fs.existsSync(branchDir(id, name)); n++) name = `${base}-${n}`;
  return name;
}

async function resetMain(id: string, remoteBranch: string, tokenUrl: string, keepAs: string | null): Promise<{ changed: boolean; kept: string | null }> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
  forgetRemoteStatus(id);
  return withRepoLock(id, async () => {
    const g = git(repoDir(id));
    await scrubbed(() => g.raw(['fetch', tokenUrl, remoteBranch]));
    const head = () => g.raw(['rev-parse', '-q', '--verify', 'HEAD']).then((h) => h.trim(), () => '');
    const before = await head();
    let kept: string | null = null;
    if (keepAs && before) {
      const own = Number((await g.raw(['rev-list', '--count', 'FETCH_HEAD..refs/heads/main'])).trim()) || 0;
      if (own > 0) {
        kept = await freeBranchName(id, keepAs);
        // With its worktree, like createBranch: file routes read the worktree and never add one.
        const dir = branchDir(id, kept);
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await g.raw(['worktree', 'add', '-b', kept, dir, 'refs/heads/main']);
      }
    }
    const dirty = (await g.raw(['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
    await g.raw(['reset', '--hard', 'FETCH_HEAD']);
    return { changed: dirty || (await head()) !== before, kept };
  });
}

/** Pull (fetch + merge) the remote branch into local `main`. Reports conflicts. */
export async function pullFromRemote(id: string, remoteBranch: string, tokenUrl: string): Promise<MergeResult> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
  forgetRemoteStatus(id);
  return withRepoLock(id, async () => {
    const g = git(repoDir(id));
    await scrubbed(() => g.raw(['fetch', tokenUrl, remoteBranch]));
    // simple-git's raw() does NOT reject on a merge conflict, so check for unmerged
    // paths after the merge rather than relying on the command to throw.
    let mergeErr: unknown = null;
    try { await g.raw(['merge', '--no-edit', 'FETCH_HEAD']); } catch (e) { mergeErr = e; }
    const conflicts = (await g.status()).conflicted;
    if (conflicts.length) {
      await g.raw(['merge', '--abort']).catch(() => {});
      return { ok: false, conflicts };
    }
    if (mergeErr) throw mergeErr; // a non-conflict failure
    return { ok: true };
  });
}

/**
 * The branch's committed tree as a ZIP, straight from git: only tracked
 * files travel, never .git, build output or an editor's unflushed state —
 * callers flush and commit first so the archive matches what people see.
 * Flat, without a top folder: that is the shape Overleaf downloads have and
 * the shape the ZIP import expects back.
 */
export function archiveZip(id: string, branch: string, treeish: string = branch): Promise<Buffer> {
  if (!BRANCH_RE.test(branch)) return Promise.reject(new Error('bad branch name'));
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['archive', '--format=zip', treeish], { cwd: repoDir(id) });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim() || `git archive exited ${code}`))));
  });
}

/**
 * The branch's working tree as a tree object, for archiving a project whose
 * edits wait for a hand-made commit: written through a throwaway index, so
 * the branch's own index, refs and history stay untouched. Same file set as
 * a commit would take (.gitignore and the output exclude apply).
 */
export async function workingTreeId(id: string, branch: string): Promise<string> {
  const dir = await ensureWorktree(id, branch);
  ensureOutputExcluded(id);
  const index = path.join(os.tmpdir(), `aldine-index-${crypto.randomUUID()}`);
  // core.symlinks=false as in store.git(): a link checked out as a plain file
  // keeps its link entry, as a commit records it.
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile('git', ['-c', 'core.symlinks=false', ...args], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: index } }, (err, out, errOut) => (err ? reject(new Error(String(errOut).trim() || err.message)) : resolve(String(out).trim())));
  });
  try {
    await run(['read-tree', 'HEAD']);
    await run(['add', '-A']);
    await run(['rm', '-r', '--cached', '--ignore-unmatch', '--quiet', '--', '.aldine-out', '.papyr-out']);
    return await run(['write-tree']);
  } finally {
    fs.rmSync(index, { force: true });
  }
}
