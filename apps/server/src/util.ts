import crypto from 'node:crypto';
import path from 'node:path';

export function newId(len = 10): string {
  return crypto.randomBytes(16).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, len).toLowerCase();
}

export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,80}$/;
export const PROJECT_ID_RE = /^[a-z0-9]{4,20}$/;

/** Resolve a user-supplied relative file path inside a base dir, rejecting escapes. */
export function safeJoin(base: string, rel: string): string {
  // Reject any `..` segment up front: `path.resolve` would collapse `a/../.git`
  // back inside `base` (so the prefix check below passes), letting a crafted
  // path reach the repo's own `.git`. No legitimate project path needs `..`.
  if (rel.split(/[\\/]/).includes('..')) throw new Error(`path escapes project: ${rel}`);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`path escapes project: ${rel}`);
  return abs;
}

/**
 * Normalize a ZIP entry name to a project-relative posix path, or null when it
 * cannot live inside a project: absolute, drive-lettered, a `..` segment, or
 * nothing left after dropping `.` segments. Windows-made archives use `\\` as
 * the separator; those become `/`. A legitimate name like `data..csv` is not
 * an escape — only whole `..` segments are (the safeJoin rule above).
 */
export function importPath(entry: string): string | null {
  const unified = entry.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified) || unified.includes('\0')) return null;
  const segments = unified.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (!segments.length || segments.includes('..')) return null;
  return segments.join('/');
}

/** A path segment that names git internals or compile output. Compared
 *  case-insensitively and without trailing dots or spaces: on macOS and
 *  Windows `.GIT/config` and `.git./config` open `.git/config`, and the
 *  initial commit runs git on whatever the seed wrote there. `.gitignore` is
 *  not hidden. */
export function isHiddenName(seg: string): boolean {
  const s = seg.toLowerCase().replace(/[. ]+$/, '');
  return s === '.git' || s.startsWith('.aldine');
}

/** git internals and compile output are never user-addressable, at any depth:
 *  'sub/.git/config' and 'paper/.aldine-out/x' are caught, not just a leading
 *  '.git'. Matches store.listFiles, which skips these names at every level. */
export function isHiddenPath(rel: string): boolean {
  return rel.split(/[\\/]/).some(isHiddenName);
}

export const SEED_MAX_FILES = 1000;
export const SEED_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Why a `files` map cannot seed a project, or null when it can. Keys are
 * written to a fresh repo before its first commit runs git, so a key that
 * reaches `.git/` (config, hooks) would execute on the server; the file
 * routes screen the same names. A key that is both a file and a directory
 * (`a` and `a/b`) would fail halfway through the write.
 */
export function seedError(files: unknown): string | null {
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return '`files` must be an object mapping paths to contents';
  const entries = Object.entries(files);
  if (entries.length > SEED_MAX_FILES) return `Too many files (${entries.length}); the limit is ${SEED_MAX_FILES}`;
  const paths = new Set<string>();
  let total = 0;
  for (const [rel, content] of entries) {
    const norm = importPath(rel);
    if (norm === null || isHiddenPath(norm)) return `File path "${rel}" is not allowed`;
    if (typeof content !== 'string') return `Content of "${rel}" must be a string`;
    total += Buffer.byteLength(content);
    if (total > SEED_MAX_BYTES) return `Files total more than ${Math.round(SEED_MAX_BYTES / (1024 * 1024))} MB`;
    if (paths.has(norm)) return `File path "${rel}" is given twice`;
    paths.add(norm);
  }
  // createProject writes `.gitignore` after the seed files, so a seed that
  // makes `.gitignore` a directory fails at that write.
  const taken = new Set([...paths, '.gitignore']);
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      if (taken.has(dir)) return `"${dir}" cannot be both a file and a directory`;
    }
  }
  return null;
}

export function isTextFile(p: string): boolean {
  return /\.(tex|bib|cls|sty|bst|bbx|cbx|md|txt|csv|json|yml|yaml|def|clo|dtx|ins|lco|tikz|pgf|toml|cfg|gitignore)$/i.test(p) || !path.basename(p).includes('.');
}

export function debouncePerKey<A extends unknown[]>(ms: number, fn: (key: string, ...args: A) => void) {
  const timers = new Map<string, NodeJS.Timeout>();
  return (key: string, ...args: A) => {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(key, setTimeout(() => { timers.delete(key); fn(key, ...args); }, ms));
  };
}
