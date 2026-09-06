import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server as HocuspocusServer } from '@hocuspocus/server';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { branchDir, readMeta } from './store.js';
import { config } from './config.js';
import { autoCommit, ensureWorktree, registerAttributedPaths, pendingAttributionKeys } from './gitops.js';
import { safeJoin, debouncePerKey } from './util.js';
import { AUTH_ENABLED, TOKEN_PREFIX, userFromRequest, userFromToken } from './auth.js';
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

/** Overridable so tests can exercise the debounced commit without 20 s waits. */
const AUTOCOMMIT_DEBOUNCE_MS = Number(process.env.ALDINE_AUTOCOMMIT_MS || '') || 20_000;

/** Debounced auto-commit per project::branch after edits settle. One debounce
 *  window with mixed human and agent work must never co-mingle the two into
 *  one wrongly-attributed commit (UX.md: git is the audit ledger;
 *  HistoryPanel/session review key on the author string) — the ordering rule
 *  (attributed paths first under their author + intent, then the anonymous
 *  sweep) lives in gitops.autoCommit, which takes the attribution only while
 *  it holds the repo lock. The attribution lives in gitops, OUTSIDE the
 *  debounce args — the debounce is last-writer-wins, and a human keystroke
 *  scheduling anonymously after an agent write must not erase the agent's
 *  attribution (or vice versa); an explicit whole-tree commit in the window
 *  consumes it. */
const scheduleAutoCommit = debouncePerKey<[]>(AUTOCOMMIT_DEBOUNCE_MS, (key) => {
  const [projectId, branch] = key.split('::');
  void autoCommit(projectId, branch).catch((err) => console.error('[collab] autocommit failed', err.message));
});

/** Schedule the same debounced auto-commit for non-collab writes (REST file
 *  upload / rename / reference add, MCP tools) so working-tree changes reach
 *  git history even when no Yjs doc is open — not just on the next manual
 *  push. Agent (MCP) callers pass their stated intent + author "Claude" +
 *  the touched paths, which commit separately from the anonymous sweep.
 *  Agent (MCP) callers invoke this inside gitops.withRepoLock, in the same
 *  synchronous run as their disk write, after checkpointPathsHeld — the lock
 *  is what keeps an in-flight autosave from staging the write before it is
 *  attributed. */
