import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';
import { projectsDir, worktreesDir } from './config.js';
import { newId, safeJoin, BRANCH_RE, PROJECT_ID_RE, isTextFile, importPath, isHiddenPath, isHiddenName } from './util.js';
import { db } from './db/index.js';
import type { ProjectMeta, ProjectVisit, ProjectOpen, RemoteLink, Invitation } from './db/types.js';

export type { ProjectMeta, ProjectVisit, ProjectOpen, RemoteLink, Invitation } from './db/types.js';

export function repoDir(id: string): string {
  if (!PROJECT_ID_RE.test(id)) throw new Error('bad project id');
  return path.join(projectsDir, id);
}

/** Directory containing the checkout of a given branch. main lives in the repo dir; others get worktrees. */
export function branchDir(id: string, branch: string): string {
  if (!BRANCH_RE.test(branch) || branch.includes('..')) throw new Error('bad branch name');
  if (branch === 'main') return repoDir(id);
  // Flatten hierarchical names (feature/x) to a single dir segment so a branch
  // named "feature" can't collide with "feature/x"'s worktree parent.
  const safe = branch.replace(/[^A-Za-z0-9._-]/g, '__');
  return path.join(worktreesDir, id, safe);
}

/** core.symlinks=false on every command: a link in a cloned or pulled tree
 *  is checked out as a plain file holding the link's target, never as a link
 *  the server would follow. The tree entry keeps its link mode. */
export function git(dir: string): SimpleGit {
  return simpleGit({ baseDir: dir, config: ['core.symlinks=false'] });
}

/** Throws 'project not found' when absent, preserving the try/catch semantics at call sites. */
export async function readMeta(id: string): Promise<ProjectMeta> {
  const m = await db().readMeta(id);
  if (!m) throw new Error('project not found');
  return m;
}

export function writeMeta(meta: ProjectMeta): Promise<void> {
  return db().writeMeta(meta);
}

/** How far `userId` has been shown Claude's commits on one branch. */
export function getProjectVisit(userId: string, id: string, branch: string): Promise<ProjectVisit | null> {
  return db().getProjectVisit(userId, id, branch);
}

export function setProjectVisit(v: ProjectVisit): Promise<void> {
  return db().setProjectVisit(v);
}

/** One person's opens and removals across their project list. */
export function listProjectOpens(userId: string): Promise<ProjectOpen[]> {
  return db().listProjectOpens(userId);
}

export function getProjectOpen(userId: string, id: string): Promise<ProjectOpen | null> {
  return db().getProjectOpen(userId, id);
}

export function addShareEntry(id: string, entry: string): Promise<boolean> {
  return db().addShareEntry(id, entry);
}

export function setInvitation(inv: Invitation): Promise<void> {
  return db().setInvitation(inv);
}

export function getInvitation(id: string): Promise<Invitation | null> {
  return db().getInvitation(id);
}

export function listProjectInvitations(id: string): Promise<Invitation[]> {
  return db().listProjectInvitations(id);
}

export function listInvitationsTo(to: string[]): Promise<Invitation[]> {
  return db().listInvitationsTo(to);
}

export function settleInvitation(id: string, status: 'accepted' | 'declined' | 'withdrawn', at: string): Promise<boolean> {
  return db().settleInvitation(id, status, at);
}

export function updatePendingInvitation(id: string, fields: { expiresAt?: string; emailedAt?: string }): Promise<boolean> {
  return db().updatePendingInvitation(id, fields);
}

export function deleteInvitation(id: string): Promise<void> {
  return db().deleteInvitation(id);
}

export function setProjectOpen(o: ProjectOpen): Promise<void> {
  return db().setProjectOpen(o);
}

export function deleteProjectOpen(userId: string, id: string): Promise<void> {
  return db().deleteProjectOpen(userId, id);
}

export function resetProjectOpenBranch(id: string, branch: string): Promise<void> {
  return db().resetProjectOpenBranch(id, branch);
}

export function listProjects(): Promise<ProjectMeta[]> {
  return db().listMeta();
}

/** The project's remote link, reading the pre-GitLab `github` field as provider 'github'. */
export function remoteLink(meta: ProjectMeta): RemoteLink | null {
  if (meta.remote) return meta.remote;
  if (meta.github) return { provider: 'github', ...meta.github };
  return null;
}

/** Set (or clear, with null) the remote link. Drops the legacy `github` field: the next write migrates. */
export function setRemoteLink(meta: ProjectMeta, link: RemoteLink | null): void {
  if (link) meta.remote = link; else delete meta.remote;
  delete meta.github;
}

