import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server as HocuspocusServer } from '@hocuspocus/server';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { branchDir, readMeta } from './store.js';
import { config } from './config.js';
import { commitAll, ensureWorktree } from './gitops.js';
import { safeJoin, debouncePerKey } from './util.js';
import { AUTH_ENABLED, userFromRequest } from './auth.js';
import { canAccess } from './authz.js';
import { redisAvailable, createDedicatedClient } from './redis.js';

/**
 * Document naming: `${projectId}/${branch}/${filePath}`
 * Branch names are restricted to not contain `/`… except they can (feature/x).
 * To keep parsing unambiguous we use a `::` separator instead.
 * Doc name = `${projectId}::${branch}::${filePath}`
 */
export function docName(projectId: string, branch: string, filePath: string): string {
  return `${projectId}::${branch}::${filePath}`;
}

export function parseDocName(name: string): { projectId: string; branch: string; filePath: string } | null {
  // Split on only the first two separators: projectId and branch never contain
  // '::' (id/branch charsets exclude ':'), but a file path legitimately can, so
  // the remainder is the whole filePath rather than being rejected as 4+ parts.
  const i = name.indexOf('::');
  if (i < 0) return null;
  const j = name.indexOf('::', i + 2);
  if (j < 0) return null;
  const projectId = name.slice(0, i);
  const branch = name.slice(i + 2, j);
  const filePath = name.slice(j + 2);
  if (!projectId || !branch || !filePath) return null;
  return { projectId, branch, filePath };
}

const TEXT_KEY = 'content';

/**
 * Yjs binary snapshots (one per doc), stored OUTSIDE the git worktree so they
 * never reach git or the compiler. Reloading a doc from its snapshot preserves
 * CRDT operation identity; reseeding from plain text instead would mint fresh
 * operations that a reconnecting client's copy MERGES — duplicating the whole
 * document on every server restart/deploy. The .tex file on disk stays the
 * source of truth for git/compile; the snapshot only carries collab identity.
 */
const YJS_DIR = path.join(config.metaRoot, 'yjs');
const snapPath = (name: string) => path.join(YJS_DIR, crypto.createHash('sha1').update(name).digest('hex') + '.ybin');

function writeSnapshot(name: string, document: Y.Doc): void {
  try {
    fs.mkdirSync(YJS_DIR, { recursive: true });
    fs.writeFileSync(snapPath(name), Buffer.from(Y.encodeStateAsUpdate(document)));
  } catch (err) { console.error('[collab] snapshot write failed', (err as Error).message); }
}
function readSnapshot(name: string): Uint8Array | null {
  try { return fs.readFileSync(snapPath(name)); } catch { return null; }
}
function deleteSnapshot(name: string): void {
  try { fs.rmSync(snapPath(name), { force: true }); } catch { /* best effort */ }
}

/** Debounced auto-commit per project::branch after edits settle. */
const scheduleAutoCommit = debouncePerKey(20_000, (key: string) => {
  const [projectId, branch] = key.split('::');
  commitAll(projectId, branch, 'aldine: autosave').catch((err) => console.error('[collab] autocommit failed', err.message));
});

/** Schedule the same debounced auto-commit for non-collab writes (REST file
 *  upload / rename / reference add) so working-tree changes reach git history
 *  even when no Yjs doc is open — not just on the next manual push. */
export function scheduleCommit(projectId: string, branch: string): void {
  scheduleAutoCommit(`${projectId}::${branch}`);
}

/** Docs evicted because their file/branch was deleted — never write these back. */
const tombstoned = new Set<string>();

/** sha1 of the on-disk content per loaded doc — lets us skip redundant disk
 *  writes when a debounced store is unchanged, without a per-store read-back.
 *  Kept in sync with disk at load / refresh / evict / unload; a stale entry
 *  would silently drop a real edit, so every disk-changing path updates it. */
const lastWritten = new Map<string, string>();
const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

export function tombstone(name: string): void { tombstoned.add(name); }
export function untombstone(name: string): void { tombstoned.delete(name); }

