import { db } from './db/index.js';
import type { CompileMark, LastEdit, ProjectActivity } from './db/types.js';
import { AGENT_COMMIT_AUTHOR, newestBranchTip } from './gitops.js';

/**
 * What the project list shows about each project's work: the last change to
 * its files and the last typeset of each branch. Recorded where the change
 * happens (the collab layer for typing, the routes and tools for the rest),
 * held here, and written to the datastore at most once per project per
 * autosave window, never per keystroke. Reads overlay what this process
 * recorded on what is stored, so the list is current before the write.
 * Per process, like the autosave debounce itself (docs/SCALING.md).
 */

/** Who changed a project's files: an account, the agent, or nobody known (null). */
export interface Editor { id: string | null; name: string | null }

/** Agent writes, named as History names them. */
export const AGENT_EDITOR: Editor = { id: null, name: AGENT_COMMIT_AUTHOR };

/** The account behind a request or a collab connection; null without accounts. */
export function editorOf(user: { id: string; name?: string | null; email?: string | null } | null | undefined): Editor | null {
  return user ? { id: user.id, name: user.name || user.email || null } : null;
}

/** The autosave debounce (collab.ts): the store sees at most one write per project per window. */
const FLUSH_MS = Number(process.env.ALDINE_AUTOCOMMIT_MS || '') || 20_000;

interface Known { lastEdit: LastEdit | null; compile: Map<string, CompileMark | null> }
/** The newest values this process recorded, persisted or not. */
const known = new Map<string, Known>();
const dirty = new Map<string, { lastEdit: boolean; branches: Set<string>; timer: NodeJS.Timeout }>();

let lastStamp = 0;
/** Strictly increasing, so of two edits in one millisecond the later still wins the store's newer-only write. */
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

function knownOf(id: string): Known {
  let k = known.get(id);
  if (!k) { k = { lastEdit: null, compile: new Map() }; known.set(id, k); }
  return k;
}

function markDirty(id: string, what: { lastEdit?: boolean; branch?: string }): void {
  let d = dirty.get(id);
  if (!d) {
    const timer = setTimeout(() => { void flushProject(id); }, FLUSH_MS);
    timer.unref?.();
    d = { lastEdit: false, branches: new Set(), timer };
    dirty.set(id, d);
  }
  if (what.lastEdit) d.lastEdit = true;
  if (what.branch !== undefined) d.branches.add(what.branch);
}

/** A change to the files of `branch`. Cheap: called on every collab update. */
export function noteEdit(projectId: string, branch: string, by: Editor | null): void {
  knownOf(projectId).lastEdit = { at: stamp(), byId: by?.id ?? null, byName: by?.name ?? null, branch };
  markDirty(projectId, { lastEdit: true });
}

/** A finished typeset of `branch`. */
export function noteCompile(projectId: string, branch: string, result: { ok: boolean; errors: Array<{ type: string }> }): void {
  const mark: CompileMark = { status: result.ok ? 'ok' : 'error', errors: result.errors.filter((e) => e.type === 'error').length, at: stamp() };
  knownOf(projectId).compile.set(branch, mark);
  markDirty(projectId, { branch });
}

/** The branch was deleted: a branch recreated under its name has no typeset yet. */
export function forgetBranch(projectId: string, branch: string): void {
  knownOf(projectId).compile.set(branch, null);
  markDirty(projectId, { branch });
}

async function flushProject(id: string): Promise<void> {
  const d = dirty.get(id);
  if (!d) return;
  clearTimeout(d.timer);
  dirty.delete(id);
  const k = known.get(id);
  if (!k) return;
  try {
    // A project purged inside the window leaves nothing to record.
    if (!(await db().readMeta(id))) return;
    if (d.lastEdit && k.lastEdit) await db().setLastEdit(id, k.lastEdit);
    for (const b of d.branches) {
      const mark = k.compile.get(b) ?? null;
      await db().setCompileMark(id, b, mark);
      // A stored forget needs no overlay, and a kept null would hide typesets
      // other nodes record for a branch recreated under the name.
      if (mark === null && k.compile.get(b) === null) k.compile.delete(b);
    }
  } catch (err) {
    console.error(`[activity] could not record activity of ${id}, retrying:`, (err as Error).message);
    if (d.lastEdit) markDirty(id, { lastEdit: true });
    for (const b of d.branches) markDirty(id, { branch: b });
  }
}