/** `files` omitted seeds the default article; `{}` is a blank project (no
 *  files, rootFile '' until the first .tex appears). Keys are normalised like
 *  ZIP entries and may not reach `.git` or `.aldine*`: the initial commit runs
 *  git on the fresh repo, so a seeded `.git/config` would execute on the
 *  server. A rejected key or a failed write leaves no repo dir behind. */
export async function createProject(name: string, files?: Record<string, string | Buffer>, ownerId?: string, opts: { createdVia?: 'agent' } = {}): Promise<ProjectMeta> {
  const id = newId();
  const dir = repoDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const seed = files ?? {
    'main.tex': DEFAULT_MAIN_TEX(name),
    'references.bib': DEFAULT_BIB,
  };
  const written: string[] = [];
  try {
    const g = await initRepo(dir);
    for (const [rel, content] of Object.entries(seed)) {
      const norm = importPath(rel);
      if (norm === null || isHiddenPath(norm)) throw new Error(`file path "${rel}" is not allowed`);
      // Templates seed Buffers (a logo or figure must not go through UTF-8);
      // user-supplied seeds are screened by seedError before they get here.
      if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new Error(`content of "${rel}" must be text or bytes`);
      const abs = safeJoin(dir, norm);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      written.push(norm);
    }
    fs.writeFileSync(path.join(dir, '.gitignore'), '.aldine-out/\n*.aux\n*.log\n*.out\n*.toc\n*.bbl\n*.bcf\n*.blg\n*.synctex.gz\n*.fls\n*.fdb_latexmk\n*.run.xml\n');
    await g.add(['-A']);
    await g.commit('Initial commit');
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const rootFile = written.includes('main.tex') ? 'main.tex' : written.find((f) => f.endsWith('.tex')) || '';
  const meta: ProjectMeta = { id, name, rootFile, engine: 'pdf', createdAt: new Date().toISOString() };
  if (ownerId) { meta.ownerId = ownerId; meta.share = { mode: 'private', collaborators: [] }; }
  if (opts.createdVia) meta.createdVia = opts.createdVia;
  await writeMeta(meta);
  return meta;
}

async function initRepo(dir: string): Promise<SimpleGit> {
  const g = git(dir);
  await g.init(['--initial-branch=main']);
  await g.addConfig('user.name', 'Aldine');
  await g.addConfig('user.email', 'aldine@localhost');
  return g;
}

/** Largest source, in bytes of copied files, that Duplicate accepts. */
export const COPY_MAX_BYTES = Number(process.env.COPY_MAX_BYTES) > 0 ? Number(process.env.COPY_MAX_BYTES) : 256 * 1024 * 1024;
export class CopyTooLargeError extends Error {
  constructor() { super(`project is larger than ${Math.round(COPY_MAX_BYTES / (1024 * 1024))} MB`); }
}

/** Bytes of the files `keep` admits under `dir`; stops counting once past `limit`. */
function copySize(dir: string, keep: (abs: string) => boolean, limit: number): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (total > limit) return;
      const abs = path.join(d, e.name);
      if (!keep(abs)) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) total += fs.statSync(abs).size;
    }
  };
  walk(dir);
  return total;
}

/**
 * A new project with the files of `source`'s main working tree, uncommitted
 * edits included, in one first commit: no history, remote, share settings,
 * Zotero link or build output. The typesetting settings come along, so the
 * copy builds the way the original does. The tree is copied before the first
 * await: callers flush open documents and hold the source's repo lock, and
 * then the copy is one consistent state of it. Links are not copied.
 */