// Monotonic per-branch content version — the invalidation signal for derived
// indexes (the /bib and /labels caches in routes.ts). Bumped by every path
// that changes branch content on disk: Yjs doc stores, REST file mutations,
// and git rewrites (merge/revert/pull → refreshBranchDocsFromDisk).
const contentVersions = new Map<string, number>();
export function bumpContentVersion(projectId: string, branch: string): void {
  const k = `${projectId}::${branch}`;
  contentVersions.set(k, (contentVersions.get(k) || 0) + 1);
}
export function contentVersion(projectId: string, branch: string): number {
  return contentVersions.get(`${projectId}::${branch}`) || 0;
}

/** Ephemeral coordination docs (e.g. the comment-change signal) are never written to disk. */
function isSignalDoc(filePath: string): boolean {
  return filePath.startsWith('.aldine/');
}

export function writeDocToDisk(name: string, document: Y.Doc): void {
  if (tombstoned.has(name)) return;
  const parsed = parseDocName(name);
  if (!parsed) return;
  const { projectId, branch, filePath } = parsed;
  if (isSignalDoc(filePath)) return;
  const dir = branchDir(projectId, branch);
  if (!fs.existsSync(dir)) return; // branch was deleted while doc loaded
  const abs = safeJoin(dir, filePath);
  const text = document.getText(TEXT_KEY).toString();
  // Keep the collab snapshot in step with the live doc on every store (small,
  // and independent of the .tex-write skip below so reconnect identity is
  // always current even when the rendered text didn't change).
  writeSnapshot(name, document);
  // Skip the .tex write when the content is identical to what's on disk (keeps
  // latexmk incremental builds effective) — compared in memory, no disk read.
  const hash = sha1(text);
  if (lastWritten.get(name) === hash) return;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  lastWritten.set(name, hash);
  bumpContentVersion(projectId, branch);
  scheduleAutoCommit(`${projectId}::${branch}`);
}

// Defining onAuthenticate makes Hocuspocus require a token from every client,
// so only include it when auth is actually enabled (default is open).
const authHook = AUTH_ENABLED ? {
  async onAuthenticate({ documentName, requestHeaders }: { documentName: string; requestHeaders: Record<string, string | string[] | undefined> }) {
    const parsed = parseDocName(documentName);
    if (!parsed) throw new Error('invalid document');
    const user = await userFromRequest(requestHeaders.cookie as string | undefined);
    if (!user) throw new Error('Not authenticated');
    let meta;
    try { meta = await readMeta(parsed.projectId); } catch { throw new Error('project not found'); }
    if (!canAccess(meta, user)) throw new Error('Access denied');
  },
} : {};

// Multi-node collaboration (scaling wall #2): with REDIS_URL, the Redis extension
// syncs awareness across nodes and hands a document off cleanly on failover.
// IMPORTANT: run the load balancer with sticky routing so each document lives on
// one node at a time (route by the project id in the /collab doc name). Without
// stickiness two nodes would each seed the same doc from disk and duplicate it.
// See docs/SCALING.md.
const collabExtensions: unknown[] = [];
if (process.env.REDIS_URL) {
  try {
    const { Redis } = await import('@hocuspocus/extension-redis');
    if (!redisAvailable()) throw new Error('ioredis missing');
    // createClient lets redis.ts own ALL connection semantics (rediss:// TLS,
    // ACL username, /db — ioredis parses the raw URL natively; a past hand-parse
    // here silently dropped them, breaking managed Redis like Elasticache).
    collabExtensions.push(new Redis({ createClient: () => createDedicatedClient('hocuspocus') } as never));
    console.log('[aldine] collab: redis sync across nodes (requires sticky routing)');
  } catch {
    console.warn('[aldine] REDIS_URL set but @hocuspocus/extension-redis is not installed — collab is single-node');
  }
}

