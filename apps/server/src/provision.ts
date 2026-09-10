import * as store from './store.js';
import * as gitops from './gitops.js';
import * as gitlab from './gitlab.js';
import { getProvider, serviceConnection, type RemoteConnection } from './remotes.js';
import type { ProjectMeta, RemoteLink } from './db/types.js';

/**
 * Auto-provisioning: every new project also becomes a GitLab project inside
 * GITLAB_DEFAULT_GROUP, created with the service token (GITLAB_TOKEN, scope
 * api, Owner on the group). Nothing here ever throws: the project always
 * exists locally, and a GitLab that is down leaves `remotePending` on the
 * project so the owner (or a restore) can retry.
 */

export function provisioningEnabled(): boolean {
  return !!(process.env.GITLAB_TOKEN && process.env.GITLAB_DEFAULT_GROUP && getProvider('gitlab'));
}

/** Root group full path, without surrounding slashes. */
export function rootGroup(): string {
  return (process.env.GITLAB_DEFAULT_GROUP || '').trim().replace(/^\/+|\/+$/g, '');
}

export function defaultVisibility(): 'private' | 'internal' | 'public' {
  const v = (process.env.GITLAB_DEFAULT_VISIBILITY || 'private').trim().toLowerCase();
  return v === 'internal' || v === 'public' ? v : 'private';
}

/** `ns` is the root group or one of its descendants. A plain prefix check would accept `research/latex-archive` for root `research/latex`. */
export function withinRoot(ns: string, root: string): boolean {
  return ns === root || ns.startsWith(`${root}/`);
}

export type ProvisionResult = { ok: true; link: RemoteLink } | { ok: false; error: string };

/**
 * Create the GitLab project for `meta` in `namespace` (default: the root
 * group), store the link (createdByAldine, autopush on) and push main.
 * Writes meta in every outcome; the caller re-reads nothing.
 */
export async function provisionProject(meta: ProjectMeta, opts: { userId?: string; namespace?: string }): Promise<ProvisionResult> {
  const fail = async (error: string, namespace: string): Promise<ProvisionResult> => {
    meta.remotePending = { provider: 'gitlab', namespace };
    await store.writeMeta(meta).catch(() => {});
    return { ok: false, error };
  };
  if (!provisioningEnabled()) return { ok: false, error: 'GitLab provisioning is not configured' };
  const root = rootGroup();
  const namespace = (opts.namespace || '').trim().replace(/^\/+|\/+$/g, '') || root;
  if (!withinRoot(namespace, root)) return fail(`Namespace "${namespace}" is outside the configured group "${root}"`, root);
  if (store.remoteLink(meta)) return { ok: false, error: 'The project is already linked to a remote repository' };
  const conn = serviceConnection();
  const provider = getProvider('gitlab');
  if (!conn || !provider) return fail('GitLab provisioning is not configured', namespace);

  const base = gitlab.slugPath(meta.name) || 'project';
  let repo: Awaited<ReturnType<typeof provider.createRepo>> | null = null;
  let lastError = '';
  // A name the group already holds gets a numeric suffix; five tries, then give up.
  for (let n = 1; n <= 5 && !repo; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      repo = await provider.createRepo(conn, name, { private: defaultVisibility() !== 'public', namespace, visibility: defaultVisibility() });
    } catch (err: any) {
      lastError = String(err?.message || err);
      if (!/has already been taken/i.test(lastError)) break;
    }
  }
  if (!repo) return fail(`Could not create the GitLab project: ${lastError}`, namespace);

  const link: RemoteLink = {
    provider: 'gitlab', fullName: repo.fullName, owner: repo.owner, repo: repo.name, remoteBranch: 'main',
    cloneUrl: repo.cloneUrl, connectedBy: opts.userId, createdByAldine: true,
  };
  store.setRemoteLink(meta, link);
  meta.autopush = true;
  delete meta.remotePending;
  await store.writeMeta(meta);
  try {
    await gitops.pushToRemote(meta.id, 'main', provider.tokenUrl(repo.cloneUrl, conn.token));
  } catch (err: any) {
    // The project exists on both sides and the link is stored; autopush retries the push.
    console.warn(`[provision] first push of ${meta.id} to ${repo.fullName} failed: ${err?.message || err}`);
  }
  return { ok: true, link };
}

export interface DeprovisionResult { deleted: boolean; scheduledFor?: string; error?: string }

/**
 * Remove the GitLab project Aldine created for `meta` (never one that was
 * imported), clear the link and leave `remotePending` so a restore
 * re-provisions into the same namespace. GitLab may only schedule the
 * deletion (delayed deletion on Premium groups); then the purge is requested
 * with `permanently_remove`, and a refused purge is reported, not raised.
 */
export async function deprovisionProject(meta: ProjectMeta): Promise<DeprovisionResult> {
  const link = store.remoteLink(meta);
  if (!link || link.provider !== 'gitlab' || !link.createdByAldine) return { deleted: false };
  const conn = await connectionFor(link);
  if (!conn) return { deleted: false, error: 'no GitLab connection available' };
  const clearLink = async () => {
    store.setRemoteLink(meta, null);
    meta.remotePending = { provider: 'gitlab', namespace: link.owner };
    await store.writeMeta(meta).catch(() => {});
  };
  try {
    // Delayed deletion renames the path (`<path>-deleted-<id>`), so the re-check
    // and the purge go by the numeric id, captured before the first call.
    const before = await gitlab.getProjectRaw(conn, link.fullName);
    if (!before) { await clearLink(); return { deleted: true }; } // already gone
    const byId = String(before.id);
    await gitlab.deleteProject(conn, link.fullName);
    const after = await gitlab.getProjectRaw(conn, byId);
    if (after && after.marked_for_deletion_on) {
      try {
        await gitlab.deleteProject(conn, byId, { permanently: true, fullPath: after.path_with_namespace });
      } catch (err: any) {
        await clearLink();
        return { deleted: false, scheduledFor: String(after.marked_for_deletion_on), error: String(err?.message || err) };
      }
    }
    await clearLink();
    return { deleted: true };
  } catch (err: any) {
    return { deleted: false, error: String(err?.message || err) };
  }
}

async function connectionFor(link: RemoteLink): Promise<RemoteConnection | null> {
  const { resolveConnection } = await import('./remotes.js');
  return resolveConnection(link, link.connectedBy, { allowService: true });
}

/** Boot-time check that the root group resolves; logs, never throws. */
export async function checkProvisioning(): Promise<void> {
  if (!provisioningEnabled()) return;
  const conn = serviceConnection()!;
  try {
    const g = await gitlab.getGroup(conn, rootGroup());
    console.log(`[provision] new projects are created on GitLab in ${g.fullPath} (${defaultVisibility()})`);
  } catch (err: any) {
    console.warn(`[provision] GITLAB_DEFAULT_GROUP "${rootGroup()}" is not reachable with GITLAB_TOKEN: ${err?.message || err}`);
  }
}
