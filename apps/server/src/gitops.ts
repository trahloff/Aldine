import fs from 'node:fs';
import path from 'node:path';
import { projectsDir } from './config.js';
import { repoDir, branchDir, git } from './store.js';
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
async function commitArgv(g: ReturnType<typeof git>, message: string, author: string | undefined, paths?: string[]): Promise<string> {
  const args = ['--literal-pathspecs', 'commit', '-m', message];
  if (author) args.push(`--author=${author} <${author.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@aldine.local>`);
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
export async function commitPathsHeld(id: string, branch: string, paths: string[], message: string, author?: string): Promise<{ committed: boolean; hash?: string }> {
  if (!paths.length) return { committed: false };
  const dir = await ensureWorktree(id, branch);
  const g = git(dir);
  ensureOutputExcluded(id);
  const changed = new Set((await g.status()).files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])));
  const present = paths.filter((p) => changed.has(p));
  if (!present.length) return { committed: false };
  await g.raw(['--literal-pathspecs', 'add', '--', ...present]);
  const status = await g.status();
  const staged = new Set(status.staged);
  if (!present.some((p) => staged.has(p))) return { committed: false };
  // Committing the explicit pathspec (not the whole index) keeps anything else
  // that happens to be staged out of the attributed commit.
  const hash = await commitArgv(g, message, author, present);
  return { committed: true, hash };
}

/** Takes the repo lock; callers already inside withRepoLock use the Held variant. */
export function commitPaths(id: string, branch: string, paths: string[], message: string, author?: string): Promise<{ committed: boolean; hash?: string }> {
  return withRepoLock(id, () => commitPathsHeld(id, branch, paths, message, author));
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
export async function autoCommitHeld(id: string, branch: string, sweepMessage = 'aldine: autosave', sweepAuthor?: string): Promise<{ committed: boolean; hash?: string }> {
  const attributed = takeAttributedPaths(id, branch);
  if (attributed) {
    // One commit per intent, so History titles name what each commit holds.
    const groups = byIntent(attributed.paths);
    for (let i = 0; i < groups.length; i++) {
      try { await commitPathsHeld(id, branch, groups[i].paths, groups[i].message, attributed.author); }
      catch (err) {
        registerAttributedPaths(id, branch, RETRY_INTENT, attributed.author, groups[i].paths);
        for (const g of groups.slice(i + 1)) registerAttributedPaths(id, branch, g.message, attributed.author, g.paths);
        throw err;
      }
    }
  }
  return commitAllHeld(id, branch, sweepMessage, sweepAuthor);
}

/** Takes the repo lock; callers already inside withRepoLock use the Held variant. */
export function autoCommit(id: string, branch: string, sweepMessage = 'aldine: autosave', sweepAuthor?: string): Promise<{ committed: boolean; hash?: string }> {
  return withRepoLock(id, () => autoCommitHeld(id, branch, sweepMessage, sweepAuthor));
}

/** Short HEAD of a branch — the `{branch, head}` echo every MCP tool result
 *  carries so the agent can narrate what it touched. '' when the ref cannot
 *  be resolved (echo is informational; it must never fail the tool call). */
export async function branchShortHead(id: string, branch: string): Promise<string> {
  try { return (await git(repoDir(id)).revparse(['--short', branch])).trim(); } catch { return ''; }
}

export interface LogEntry { hash: string; date: string; message: string; author: string }

/** Records are split on 0x1e/0x1f, which git never emits from %s or %an
 *  (simple-git's default parser splits on a printable marker a commit
 *  subject can contain, letting a message move itself into the author
 *  field — the field the History panel and the session review key on).
 *  %an, not %aN: a .mailmap committed into the project would otherwise
 *  rename authors. */
export async function log(id: string, branch: string, limit = 50): Promise<LogEntry[]> {
  if (!BRANCH_RE.test(branch) || branch.includes('..')) throw new Error('bad branch name');
  const raw = await git(repoDir(id)).raw(['log', branch, `--max-count=${limit}`, '--format=%H%x1f%aI%x1f%an%x1f%s%x1e', '--']);
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, date, author, ...message] = r.split('\x1f');
    return { hash, date, message: message.join('\x1f'), author };
  });
}

export interface MergeResult { ok: boolean; conflicts?: string[]; message?: string }

/** Merge `from` into `into`. On conflict: abort and report conflicting files. */
export async function merge(id: string, from: string, into: string, author?: string): Promise<MergeResult> {
  return withRepoLock(id, async () => {
    // commit any pending changes in both branches first so the merge sees latest state
    await autoCommitHeld(id, from, `aldine: checkpoint before merge`, author).catch(() => {});
    await autoCommitHeld(id, into, `aldine: checkpoint before merge`, author).catch(() => {});
    const dir = await ensureWorktree(id, into);
    const g = git(dir);
    let mergeErr: unknown = null;
    try { await g.raw(['merge', '--no-ff', '-m', `Merge ${from} into ${into}`, from]); } catch (e) { mergeErr = e; }
    const conflicts = (await g.status()).conflicted;
    if (conflicts.length) {
      await g.raw(['merge', '--abort']).catch(() => {});
      return { ok: false, conflicts };
    }
    if (mergeErr) return { ok: false, message: String((mergeErr as Error)?.message || mergeErr) };
    return { ok: true };
  });
}

