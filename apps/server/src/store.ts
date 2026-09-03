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

/** `files` omitted seeds the default article; `{}` is a blank project (no
 *  files, rootFile '' until the first .tex appears). Keys are normalised like
 *  ZIP entries and may not reach `.git` or `.aldine*`: the initial commit runs
 *  git on the fresh repo, so a seeded `.git/config` would execute on the
 *  server. A rejected key or a failed write leaves no repo dir behind. */
export async function createProject(name: string, files?: Record<string, string>, ownerId?: string): Promise<ProjectMeta> {
  const id = newId();
  const dir = repoDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const seed = files ?? {
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

/** Hard-delete trashed projects older than `days`. Returns the ids purged. */
export async function purgeExpiredTrash(days: number): Promise<string[]> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const purged: string[] = [];
  for (const m of await listProjects()) {
    if (m.deletedAt && Date.parse(m.deletedAt) < cutoff) {
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
