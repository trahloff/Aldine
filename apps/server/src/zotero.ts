import { readMeta, writeMeta, writeFile, fileExists, ProjectMeta } from './store.js';
import { flushBranchDocs, refreshBranchDocsFromDisk } from './collab.js';
import { autoCommit, ensureWorktree } from './gitops.js';
import { paperBibFormat, type BibFormat } from './bibload.js';
import { db } from './db/index.js';

export type ZoteroLink = NonNullable<ProjectMeta['zotero']>;

/** Zotero answered 401 or 403 for the library: the key cannot read it. The
 *  status stays on the error for the log; people get the next step. */
export class ZoteroAccessError extends Error {
  constructor(readonly status: number) {
    super('This Zotero key can\'t read that library. In Zotero, give the key read access to it, then link again.');
  }
}

const API = process.env.ZOTERO_API_BASE || 'https://api.zotero.org';
const HEADERS = (key: string) => ({ 'Zotero-API-Version': '3', 'Zotero-API-Key': key });

export interface ZoteroKeyInfo { userID: number; username?: string; access: unknown }

export async function validateKey(apiKey: string): Promise<ZoteroKeyInfo> {
  const res = await fetch(`${API}/keys/current`, { headers: HEADERS(apiKey) });
  if (!res.ok) throw new Error(`Zotero rejected the key (HTTP ${res.status})`);
  const body = (await res.json()) as { userID: number; username?: string; access: unknown };
  return body;
}

export async function listGroups(apiKey: string, userId: number): Promise<Array<{ id: number; name: string }>> {
  const res = await fetch(`${API}/users/${userId}/groups`, { headers: HEADERS(apiKey) });
  if (!res.ok) return [];
  const body = (await res.json()) as Array<{ id: number; data: { name: string } }>;
  return body.map((g) => ({ id: g.id, name: g.data.name }));
}

export interface ZoteroCollection { key: string; name: string; parent: string | false }

/** "CRDT Research / Sync": a collection under the ones it sits in, so two
 *  subcollections of the same name tell apart. A loop or a missing parent
 *  ends the path. */
export function collectionPath(collections: ZoteroCollection[], key: string): string | undefined {
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let c = byKey.get(key); c && !seen.has(c.key); c = c.parent ? byKey.get(c.parent) : undefined) {
    seen.add(c.key);
    names.unshift(c.name);
  }
  return names.length ? names.join(' / ') : undefined;
}

export async function listCollections(apiKey: string, libraryPrefix: string): Promise<ZoteroCollection[]> {
  const out: ZoteroCollection[] = [];
  let start = 0;
  for (;;) {
    const res = await fetch(`${API}/${libraryPrefix}/collections?limit=100&start=${start}`, { headers: HEADERS(apiKey) });
    if (!res.ok) throw new Error(`Zotero collections failed (HTTP ${res.status})`);
    const page = (await res.json()) as Array<{ key: string; data: { name: string; parentCollection: string | false } }>;
    out.push(...page.map((c) => ({ key: c.key, name: c.data.name, parent: c.data.parentCollection })));
    if (page.length < 100) break;
    start += 100;
  }
  return out;
}

/** Fetch the full library/collection as biblatex or BibTeX, paginated. Returns { bib, version }. */
export async function fetchBib(apiKey: string, libraryPrefix: string, collectionKey?: string, sinceVersion?: number, format: BibFormat = 'biblatex'): Promise<{ bib: string; version: number } | 'unchanged'> {
  const base = collectionKey
    ? `${API}/${libraryPrefix}/collections/${collectionKey}/items/top`
    : `${API}/${libraryPrefix}/items/top`;

  // Cheap change check first
  if (sinceVersion !== undefined) {
    const probe = await fetch(`${base}?format=${format}&limit=1`, {
      headers: { ...HEADERS(apiKey), 'If-Modified-Since-Version': String(sinceVersion) },
    });
    if (probe.status === 304) return 'unchanged';
  }

  let bib = '';
  let version = 0;
  let start = 0;
  for (;;) {
    const res = await fetch(`${base}?format=${format}&itemType=-attachment&limit=100&start=${start}`, { headers: HEADERS(apiKey) });
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') || 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ZoteroAccessError(res.status);
    if (!res.ok) throw new Error(`Zotero export failed (HTTP ${res.status})`);
    version = Number(res.headers.get('Last-Modified-Version') || version);
    const total = Number(res.headers.get('Total-Results') || 0);
    bib += (await res.text()) + '\n';
    start += 100;
    if (start >= total) break;
    const backoff = Number(res.headers.get('Backoff') || 0);
    if (backoff) await new Promise((r) => setTimeout(r, backoff * 1000));
  }
  return { bib: bib.trim() + '\n', version };
}

/** The names the linked view shows for a group library and a collection.
 *  Best effort: a lookup that fails leaves the name out, never the link. */
export async function linkNames(apiKey: string, userId: number, libraryPrefix: string, collectionKey?: string): Promise<{ libraryName?: string; collectionName?: string }> {
  const out: { libraryName?: string; collectionName?: string } = {};
  if (libraryPrefix.startsWith('groups/')) {
    out.libraryName = (await listGroups(apiKey, userId).catch(() => [])).find((g) => `groups/${g.id}` === libraryPrefix)?.name;
  }
  if (collectionKey) {
    out.collectionName = collectionPath(await listCollections(apiKey, libraryPrefix).catch(() => []), collectionKey);
  }
  return out;
}

