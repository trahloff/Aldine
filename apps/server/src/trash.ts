import * as store from './store.js';
import type { ProjectMeta } from './store.js';
import { cancelAutopush } from './autopush.js';
import { deprovisionProject, type DeprovisionResult } from './provision.js';
import { forgetPdfUrls } from './compile.js';
import { closeProjectConnections } from './collab.js';
import { publishProjectEvent } from './events.js';

/** Days a trashed project stays restorable before the purge sweep removes it. */
const configuredDays = Number(process.env.ALDINE_TRASH_DAYS);
export const TRASH_DAYS = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 30;

/** When a project trashed now stops being restorable. */
export function restorableUntil(from = new Date()): string {
  return new Date(from.getTime() + TRASH_DAYS * 86_400_000).toISOString();
}

/**
 * Move a project to the trash: one implementation for the REST delete and
 * the agent's trash_project tool (SECURITY.md: shared functions, never
 * copies). Access is the caller's job; this does the parts that must not
 * drift apart — a repository Aldine provisioned goes with the project while
 * an imported one is never touched, live collaboration sessions are dropped
 * here and on peer nodes (trash revokes access like un-sharing), and stale
 * PDF links stop resolving. A failed remote deletion is reported, never
 * blocking.
 */
export async function trashProject(meta: ProjectMeta): Promise<{ remote: DeprovisionResult }> {
  cancelAutopush(meta.id);
  const remote: DeprovisionResult = await deprovisionProject(meta).catch((err) => ({ deleted: false, error: String(err?.message || err) }));
  await store.softDeleteProject(meta.id);
  forgetPdfUrls(meta.id);
  closeProjectConnections(meta.id);
  publishProjectEvent({ type: 'access-changed', projectId: meta.id });
  return { remote };
}