export function scheduleCommit(projectId: string, branch: string, message?: string, author?: string, paths?: string[]): void {
  if (message && author && paths?.length) registerAttributedPaths(projectId, branch, message, author, paths);
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

// Per-branch change log behind the content version: the version at which each
// path last changed on disk, plus a watermark for tree-wide rewrites (git
// merge/revert/pull/reset), after which every path — listed or not — counts
// as changed. Conflict checks compare one path's version with the caller's
// base, so a write to one file never conflicts with a read of another.
// Per process (like the version itself): docs/SCALING.md sticky routing.
//
// Invariants the tests pin:
//  I1 contentVersion(b) is monotonic per process and bumps on every disk
//     change of branch content (indexes.ts, compile results and listings key
//     on it unchanged).
//  I2 fileVersion(P) <= contentVersion(b); every entry in `paths` is > `tree`
//     (paths is cleared whenever tree moves), so `paths.get(P) ?? tree` is
//     the max of the two.
//  I3 A write of P with base V is refused iff fileVersion(P) > V (P changed
//     after the read) or V > contentVersion(b) (V is from another process
//     lifetime or node — unknowable, so refused rather than trusted).
//  I4 A path nobody wrote since the last tree-wide mark has fileVersion =
//     tree; a brand-new path therefore conflicts only with a git-level
//     rewrite after V.
//  I5 writeDocToDisk marks its path only when the bytes actually change, so
//     pending typing in the SAME file still conflicts and pending typing in
//     another file does not.
interface BranchChanges { version: number; paths: Map<string, number>; tree: number }
const branchChanges = new Map<string, BranchChanges>();
const changesKey = (projectId: string, branch: string) => `${projectId}::${branch}`;
function changesOf(projectId: string, branch: string): BranchChanges {
  const k = changesKey(projectId, branch);
  let c = branchChanges.get(k);
  if (!c) { c = { version: 0, paths: new Map(), tree: 0 }; branchChanges.set(k, c); }
  return c;
}
// "./main.tex" and "main.tex" are one file; a key mismatch would miss a conflict.
const pathKey = (p: string) => path.posix.normalize(p);

export function contentVersion(projectId: string, branch: string): number {
  return branchChanges.get(changesKey(projectId, branch))?.version ?? 0;
}
/** Bump the branch version once and record it as the last-change version of each path. */
export function markPathsChanged(projectId: string, branch: string, paths: string[]): number {
  const c = changesOf(projectId, branch);
  c.version += 1;
  for (const p of paths) c.paths.set(pathKey(p), c.version);
  return c.version;
}
/** Bump the branch version and count every path — known or not — as changed at it. */
export function markTreeChanged(projectId: string, branch: string): number {
  const c = changesOf(projectId, branch);
  c.version += 1;
  c.tree = c.version;
  c.paths.clear();
  return c.version;
}
/** The branch version at which `filePath` last changed (0 = untouched this process lifetime). */
export function fileVersion(projectId: string, branch: string, filePath: string): number {
  const c = branchChanges.get(changesKey(projectId, branch));
  if (!c) return 0;
  return c.paths.get(pathKey(filePath)) ?? c.tree;
}
export interface VersionConflict { error: 'version_conflict'; currentVersion: number; fileVersion: number }
/** null when a write of `filePath` at `baseVersion` is safe; else the conflict body every caller returns verbatim. */
export function versionConflict(projectId: string, branch: string, filePath: string, baseVersion: number): VersionConflict | null {
  const currentVersion = contentVersion(projectId, branch);
  const fv = fileVersion(projectId, branch, filePath);
  if (fv <= baseVersion && baseVersion <= currentVersion) return null;
  return { error: 'version_conflict', currentVersion, fileVersion: fv };
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
  markPathsChanged(projectId, branch, [filePath]);
  scheduleAutoCommit(`${projectId}::${branch}`);
}

// Defining onAuthenticate makes Hocuspocus require a token from every client,
// so only include it when auth is actually enabled (default is open).
const authHook = AUTH_ENABLED ? {
  async onAuthenticate({ documentName, requestHeaders }: { documentName: string; requestHeaders: Record<string, string | string[] | undefined> }) {
    const parsed = parseDocName(documentName);
    if (!parsed) throw new Error('invalid document');
    // Bearer tokens (agents) are accepted alongside session cookies, with the
    // same project scoping the HTTP preHandler enforces. A presented bearer is
    // authoritative (mirrors the HTTP onRequest hook): a revoked/expired/
    // malformed token must refuse the connection, not silently borrow the
    // cookie session's identity — which would also drop the project scope.
    const header = requestHeaders.authorization;
    let user: Awaited<ReturnType<typeof userFromRequest>>;
    if (typeof header === 'string' && header.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
      const bearer = await userFromToken(header);
      if (!bearer) throw new Error('Not authenticated');
      if (bearer.tokenScope.projectIds && !bearer.tokenScope.projectIds.includes(parsed.projectId)) throw new Error('Access denied');
      user = bearer.user;
    } else {
      user = await userFromRequest(requestHeaders.cookie as string | undefined);
    }
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

/** Everything the shutdown flush must commit: the branches with open docs
 *  (flushed to disk here) plus the branches holding agent work that no doc
 *  carries — an MCP client with no browser tab open writes straight to disk,
 *  and only the in-memory ledger knows the delta is Claude's. Not covered: a
 *  kill -9 inside the ~20 s debounce, which the next autosave sweeps as an
 *  anonymous autosave (docs/AGENT_API.md). */
export function shutdownFlushSet(): { projectId: string; branch: string }[] {
  const set = new Map<string, { projectId: string; branch: string }>();
  for (const d of [...flushAllDocs(), ...pendingAttributionKeys()]) set.set(`${d.projectId}::${d.branch}`, d);
  return [...set.values()];
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
  origin?: unknown,
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
  }, origin);
  writeDocToDisk(name, doc); // suggestion is on disk immediately, like a manual flush
  return 'applied';
}

/** Live content of a loaded collab doc, or null when no doc is open — the
 *  reader edit_file uses to choose CRDT-apply over disk-splice. The returned
 *  string is only trustworthy for offsets within the same synchronous tick
 *  (any await lets human keystrokes land in between). */
export function openDocContent(projectId: string, branch: string, filePath: string): string | null {
  const doc = hocuspocus.documents.get(docName(projectId, branch, filePath)) as Y.Doc | undefined;
  return doc ? doc.getText(TEXT_KEY).toString() : null;
}

/** Yjs transaction origin stamped on agent (MCP) edits. Origins do not cross
 *  the wire — remote clients see the provider as origin — so this serves
 *  server-side attribution; the web fade-highlight needs another signal. */
export const AGENT_ORIGIN = 'aldine-agent';

/** Reserved agent awareness identity (UX.md): the violet is kept OUT of the
 *  human color palette — if a human can get agent-violet, the semantics
 *  collapse. Field shape mirrors what CodePane.tsx sets for humans. */
export const AGENT_AWARENESS_USER = { name: 'Claude', color: '#a78bfa', colorLight: '#a78bfa55', isAgent: true } as const;

/** Overridable so the session-review e2e can see the idle toast without a 60 s wait. */
const AGENT_PRESENCE_TTL_MS = Number(process.env.ALDINE_AGENT_PRESENCE_TTL_MS || '') || 60_000;
const agentPresenceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Show the agent in a doc's presence while a tool session is active. MCP
 * writes run in-process with no Hocuspocus connection, so presence rides the
 * loaded doc's own awareness instance (the server relays its local state to
 * clients); no loaded doc → no-op. Expires ~60 s after the last tool call so
 * an idle agent doesn't permanently haunt the presence chip.
 */
