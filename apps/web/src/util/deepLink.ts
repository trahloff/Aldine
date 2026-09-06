import type { TreeEntry } from '../api';

/** `?file=` as TeX reports paths: `./` prefixes and inner `/./` segments are noise. */
export function normalizeDeepLinkPath(file: string): string {
  return file.replace(/^(?:\.\/)+/, '').replace(/\/(?:\.\/)+/g, '/');
}

export type DeepLinkMatch = { path: string } | { ambiguous: string[] } | null;

/**
 * Resolves a normalized `?file=` path against the tree: the exact path, else
 * a suffix match in either direction (`a/b/main.tex` ↔ `b/main.tex`) that hits
 * exactly one file. Directories never match — opening one as a file would
 * create a collab doc at a directory path.
 */
export function resolveDeepLinkFile(entries: TreeEntry[], norm: string): DeepLinkMatch {
  if (!norm) return null;
  const files = entries.filter((e) => e.type === 'file');
  const exact = files.find((e) => e.path === norm);
  if (exact) return { path: exact.path };
  const hits = files.filter((e) => norm.endsWith('/' + e.path) || e.path.endsWith('/' + norm));
  if (hits.length === 1) return { path: hits[0].path };
  if (hits.length > 1) return { ambiguous: hits.map((h) => h.path) };
  return null;
}