export interface SyncResult { synced: boolean; unchanged?: boolean; bibFile?: string; itemCount?: number; format?: BibFormat; fresh?: boolean }

/** True when the link was synced less than `seconds` ago and its export still fits the paper. */
export function syncedRecently(z: ZoteroLink, seconds: number, format: BibFormat): boolean {
  const at = Date.parse(z.lastSyncedAt || '');
  return !Number.isNaN(at) && Date.now() - at < seconds * 1000 && (z.format ?? 'biblatex') === format;
}

/**
 * Sync the linked Zotero library into <bibFile> on the given branch. With
 * `link`, syncs that link instead of the stored one and stores it only once
 * the library has been written, so a library that cannot be exported never
 * becomes the project's link.
 */
export async function syncProject(projectId: string, branch = 'main', force = false, link?: ZoteroLink, olderThan?: number): Promise<SyncResult> {
  const meta = await readMeta(projectId);
  const z = link ?? meta.zotero;
  if (!z) throw new Error('project has no Zotero link');
  await ensureWorktree(projectId, branch);
  // BibTeX styles read `journal` and `year`, not biblatex's `journaltitle`
  // and `date`: the export follows what the paper uses, and a paper that
  // switched gets the library again in full.
  const format = paperBibFormat(projectId, branch);
  if (olderThan !== undefined && !force && syncedRecently(z, olderThan, format) && fileExists(projectId, branch, z.bibFile)) {
    return { synced: false, fresh: true, format };
  }
  // The version cursor is the project's, not the branch's: a branch without
  // the file needs the whole library whatever the cursor says.
  const full = force || !fileExists(projectId, branch, z.bibFile) || (z.format ?? 'biblatex') !== format;
  const result = await fetchBib(z.apiKey, z.libraryPrefix, z.collectionKey, full ? undefined : z.lastVersion, format);
  if (result === 'unchanged') {
    // Nothing new: the check still counts as a sync, so the next open does not ask again at once.
    if (meta.zotero && !link) await writeMeta({ ...meta, zotero: { ...meta.zotero, lastSyncedAt: new Date().toISOString() } });
    return { synced: false, unchanged: true, format };
  }
  const header = `% Auto-generated from Zotero (${z.libraryPrefix}${z.collectionKey ? ', collection ' + z.collectionKey : ''})\n% Synced ${new Date().toISOString()} — edits will be overwritten on next sync.\n\n`;
  // The refresh resets every open doc that differs from its file: what was
  // typed but not yet saved must be on disk first.
  flushBranchDocs(projectId, branch);
  writeFile(projectId, branch, z.bibFile, header + result.bib);
  refreshBranchDocsFromDisk(projectId, branch, [z.bibFile]);
  const updated: ProjectMeta = { ...meta, zotero: { ...z, lastVersion: result.version, lastSyncedAt: new Date().toISOString(), format } };
  await writeMeta(updated);
  // autoCommit, not commitAll: a whole-tree sweep would sign an agent edit
  // pending in the autosave window as the sync, with no Claude commit to review.
  await autoCommit(projectId, branch, `aldine: sync Zotero library into ${z.bibFile}`).catch(() => {});
  const itemCount = (result.bib.match(/^@/gm) || []).length;
  return { synced: true, bibFile: z.bibFile, itemCount, format };
}

/** Search items (for insert-citation UI). Returns CSL-JSON-ish entries. */
export async function searchItems(apiKey: string, libraryPrefix: string, q: string): Promise<unknown[]> {
  const res = await fetch(`${API}/${libraryPrefix}/items/top?q=${encodeURIComponent(q)}&qmode=titleCreatorYear&format=csljson&limit=20&itemType=-attachment`, { headers: HEADERS(apiKey) });
  if (!res.ok) throw new Error(`Zotero search failed (HTTP ${res.status})`);
  const body = (await res.json()) as { items?: unknown[] };
  return body.items || [];
}

/**
 * The Zotero key an account keeps for its next link, with the other
 * per-account secrets (the datastore, never the compiler-visible projects
 * dir). It goes to Zotero and into a project's link, never back to a
 * browser. Without accounts the one implicit user ('local') keeps it.
 */
export interface SavedKey { apiKey: string; userID: number; username?: string }

export async function savedKey(accountId: string): Promise<SavedKey | null> {
  const c = await db().getConnection(accountId, 'zotero');
  return c && typeof c.apiKey === 'string' && typeof c.userID === 'number' ? { apiKey: c.apiKey, userID: c.userID, username: typeof c.username === 'string' ? c.username : undefined } : null;
}

export function saveKey(accountId: string, key: SavedKey): Promise<void> {
  return db().setConnection(accountId, 'zotero', { apiKey: key.apiKey, userID: key.userID, ...(key.username ? { username: key.username } : {}) });
}

export function forgetKey(accountId: string): Promise<void> {
  return db().deleteConnection(accountId, 'zotero');
}
