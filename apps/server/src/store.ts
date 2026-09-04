import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';
import { projectsDir, worktreesDir } from './config.js';
import { newId, safeJoin, BRANCH_RE, PROJECT_ID_RE, isTextFile, importPath, isHiddenPath, isHiddenName } from './util.js';
import { db } from './db/index.js';
import type { ProjectMeta } from './db/types.js';

export type { ProjectMeta } from './db/types.js';

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

export function git(dir: string): SimpleGit {
  return simpleGit({ baseDir: dir });
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

export function listProjects(): Promise<ProjectMeta[]> {
  return db().listMeta();
}

export type RemoteLink = NonNullable<ProjectMeta['remote']>;

/**
 * The project's remote, falling back to the legacy `meta.github` when
 * `meta.remote` is absent. Every consumer must go through this — a direct
 * `meta.remote` read treats every pre-existing GitHub project as unlinked.
 */
export function remoteLink(meta: ProjectMeta): RemoteLink | undefined {
  if (meta.remote) return meta.remote;
  return meta.github ? { provider: 'github', ...meta.github } : undefined;
}

/**
 * Set the remote and drop the legacy field, so pre-existing projects upgrade on
 * their next write. Both fields present would leave two candidates for a reader.
 */
export function setRemoteLink(meta: ProjectMeta, link: RemoteLink): void {
  meta.remote = link;
  delete meta.github;
}

const GITIGNORE_LINES = [
  '.aldine-out/', '*.aux', '*.log', '*.out', '*.toc', '*.bbl', '*.bcf',
  '*.blg', '*.synctex.gz', '*.fls', '*.fdb_latexmk', '*.run.xml',
];

/**
 * Every project must ignore build artefacts, or a compile turns into a commit of
 * its own droppings. A seed (template) may ship its own .gitignore, so keep that
 * file and append only the lines it is missing rather than overwriting it.
 */
function writeGitignore(dir: string, seeded?: string | Buffer): void {
  const existing = seeded === undefined ? '' : seeded.toString('utf8');
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  fs.writeFileSync(path.join(dir, '.gitignore'), `${prefix}${missing.join('\n')}\n`);
}

export async function createProject(name: string, files: Record<string, string | Buffer> = {}, ownerId?: string): Promise<ProjectMeta> {
  const id = newId();
  const dir = repoDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const g = git(dir);
  await g.init(['--initial-branch=main']);
  await g.addConfig('user.name', 'Aldine');
  await g.addConfig('user.email', 'aldine@localhost');

  const seed: Record<string, string | Buffer> = Object.keys(files).length ? files : {
    'main.tex': DEFAULT_MAIN_TEX(name),
    'references.bib': DEFAULT_BIB,
  };
  const written: string[] = [];
  try {
    const g = git(dir);
    await g.init(['--initial-branch=main']);
    await g.addConfig('user.name', 'Aldine');
    await g.addConfig('user.email', 'aldine@localhost');
    for (const [rel, content] of Object.entries(seed)) {
      const norm = importPath(rel);
      if (norm === null || isHiddenPath(norm)) throw new Error(`file path "${rel}" is not allowed`);
      if (typeof content !== 'string') throw new Error(`content of "${rel}" must be a string`);
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
  writeGitignore(dir, seed['.gitignore']);
  await g.add(['-A']);
  await g.commit('Initial commit');

  const rootFile = written.includes('main.tex') ? 'main.tex' : written.find((f) => f.endsWith('.tex')) || '';
  const meta: ProjectMeta = { id, name, rootFile, engine: 'pdf', createdAt: new Date().toISOString() };
  if (ownerId) { meta.ownerId = ownerId; meta.share = { mode: 'private', collaborators: [] }; }
  await writeMeta(meta);
  return meta;
}

/** Permanently remove a project — repo, worktrees, and metadata. */
export async function deleteProject(id: string): Promise<void> {
  fs.rmSync(repoDir(id), { recursive: true, force: true });
  fs.rmSync(path.join(worktreesDir, id), { recursive: true, force: true });
  await db().deleteMeta(id);
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

/**
 * Hard-delete trashed projects older than `days`. Returns the ids purged.
 *
 * `beforeDelete` runs per project while its metadata still exists — the caller
 * uses it to clean up a remote mirror whose delete failed at trash time. It must
 * not throw; a purge that stops halfway leaves the trash never draining.
 */
export async function purgeExpiredTrash(
  days: number,
  beforeDelete?: (meta: ProjectMeta) => Promise<void>,
): Promise<string[]> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const purged: string[] = [];
  for (const m of await listProjects()) {
    if (m.deletedAt && Date.parse(m.deletedAt) < cutoff) {
      if (beforeDelete) await beforeDelete(m).catch(() => {});
      await deleteProject(m.id);
      purged.push(m.id);
    }
  }
  return purged;
}

export interface TreeEntry { path: string; type: 'file' | 'dir'; size?: number; binary?: boolean }

export function listFiles(id: string, branch: string): TreeEntry[] {
  const base = branchDir(id, branch);
  const out: TreeEntry[] = [];
  const walk = (rel: string) => {
    const abs = path.join(base, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (isHiddenName(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: relPath, type: 'dir' });
        walk(relPath);
      } else {
        out.push({ path: relPath, type: 'file', size: fs.statSync(path.join(base, relPath)).size, binary: !isTextFile(relPath) });
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

export function writeFile(id: string, branch: string, rel: string, content: string | Buffer): void {
  const abs = safeJoin(branchDir(id, branch), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function deleteFile(id: string, branch: string, rel: string): void {
  fs.rmSync(safeJoin(branchDir(id, branch), rel), { recursive: true, force: true });
}

export function renameFile(id: string, branch: string, from: string, to: string): void {
  const base = branchDir(id, branch);
  const absTo = safeJoin(base, to);
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.renameSync(safeJoin(base, from), absTo);
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
