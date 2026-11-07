import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './store.js';
import * as gitops from './gitops.js';
import { flushBranchDocs, onAutoCommit, refreshBranchDocsFromDisk } from './collab.js';

/**
 * Before-images for the undo of an action that made no commit: a Replace all
 * or a file delete in a project that commits by hand, where no revert can
 * take it back. Each action keeps what its files held before and after,
 * under META_DIR (never in the repository, never committed). An image is
 * good until it is used, until a commit lands on its branch (the head moves),
 * or for IMAGE_TTL_MS.
 */

export const IMAGE_TTL_MS = 24 * 60 * 60_000;
/** Past this many bytes of before-images an action gets no undo. */
const IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/** `after` null: the action removed the file. `before` null: it created it. */
export interface ImageFile { path: string; before: Buffer | null; after: Buffer | null }

interface Stored { branch: string; head: string; at: number; files: Array<{ path: string; before: string | null; after: string | null }> }

// beside the meta dir, not in it: nothing that scans project meta sees these
const dirOf = (projectId: string) => path.join(config.metaRoot, 'undo', projectId);
const fileOf = (projectId: string, token: string) => path.join(dirOf(projectId), `${token}.json`);

function readStored(projectId: string, token: string): Stored | null {
  try { return JSON.parse(fs.readFileSync(fileOf(projectId, token), 'utf8')) as Stored; } catch { return null; }
}

function drop(projectId: string, token: string): void {
  fs.rmSync(fileOf(projectId, token), { force: true });
}

/** Removes the images no longer usable: expired, or a commit landed on their branch since. */
export async function pruneImages(projectId: string, now = Date.now()): Promise<void> {
  let names: string[];
  try { names = fs.readdirSync(dirOf(projectId)); } catch { return; }
  const heads = new Map<string, string>();
  for (const name of names) {
    const token = name.replace(/\.json$/, '');
    const s = readStored(projectId, token);
    if (!s) { drop(projectId, token); continue; }
    if (!heads.has(s.branch)) heads.set(s.branch, await gitops.branchHead(projectId, s.branch));
    if (now - s.at > IMAGE_TTL_MS || heads.get(s.branch) !== s.head) drop(projectId, token);
  }
  try { fs.rmdirSync(dirOf(projectId)); } catch { /* not empty */ }
}

onAutoCommit((projectId) => { void pruneImages(projectId).catch(() => {}); });

/** Keeps the images of one action; null when they are too large to keep. */
export async function saveImage(projectId: string, branch: string, files: ImageFile[], now = Date.now()): Promise<string | null> {
  if (!files.length) return null;
  const bytes = files.reduce((n, f) => n + (f.before?.length ?? 0) + (f.after?.length ?? 0), 0);
  if (bytes > IMAGE_MAX_BYTES) return null;
  await pruneImages(projectId, now).catch(() => {});
  const token = crypto.randomBytes(16).toString('hex');
  const stored: Stored = {
    branch,
    head: await gitops.branchHead(projectId, branch),
    at: now,
    files: files.map((f) => ({ path: f.path, before: f.before?.toString('base64') ?? null, after: f.after?.toString('base64') ?? null })),
  };
  fs.mkdirSync(dirOf(projectId), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fileOf(projectId, token), JSON.stringify(stored), { mode: 0o600 });
  return token;
}

export type RestoreResult = { restored: string[]; skipped: string[] } | { gone: 'unknown' | 'expired' | 'committed' };

/**
 * Puts back each file that still holds what the action left in it; a file
 * changed again since is left alone and named in `skipped`. Open documents
 * follow through refreshBranchDocsFromDisk. The image is used up either way.
 */
export async function restoreImage(projectId: string, branch: string, token: string, now = Date.now()): Promise<RestoreResult> {
  if (!/^[0-9a-f]{32}$/.test(token)) return { gone: 'unknown' };
  return gitops.withRepoLock(projectId, async (): Promise<RestoreResult> => {
    const s = readStored(projectId, token);
    if (!s || s.branch !== branch) return { gone: 'unknown' };
    drop(projectId, token);
    if (now - s.at > IMAGE_TTL_MS) return { gone: 'expired' };
    if ((await gitops.branchHead(projectId, branch)) !== s.head) return { gone: 'committed' };
    // what was typed a moment ago counts as a change since the action
    flushBranchDocs(projectId, branch);
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const f of s.files) {
      const after = f.after === null ? null : Buffer.from(f.after, 'base64');
      let cur: Buffer | null = null;
      try { cur = store.fileExists(projectId, branch, f.path) ? store.readFile(projectId, branch, f.path) : null; } catch { cur = null; }
      const same = after === null ? cur === null : cur !== null && cur.equals(after);
      if (!same) { skipped.push(f.path); continue; }
      if (f.before === null) store.deleteFile(projectId, branch, f.path);
      else store.writeFile(projectId, branch, f.path, Buffer.from(f.before, 'base64'));
      restored.push(f.path);
    }
    if (restored.length) refreshBranchDocsFromDisk(projectId, branch, restored);
    return { restored, skipped };
  });
}
