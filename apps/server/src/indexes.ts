import * as store from './store.js';
import { flushBranchDocs, contentVersion } from './collab.js';
import { parseBib, type BibEntry } from './bib.js';
import { latexWordCount, documentFiles } from './wordcount.js';
import { isHiddenPath } from './util.js';

/**
 * Per-branch derived indexes (\cite keys, \label targets, document word
 * count) shared by the REST routes and the MCP tools — one implementation,
 * never two copies (SECURITY.md: shared functions). Each walks the whole
 * branch (readdir + read + parse every .bib/.tex), so results are cached per
 * branch keyed by the content version that every write path bumps: a hit
 * costs a Map lookup, a miss exactly one walk. Every entry point flushes open
 * documents first so pending live edits count.
 */

const bibIndexCache = new Map<string, { v: number; entries: BibEntry[] }>();
const labelIndexCache = new Map<string, { v: number; labels: LabelEntry[] }>();
const wordCountCache = new Map<string, { v: number; body: WordCount }>();

export interface LabelEntry { label: string; file: string }
export interface WordCount { rootFile: string; total: number; files: Record<string, number> }

function versionKey(projectId: string, branch: string): { key: string; v: number } {
  flushBranchDocs(projectId, branch); // may bump the version (pending edits reach disk)
  return { key: `${projectId}::${branch}`, v: contentVersion(projectId, branch) };
}

export function bibIndex(projectId: string, branch: string): BibEntry[] {
  const { key, v } = versionKey(projectId, branch);
  const hit = bibIndexCache.get(key);
  if (hit && hit.v === v) return hit.entries;
  const entries: BibEntry[] = [];
  for (const f of store.listFiles(projectId, branch)) {
    if (f.type === 'file' && f.path.endsWith('.bib')) {
      try {
        entries.push(...parseBib(store.readFile(projectId, branch, f.path).toString('utf8'), f.path));
      } catch { /* skip broken bib */ }
    }
  }
  bibIndexCache.set(key, { v, entries });
  return entries;
}

export function labelIndex(projectId: string, branch: string): LabelEntry[] {
  const { key, v } = versionKey(projectId, branch);
  const hit = labelIndexCache.get(key);
  if (hit && hit.v === v) return hit.labels;
  const labels: LabelEntry[] = [];
  const re = /\\label\{([^}]+)\}/g;
  for (const f of store.listFiles(projectId, branch)) {
    if (f.type !== 'file' || !f.path.endsWith('.tex')) continue;
    try {
      const text = store.readFile(projectId, branch, f.path).toString('utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) labels.push({ label: m[1], file: f.path });
    } catch { /* skip */ }
  }
  labelIndexCache.set(key, { v, labels });
  return labels;
}

/** Whole-document count over the root file's \input/\include graph — a
 *  per-file count misleads on multi-file projects (the root is mostly
 *  preamble and \input lines). */
export async function wordCount(projectId: string, branch: string): Promise<WordCount> {
  const { key: branchKey, v } = versionKey(projectId, branch);
  // The root file is project metadata, not branch content: switching it
  // (PATCH /api/projects/:id) does not bump the version, so it is part of
  // the key — a stale hit would count the previous root's graph.
  const meta = await store.readMeta(projectId);
  const key = `${branchKey}::${meta.rootFile}`;
  const hit = wordCountCache.get(key);
  if (hit && hit.v === v) return hit.body;
  const read = (p: string): string | null => {
    if (isHiddenPath(p)) return null;
    try { return store.readFile(projectId, branch, p).toString('utf8'); } catch { return null; }
  };
  const files: Record<string, number> = {};
  let total = 0;
  for (const f of documentFiles(meta.rootFile, read)) {
    const n = latexWordCount(read(f) ?? '');
    files[f] = n;
    total += n;
  }
  const body = { rootFile: meta.rootFile, total, files };
  wordCountCache.set(key, { v, body });
  return body;
}