/**
 * Revert the given commits as ONE new commit — session "undo" is additive
 * history, never a rewrite. Hashes must arrive newest-first so each revert
 * applies against the state it expects. On conflict the revert is aborted and
 * nothing is committed.
 */
export async function revertCommits(id: string, branch: string, hashes: string[], message: string, author?: string): Promise<{ ok: boolean; hash?: string }> {
  if (!hashes.length || hashes.some((h) => !/^[0-9a-f]{4,40}$/.test(h))) throw new Error('bad commit hash');
  return withRepoLock(id, async () => {
    const dir = await ensureWorktree(id, branch);
    const g = git(dir);
    try {
      await g.raw(['revert', '--no-commit', ...hashes]);
    } catch {
      await g.raw(['revert', '--abort']).catch(() => {});
      throw new Error('Could not revert cleanly — later edits overlap these changes');
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

/** Unified patch for a single commit (handles root commits, which have no parent). */
export async function commitDiff(id: string, hash: string): Promise<{ patch: string; stat: string }> {
  if (!/^[0-9a-f]{4,40}$/.test(hash)) throw new Error('bad commit hash');
  const g = git(repoDir(id));
  const patch = await g.raw(['show', hash, '--no-color', '--pretty=format:', '--']);
  const stat = await g.raw(['show', hash, '--no-color', '--stat', '--pretty=format:', '--']);
  return { patch: patch.replace(/^\n+/, ''), stat: stat.replace(/^\n+/, '') };
}

// ---------- remote sync (GitHub) ----------
// SECURITY: the projects dir is shared with the compiler, so the auth token must
// never land in .git/config. We pass a tokenized URL inline per network op and
// keep only a credential-free URL as `origin`.

/** Strip any `user:token@` credentials from an http(s) URL. */
export function stripCreds(url: string): string {
  return url.replace(/(https?:\/\/)[^@/]+@/i, '$1');
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
  await git(projectsDir).clone(tokenUrl, dir, ['--no-single-branch']);
  const g = git(dir);
  await g.remote(['set-url', 'origin', stripCreds(tokenUrl)]); // never persist the token
  await g.addConfig('user.name', 'Aldine');
  await g.addConfig('user.email', 'aldine@localhost');
  const remoteBranch = (await g.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main';
  if (remoteBranch !== 'main') await g.raw(['branch', '-m', 'main']);
  ensureOutputExcluded(id); // cloned repos have no Aldine .gitignore; keep compile output out of their history
  return { remoteBranch };
}

/** Push local `main` to the remote branch. Assumes commits already made. */
export async function pushToRemote(id: string, remoteBranch: string, tokenUrl: string): Promise<void> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
  await git(repoDir(id)).raw(['push', tokenUrl, `refs/heads/main:refs/heads/${remoteBranch}`]);
}

/** Current HEAD commit hash of the project's main branch (cheap, local). */
export async function headCommit(id: string): Promise<string> {
  return (await git(repoDir(id)).revparse(['HEAD'])).trim();
}

/** How many commits local `main` is ahead/behind the remote branch (fetches first). */
export async function remoteStatus(id: string, remoteBranch: string, tokenUrl: string): Promise<{ ahead: number; behind: number }> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
  const g = git(repoDir(id));
  await g.raw(['fetch', tokenUrl, remoteBranch]);
  const ahead = Number((await g.raw(['rev-list', '--count', 'FETCH_HEAD..refs/heads/main'])).trim()) || 0;
  const behind = Number((await g.raw(['rev-list', '--count', 'refs/heads/main..FETCH_HEAD'])).trim()) || 0;
  return { ahead, behind };
}

/** Discard all local changes and hard-reset local `main` to the remote branch. */
export async function resetToRemote(id: string, remoteBranch: string, tokenUrl: string): Promise<void> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
  return withRepoLock(id, async () => {
    const g = git(repoDir(id));
    await g.raw(['fetch', tokenUrl, remoteBranch]);
    await g.raw(['reset', '--hard', 'FETCH_HEAD']);
  });
}

/** Pull (fetch + merge) the remote branch into local `main`. Reports conflicts. */
export async function pullFromRemote(id: string, remoteBranch: string, tokenUrl: string): Promise<MergeResult> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
  return withRepoLock(id, async () => {
    const g = git(repoDir(id));
    await g.raw(['fetch', tokenUrl, remoteBranch]);
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