/** Write everything recorded and not yet stored (shutdown, tests). */
export async function flushActivity(): Promise<void> {
  await Promise.all([...dirty.keys()].map(flushProject));
}

/** Every project's activity, keyed by id: the store's, with this process's newer values on top. */
export async function activitySnapshot(): Promise<Map<string, ProjectActivity>> {
  const out = new Map((await db().listProjectActivity()).map((r) => [r.projectId, r]));
  for (const [id, k] of known) {
    const row = out.get(id) ?? { projectId: id, lastEdit: null, compile: {} };
    if (k.lastEdit && (!row.lastEdit || row.lastEdit.at < k.lastEdit.at)) row.lastEdit = k.lastEdit;
    for (const [b, mark] of k.compile) {
      if (!mark) delete row.compile[b];
      else if (!row.compile[b] || row.compile[b].at < mark.at) row.compile[b] = mark;
    }
    out.set(id, row);
  }
  return out;
}

// ---- backfill: projects whose files last changed before any of this was recorded ----
// The newest branch tip's commit time and branch, with nobody named: autosave
// commits are anonymous, so git cannot say who typed. One git call each, in
// the background and two at a time, so a long list never waits for them.
const BACKFILL_CONCURRENCY = 2;
const backfillSeen = new Set<string>();
const backfillQueue: string[] = [];
let backfillActive = 0;
let backfillWaiters: Array<() => void> = [];

export function backfillLastEdits(ids: string[]): void {
  for (const id of ids) {
    if (backfillSeen.has(id)) continue;
    backfillSeen.add(id);
    backfillQueue.push(id);
  }
  pumpBackfill();
}

function pumpBackfill(): void {
  while (backfillActive < BACKFILL_CONCURRENCY && backfillQueue.length) {
    const id = backfillQueue.shift()!;
    backfillActive++;
    backfillOne(id)
      .catch((err) => console.warn(`[activity] no last edit from the history of ${id}:`, (err as Error).message))
      .finally(() => { backfillActive--; pumpBackfill(); });
  }
  if (!backfillActive && !backfillQueue.length) {
    const waiters = backfillWaiters;
    backfillWaiters = [];
    void writeBackfill().then(() => { for (const w of waiters) w(); });
  }
}

// Stored in batches: on the JSON store every write rewrites the one file that
// holds all projects.
const BACKFILL_BATCH = 200;
let backfillPending: Array<{ projectId: string; lastEdit: LastEdit }> = [];
let backfillWriting: Promise<void> = Promise.resolve();

function writeBackfill(): Promise<void> {
  const batch = backfillPending;
  backfillPending = [];
  if (batch.length) {
    backfillWriting = backfillWriting
      .then(() => db().setLastEdits(batch))
      .catch((err) => console.warn('[activity] storing last edits from history failed:', (err as Error).message));
  }
  return backfillWriting;
}

async function backfillOne(id: string): Promise<void> {
  const tip = await newestBranchTip(id);
  // An edit this process recorded is newer and names its author.
  if (!tip || known.get(id)?.lastEdit) return;
  backfillPending.push({ projectId: id, lastEdit: { at: tip.at, byId: null, byName: null, branch: tip.branch } });
  if (backfillPending.length >= BACKFILL_BATCH) await writeBackfill();
}

/** Resolves once every queued backfill has finished (tests). */
export function backfillSettled(): Promise<void> {
  if (!backfillActive && !backfillQueue.length) return writeBackfill();
  return new Promise((resolve) => backfillWaiters.push(resolve));
}

/** Queue every listed project that has no last edit yet; run once at start. */
export async function backfillMissingLastEdits(): Promise<void> {
  const [metas, activity] = await Promise.all([db().listMeta(), activitySnapshot()]);
  backfillLastEdits(metas.filter((m) => !m.deletedAt && !activity.get(m.id)?.lastEdit).map((m) => m.id));
}