export function markAgentPresence(projectId: string, branch: string, filePath: string): void {
  const name = docName(projectId, branch, filePath);
  type AwarenessDoc = { awareness?: { setLocalState(s: unknown): void } };
  const doc = hocuspocus.documents.get(name) as AwarenessDoc | undefined;
  if (!doc?.awareness) return;
  // setLocalState, not setLocalStateField: Hocuspocus nulls the server-side
  // local state at doc creation, and y-protocols' setLocalStateField is a
  // silent no-op on a null state — the agent would never appear.
  doc.awareness.setLocalState({ user: AGENT_AWARENESS_USER });
  const prev = agentPresenceTimers.get(name);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    agentPresenceTimers.delete(name);
    const d = hocuspocus.documents.get(name) as AwarenessDoc | undefined;
    try { d?.awareness?.setLocalState(null); } catch { /* doc unloaded meanwhile */ }
  }, AGENT_PRESENCE_TTL_MS);
  timer.unref?.();
  agentPresenceTimers.set(name, timer);
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
 * After files changed on disk behind the docs (a REST/tool write, git
 * merge/revert/pull), push new content into loaded docs so connected editors
 * update in place. `changed` = the paths the caller rewrote; omitted means
 * git rewrote the tree and every path counts as changed — the conservative
 * default, so a caller that forgets its paths gets spurious conflicts, never
 * missed ones.
 */
export function refreshBranchDocsFromDisk(projectId: string, branch: string, changed?: string[]): void {
  bumpFilesSignal(projectId, branch); // every caller just changed the branch on disk
  if (changed) markPathsChanged(projectId, branch, changed);
  else markTreeChanged(projectId, branch);
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
