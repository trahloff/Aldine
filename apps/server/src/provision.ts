import * as store from './store.js';
import * as gitops from './gitops.js';
import { gitlab, serviceConnection, withinRoot } from './gitlab.js';
import { getConnection, getProvider } from './remotes.js';
import { gitlabConfig } from './config.js';

/**
 * Auto-provisioning: when a deployment nominates a GitLab group, new projects
 * are created inside it and pushed there.
 *
 * GitLab is a MIRROR, not the store. The local per-project repo stays
 * authoritative — the compiler mounts it, branches are worktrees, collab
 * autocommits into it — so everything here runs *after* the local project
 * exists and never fails the caller.
 */

/**
 * Whether Aldine created this repo, which is the gate on ever deleting it.
 *
 * Links written before provenance was recorded carry no flag at all, and
 * reading the absent flag as "imported" made every project provisioned by an
 * earlier build leak its GitLab project on delete — while the log blamed an
 * import that never happened. For those, living inside the configured group is
 * the tell: auto-provisioning is the only thing that puts repos there.
 */
function createdByAldine(link: store.RemoteLink): boolean {
  if (typeof link.createdByAldine === 'boolean') return link.createdByAldine;
  return link.provider === 'gitlab'
    && !!gitlabConfig.defaultGroup
    && withinRoot(gitlabConfig.defaultGroup, link.fullName);
}

export interface RemoteDeleteOutcome {
  deleted: boolean;
  /** The host accepted the delete but keeps the repo until this date. */
  scheduledFor?: string;
  reason?: string;
}

/**
 * Delete the remote repo for a project being trashed or purged — but only one
 * Aldine created. A repo the user merely imported stays: deleting it would
 * destroy work Aldine never owned.
 *
 * Best-effort by contract: the local deletion must go ahead regardless, so this
 * never throws. Returns what happened, for logging and for telling the user —
 * a silent no-op is indistinguishable from a broken delete.
 */
export async function deleteRemoteRepo(meta: store.ProjectMeta): Promise<RemoteDeleteOutcome> {
  const link = store.remoteLink(meta);
  if (!link) return { deleted: false, reason: 'no remote' };
  if (!createdByAldine(link)) {
    return { deleted: false, reason: `${link.fullName} was imported, not created by Aldine, so it is left alone` };
  }
  const prov = getProvider(link.provider);
  if (!prov?.deleteRepo) return { deleted: false, reason: `${prov?.label || link.provider} does not support deleting repositories` };
  const conn = (link.connectedBy ? await getConnection(link.connectedBy, link.provider) : null)
    || (link.provider === 'gitlab' ? serviceConnection() : null);
  if (!conn) return { deleted: false, reason: 'no connection available' };
  try {
    const res = await prov.deleteRepo(conn, link.fullName);
    if (res.purged) return { deleted: true };
    return {
      deleted: false,
      scheduledFor: res.scheduledFor,
      reason: `${prov.label} would not remove ${link.fullName} immediately; it is scheduled for deletion on ${res.scheduledFor}`,
    };
  } catch (err: any) {
    return { deleted: false, reason: err.message };
  }
}

/** GitLab project path from a human project name. */
export function slugify(name: string): string {
  const s = (name || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return s || 'project';
}

const TAKEN = /already been taken|already exists/i;
const MAX_PATH_ATTEMPTS = 5;

export interface ProvisionResult { ok: boolean; error?: string }

/**
 * Create the GitLab project and push the local content. Never throws: the local
 * project already exists by the time this runs, so a failure degrades to
 * local-only rather than losing work.
 */
export async function provisionProject(
  meta: store.ProjectMeta,
  opts: { userId: string; namespace?: string },
): Promise<ProvisionResult> {
  const namespace = (opts.namespace || gitlabConfig.defaultGroup).trim();
  // Same boundary as the subgroup endpoint: a caller-supplied namespace must not
  // place projects outside the configured group.
  if (!withinRoot(gitlabConfig.defaultGroup, namespace)) {
    return { ok: false, error: `The namespace must be inside ${gitlabConfig.defaultGroup}` };
  }
  // The user's own token first, so GitLab-side ownership belongs to a real
  // person where possible; the service account is the fallback that makes
  // creation work for users who never connected GitLab.
  const conn = (await getConnection(opts.userId, 'gitlab')) || serviceConnection();
  if (!conn) return { ok: false, error: 'No GitLab connection is available' };

  const base = slugify(meta.name);
  let created;
  for (let attempt = 1; attempt <= MAX_PATH_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      created = await gitlab.createRepo(conn, candidate, {
        private: gitlabConfig.visibility !== 'public',
        namespace,
      });
      break;
    } catch (err: any) {
      if (!TAKEN.test(err.message)) return { ok: false, error: `Could not create the GitLab project: ${err.message}` };
      if (attempt === MAX_PATH_ATTEMPTS) {
        return { ok: false, error: `Could not find a free project path in GitLab near "${base}"` };
      }
    }
  }
  if (!created) return { ok: false, error: `Could not find a free project path in GitLab near "${base}"` };

  store.setRemoteLink(meta, {
    provider: 'gitlab',
    fullName: created.fullName,
    owner: created.owner,
    repo: created.name,
    remoteBranch: 'main',
    cloneUrl: created.cloneUrl,
    connectedBy: opts.userId,
    createdByAldine: true,
  });
  meta.autopush = true;
  delete meta.remotePending;
  await store.writeMeta(meta);

  try {
    await gitops.pushToRemote(meta.id, 'main', gitlab.tokenUrl(created.cloneUrl, conn.token));
  } catch (err: any) {
    // The project exists and the link is stored, so this is the sync UI's Push
    // to retry — not a pending provision.
    return { ok: false, error: `Project created but the first push failed: ${err.message}` };
  }
  return { ok: true };
}
