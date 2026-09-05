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

/** Create branch from a base and materialize its worktree. */
export async function createBranch(id: string, name: string, from = 'main'): Promise<void> {
  if (!BRANCH_RE.test(name) || name.includes('..')) throw new Error('bad branch name');
  if (!BRANCH_RE.test(from) || from.includes('..')) throw new Error('bad base branch name');
  if (name === 'main') throw new Error('main already exists');
  const g = git(repoDir(id));
  const dir = branchDir(id, name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await g.raw(['worktree', 'add', '-b', name, dir, from]);
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
  const g = git(repoDir(id));
  const dir = branchDir(id, name);
  try { await g.raw(['worktree', 'remove', '--force', dir]); } catch { /* worktree may be gone */ }
  await g.raw(['branch', '-D', name]);
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

export async function commitAll(id: string, branch: string, message: string, author?: string): Promise<{ committed: boolean; hash?: string }> {
  const dir = await ensureWorktree(id, branch);
  const g = git(dir);
  ensureOutputExcluded(id);
  // Self-heal projects that committed compile output before it was excluded
  // (.papyr-out is the pre-rename output dir).
  await g.raw(['rm', '-r', '--cached', '--ignore-unmatch', '--quiet', '--', '.aldine-out', '.papyr-out']).catch(() => {});
  await g.add(['-A']);
  const status = await g.status();
  if (status.staged.length === 0 && status.files.length === 0) return { committed: false };
  const opts: Record<string, string | null> = {};
  if (author) opts['--author'] = `${author} <${author.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@aldine.local>`;
  const res = await g.commit(message, undefined, opts);
  return { committed: true, hash: res.commit };
}

export interface LogEntry { hash: string; date: string; message: string; author: string }

export async function log(id: string, branch: string, limit = 50): Promise<LogEntry[]> {
  const g = git(repoDir(id));
  const res = await g.log([branch, `--max-count=${limit}`]);
  return res.all.map((c) => ({ hash: c.hash, date: c.date, message: c.message, author: c.author_name }));
}

export interface MergeResult { ok: boolean; conflicts?: string[]; message?: string }

/** Merge `from` into `into`. On conflict: abort and report conflicting files. */
export async function merge(id: string, from: string, into: string, author?: string): Promise<MergeResult> {
  // commit any pending changes in both branches first so the merge sees latest state
  await commitAll(id, from, `aldine: checkpoint before merge`, author).catch(() => {});
  await commitAll(id, into, `aldine: checkpoint before merge`, author).catch(() => {});
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
  const g = git(repoDir(id));
  await g.raw(['fetch', tokenUrl, remoteBranch]);
  await g.raw(['reset', '--hard', 'FETCH_HEAD']);
}

/** Pull (fetch + merge) the remote branch into local `main`. Reports conflicts. */
export async function pullFromRemote(id: string, remoteBranch: string, tokenUrl: string): Promise<MergeResult> {
  if (!BRANCH_RE.test(remoteBranch)) throw new Error('bad branch name');
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
}