/** Showcase projects (ALDINE_PROTECTED_PROJECTS) are world-readable, nobody-writable. */
export const protectedProjects = new Set(
  (process.env.ALDINE_PROTECTED_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

export const hocuspocus: Hocuspocus = HocuspocusServer.configure({
  // We handle upgrades ourselves from the Fastify HTTP server.
  quiet: true,
  debounce: 1500,
  maxDebounce: 8000,
  extensions: collabExtensions as never,
  ...authHook,
  // Protected projects connect read-only: without this, collab edits over the
  // websocket would bypass the HTTP-side write guard entirely.
  async onConnect({ documentName, connection }: { documentName: string; connection: { readOnly: boolean } }) {
    const parsed = parseDocName(documentName);
    if (parsed && protectedProjects.has(parsed.projectId)) connection.readOnly = true;
  },
  async onLoadDocument({ documentName, document }) {
    const parsed = parseDocName(documentName);
    if (!parsed) throw new Error(`invalid document name: ${documentName}`);
    const { projectId, branch, filePath } = parsed;
    if (isSignalDoc(filePath)) return document; // ephemeral coordination channel, nothing to load
    // A client whose socket was closed by evictDoc reconnects at once; while
    // the tombstone stands, the file is gone on purpose and a fresh empty doc
    // would let that client's copy write it straight back.
    if (tombstoned.has(documentName)) throw new Error('file was deleted');
    await ensureWorktree(projectId, branch);
    const text = document.getText(TEXT_KEY);
    if (text.length > 0) return document; // already has state (e.g. synced from a peer node)
    let content = '';
    try { content = fs.readFileSync(safeJoin(branchDir(projectId, branch), filePath), 'utf8'); } catch { /* new file → empty */ }

    // Prefer the Yjs snapshot (preserves operation identity → reconnect-safe).
    // Fall back to a plain-text seed only when there's no snapshot or the file
    // changed out-of-band on disk (git pull/merge/revert), where disk wins.
    const snap = readSnapshot(documentName);
    let loaded = false;
    if (snap) {
      try {
        Y.applyUpdate(document, snap);
        loaded = true;
        if (text.toString() !== content) {
          document.transact(() => { text.delete(0, text.length); if (content.length) text.insert(0, content); });
          writeSnapshot(documentName, document);
        }
      } catch {
        try { document.transact(() => text.delete(0, text.length)); } catch { /* start clean */ }
        loaded = false;
      }
    }
    if (!loaded) {
      if (content.length > 0) text.insert(0, content);
      writeSnapshot(documentName, document); // establish a snapshot for future reconnects
    }
    // Track lastWritten against disk so the first store of an unchanged doc
    // skips the .tex rewrite (no latexmk churn).
    lastWritten.set(documentName, sha1(content));
    return document;
  },
  async onStoreDocument({ documentName, document }) {
    writeDocToDisk(documentName, document);
  },
  // Reclaim the change-tracking entry when Hocuspocus unloads an idle doc, so
  // the map is bounded by live docs and a reopened doc never trusts a stale hash.
  async afterUnloadDocument({ documentName }: { documentName: string }) {
    lastWritten.delete(documentName);
  },
});

/** Flush ALL loaded docs to disk (graceful shutdown); returns the distinct
 *  project/branch pairs that had open docs, so the caller commits only those. */
export function flushAllDocs(): { projectId: string; branch: string }[] {
  const dirty = new Map<string, { projectId: string; branch: string }>();
  hocuspocus.documents.forEach((doc: Y.Doc, name: string) => {
    writeDocToDisk(name, doc);
    const p = parseDocName(name);
    if (p) dirty.set(`${p.projectId}::${p.branch}`, { projectId: p.projectId, branch: p.branch });
  });
  return [...dirty.values()];
}

/**
 * Evict a doc so its pending final store won't resurrect a deleted/renamed file.
 * Removes it from Hocuspocus's registry after tombstoning.
 */
export function evictDoc(projectId: string, branch: string, filePath: string): void {
  const name = docName(projectId, branch, filePath);
  tombstone(name);
  lastWritten.delete(name);
  deleteSnapshot(name); // file deleted/renamed → drop its collab snapshot so a re-create starts clean
  const doc = hocuspocus.documents.get(name) as (Y.Doc & { destroy?: () => void }) | undefined;
  if (doc) {
    // Clients still on this doc would keep editing a file that no longer
    // exists and write it back on their next store; drop them first.
    try { hocuspocus.closeConnections(name); } catch { /* no connections */ }
    hocuspocus.documents.delete(name);
    try { doc.destroy?.(); } catch { /* noop */ }
  }
  // allow a later re-create of the same path to persist again
  setTimeout(() => untombstone(name), 5000);
  bumpFilesSignal(projectId, branch);
}

/**
 * Tell every client on a branch that its file list changed. The tree is a
 * REST listing; this bumps a shared counter in an ephemeral collab doc (the
 * same trick the review comments use) so open editors refetch instead of
 * showing a snapshot from page load. No client on the branch, nothing to do.
 */
export const FILES_SIGNAL = '.aldine/files-signal';
export function bumpFilesSignal(projectId: string, branch: string): void {
  const doc = hocuspocus.documents.get(docName(projectId, branch, FILES_SIGNAL)) as Y.Doc | undefined;
  if (!doc) return;
  try { doc.getMap<number>('signal').set('v', Date.now()); } catch { /* best effort */ }
}


/**
 * Drop every live collab socket on a project, forcing clients to reconnect and
 * re-authenticate. Access is only checked in onAuthenticate (connect time), so
 * without this a user whose access was just revoked keeps editing the shared
 * document — and those edits keep being written to disk and auto-committed.
 * The close code is a plain reset, so the provider reconnects on its own:
 * still-allowed users resume, revoked ones are refused by the auth hook.
 */
export function closeProjectConnections(projectId: string): void {
  hocuspocus.documents.forEach((_doc: Y.Doc, name: string) => {
    const parsed = parseDocName(name);
    if (parsed && parsed.projectId === projectId) hocuspocus.closeConnections(name);
  });
}

/**
 * Apply a suggestion replacement to the LIVE collab doc when one is open.
 * A disk read-modify-write would rebuild the doc from a stale snapshot and
 * silently revert every collaborator's unflushed edits — the CRDT edit below
 * merges with concurrent typing instead. Returns 'no-doc' when the file has
 * no loaded doc (caller falls back to the disk path, which is then safe).
 */
export function applySuggestionToDoc(
  projectId: string,
  branch: string,
  filePath: string,
  anchor: { from: number; to: number; quote: string },
  replacement: string,
): 'applied' | 'stale' | 'no-doc' {
  const name = docName(projectId, branch, filePath);
  const doc = hocuspocus.documents.get(name) as Y.Doc | undefined;
  if (!doc) return 'no-doc';
  const ytext = doc.getText(TEXT_KEY);
  const content = ytext.toString();
  let from = -1;
  let to = -1;
  if (content.slice(anchor.from, anchor.to) === anchor.quote) {
    from = anchor.from;
    to = anchor.to;
  } else if (
    anchor.quote &&
    anchor.quote.length === anchor.to - anchor.from && // an untruncated quote (see comments.ts cap)
    content.split(anchor.quote).length === 2
  ) {
    from = content.indexOf(anchor.quote);
    to = from + anchor.quote.length;
  }
  if (from < 0) return 'stale';
  doc.transact(() => {
    ytext.delete(from, to - from);
    if (replacement) ytext.insert(from, replacement);
  });
  writeDocToDisk(name, doc); // suggestion is on disk immediately, like a manual flush
  return 'applied';
}

/** Synchronously flush every loaded doc of a project+branch to disk (before compile/commit/merge). */
export function flushBranchDocs(projectId: string, branch: string): number {
  let n = 0;
  hocuspocus.documents.forEach((doc: Y.Doc & { name: string }, name: string) => {
    const parsed = parseDocName(name);
    if (parsed && parsed.projectId === projectId && parsed.branch === branch) {
      writeDocToDisk(name, doc);
      n++;
    }
  });
  return n;
}

/**
 * After git changed files on disk (merge/revert), push new content into loaded docs
 * so connected editors update in place.
 */
export function refreshBranchDocsFromDisk(projectId: string, branch: string): void {
  bumpFilesSignal(projectId, branch); // every caller just changed the branch on disk
  bumpContentVersion(projectId, branch); // git just rewrote files under this branch
  hocuspocus.documents.forEach((doc: Y.Doc & { name: string }, name: string) => {
    const parsed = parseDocName(name);
    if (!parsed || parsed.projectId !== projectId || parsed.branch !== branch) return;
    const abs = safeJoin(branchDir(projectId, branch), parsed.filePath);
    let content: string | null = null;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { content = null; }
    if (content === null) {
      // File deleted on disk (merge/reset). Drop the hash so the next store
      // re-materializes the still-open doc's content instead of wrongly skipping
      // (which would leave the editor showing content that never persists).
      lastWritten.delete(name);
      return;
    }
    const text = doc.getText(TEXT_KEY);
    lastWritten.set(name, sha1(content)); // disk now holds `content`; keep tracking in sync
    if (text.toString() === content) return;
    doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, content!);
    });
    writeSnapshot(name, doc); // the doc's ops changed → keep the reconnect snapshot current
  });
}
