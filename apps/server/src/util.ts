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