export async function copyProject(source: ProjectMeta, name: string, ownerId?: string): Promise<ProjectMeta> {
  const from = repoDir(source.id);
  const copied = (src: string) => {
    const rel = path.relative(from, src);
    return !rel || (!isHiddenPath(rel) && !fs.lstatSync(src).isSymbolicLink());
  };
  // The copy runs synchronously on the event loop; the cap bounds that stall.
  if (copySize(from, copied, COPY_MAX_BYTES) > COPY_MAX_BYTES) throw new CopyTooLargeError();
  const id = newId();
  const dir = repoDir(id);
  try {
    fs.cpSync(from, dir, { recursive: true, filter: copied });
    const g = await initRepo(dir);
    await g.add(['-A']);
    await g.raw(['commit', '--allow-empty', '-m', 'Initial commit']);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const meta: ProjectMeta = { id, name, rootFile: source.rootFile, engine: source.engine, createdAt: new Date().toISOString() };
  if (source.stopOnFirstError !== undefined) meta.stopOnFirstError = source.stopOnFirstError;
  if (source.manualCommits !== undefined) meta.manualCommits = source.manualCommits;
  if (ownerId) { meta.ownerId = ownerId; meta.share = { mode: 'private', collaborators: [] }; }
  await writeMeta(meta);
  return meta;
}

/**
 * Recursively remove a project or worktree directory. The compiler renders the
 * page-1 thumbnail into .aldine-out after the typeset answered, so a file can
 * appear while the tree is being removed (ENOTEMPTY); a retry removes it. The
 * renderer never recreates the directory, so once it is gone it stays gone.
 */
export async function removeTree(dir: string): Promise<void> {
  // The sync variant sleeps between retries on the event loop.
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Permanently remove a project — repo, worktrees, and metadata. */
export async function deleteProject(id: string): Promise<void> {
  await removeTree(repoDir(id));
  await removeTree(path.join(worktreesDir, id));
  await db().deleteMeta(id);
  await db().deleteProjectVisits(id);
  await db().deleteProjectOpens(id);
  await db().deleteProjectActivity(id);
  await db().deleteProjectInvitations(id);
}

/** Move a project to trash: data stays on disk, listings hide it, purge collects it later. */
export async function softDeleteProject(id: string): Promise<void> {
  const meta = await readMeta(id);
  meta.deletedAt = new Date().toISOString();
  await writeMeta(meta);
}

export async function restoreProject(id: string): Promise<ProjectMeta> {
  const meta = await readMeta(id);
  delete meta.deletedAt;
  await writeMeta(meta);
  return meta;
}

/** Hard-delete trashed projects older than `days`. Returns the ids purged.
 *  `beforeDelete` runs per project first (remote clean-up); its failure is logged, not fatal. */
export async function purgeExpiredTrash(days: number, beforeDelete?: (meta: ProjectMeta) => Promise<void>): Promise<string[]> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const purged: string[] = [];
  for (const m of await listProjects()) {
    if (m.deletedAt && Date.parse(m.deletedAt) < cutoff) {
      if (beforeDelete) await beforeDelete(m).catch((err) => console.error(`[aldine] trash purge: remote clean-up of ${m.id} failed`, err?.message || err));
      await deleteProject(m.id);
      purged.push(m.id);
    }
  }
  return purged;
}

/** `mtime` (ms) is what a client keys a cached copy of the bytes on: a replaced file gets a new one. */
export interface TreeEntry { path: string; type: 'file' | 'dir'; size?: number; mtime?: number; binary?: boolean }

export function listFiles(id: string, branch: string): TreeEntry[] {
  const base = branchDir(id, branch);
  const out: TreeEntry[] = [];
  const walk = (rel: string) => {
    const abs = path.join(base, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      // safeJoin refuses a path through a link, so a link is no project file
      if (isHiddenName(e.name) || e.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: relPath, type: 'dir' });
        walk(relPath);
      } else {
        const st = fs.statSync(path.join(base, relPath));
        out.push({ path: relPath, type: 'file', size: st.size, mtime: Math.floor(st.mtimeMs), binary: !isTextFile(relPath) });
      }
    }
  };
  walk('');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function readFile(id: string, branch: string, rel: string): Buffer {
  return fs.readFileSync(safeJoin(branchDir(id, branch), rel));
}

export function fileExists(id: string, branch: string, rel: string): boolean {
  try { return fs.existsSync(safeJoin(branchDir(id, branch), rel)); } catch { return false; }
}

export function isDirectory(id: string, branch: string, rel: string): boolean {
  try { return fs.statSync(safeJoin(branchDir(id, branch), rel)).isDirectory(); } catch { return false; }
}

/** The checkout path of a project file or folder the store may write, rename
 *  or delete: never the branch directory itself (on main that is the whole
 *  repository, .git included), never git internals or compile output. */
function entryPath(base: string, rel: string): string {
  const abs = safeJoin(base, rel);
  if (abs === base || isHiddenPath(rel)) throw new Error(`not a project file: ${rel}`);
  return abs;
}

export function writeFile(id: string, branch: string, rel: string, content: string | Buffer): void {
  const abs = entryPath(branchDir(id, branch), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function deleteFile(id: string, branch: string, rel: string): void {
  fs.rmSync(entryPath(branchDir(id, branch), rel), { recursive: true, force: true });
}

export function renameFile(id: string, branch: string, from: string, to: string): void {
  const base = branchDir(id, branch);
  const absTo = entryPath(base, to);
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.renameSync(entryPath(base, from), absTo);
}

const DEFAULT_MAIN_TEX = (title: string) => `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}
\\usepackage[backend=biber]{biblatex}
\\addbibresource{references.bib}

\\title{${title.replace(/[\\{}]/g, '')}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here\\ldots

\\printbibliography
\\end{document}
`;

const DEFAULT_BIB = `@article{knuth1984,
  author  = {Knuth, Donald E.},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  year    = {1984},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
}
`;
