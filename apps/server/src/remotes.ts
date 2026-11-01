import { db } from './db/index.js';
import { github } from './github.js';
import { gitlab } from './gitlab.js';
import { gitea } from './gitea.js';
import { RemoteApiError } from './remote-types.js';
import type { RemoteConnection, RemoteProvider, RemoteProviderId } from './remote-types.js';
import type { RemoteLink } from './db/types.js';

export * from './remote-types.js';

const ALL: RemoteProvider[] = [github, gitlab, gitea];

/** Providers this deployment offers. REMOTE_PROVIDERS="github" hides GitLab and Gitea entirely (routes 404). */
export function providers(): RemoteProvider[] {
  const raw = (process.env.REMOTE_PROVIDERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!raw.length) return ALL;
  return ALL.filter((p) => raw.includes(p.id));
}

export function getProvider(id: string | undefined): RemoteProvider | null {
  return providers().find((p) => p.id === id) ?? null;
}

export function isProviderId(id: unknown): id is RemoteProviderId {
  return ALL.some((p) => p.id === id);
}

/** The deployment's GitLab service account (GITLAB_TOKEN), for provisioning and for syncing provisioned projects. */
export function serviceConnection(): RemoteConnection | null {
  const token = (process.env.GITLAB_TOKEN || '').trim();
  return token && getProvider('gitlab') ? { token, login: 'aldine-service' } : null;
}

/**
 * The instance a link was made on: its recorded `baseUrl`, else the clone
 * URL's origin for links from before the field; null when neither tells
 * (a legacy link whose clone URL is not http).
 */
export function linkInstance(link: RemoteLink): string | null {
  if (link.baseUrl) return link.baseUrl;
  try {
    const u = new URL(link.cloneUrl);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}

/** A connection serves a link only on the link's instance: every Gitea connection, and every PAT GitLab connection, names its own host. */
function onLinkInstance(link: RemoteLink, conn: RemoteConnection): boolean {
  const provider = ALL.find((p) => p.id === link.provider);
  const at = linkInstance(link);
  if (!provider || !at) return true;
  try { return provider.instanceOrigin(conn) === new URL(at).origin; } catch { return false; }
}

/** Where a linked project's connection came from, for the UI to say whose token a sync uses. */
export type ConnectionSource = 'project' | 'own' | 'linker' | 'service';

/**
 * The one connection ladder for operations on a linked project: the token
 * the owner stored on the project itself, then the acting user's own
 * connection, then the connection of whoever linked it, then (only where
 * allowed) the service account; a connection to another instance of the
 * same provider is skipped, never used. Listing and importing repositories
 * never pass `allowService`: those decide what a user gets to see.
 */
export async function resolveConnectionSource(
  link: RemoteLink, actingUserId: string | undefined, opts: { allowService: boolean; projectId?: string },
): Promise<{ conn: RemoteConnection; source: ConnectionSource } | null> {
  if (opts.projectId) {
    const project = await getProjectConnection(opts.projectId, link.provider);
    if (project && onLinkInstance(link, project)) return { conn: project, source: 'project' };
  }
  if (actingUserId) {
    const own = await activeConnection(actingUserId, link.provider);
    if (own && onLinkInstance(link, own)) return { conn: own, source: 'own' };
  }
  if (link.connectedBy && link.connectedBy !== actingUserId) {
    const linker = await activeConnection(link.connectedBy, link.provider);
    if (linker && onLinkInstance(link, linker)) return { conn: linker, source: 'linker' };
  }
  if (opts.allowService && link.provider === 'gitlab') {
    const service = serviceConnection();
    if (service && onLinkInstance(link, service)) return { conn: service, source: 'service' };
  }
  return null;
}

export async function resolveConnection(link: RemoteLink, actingUserId: string | undefined, opts: { allowService: boolean; projectId?: string }): Promise<RemoteConnection | null> {
  return (await resolveConnectionSource(link, actingUserId, opts))?.conn ?? null;
}

/** The account's connection while the account may still act: an account an
 *  administrator disabled lends its token to nobody, autopush included. */
async function activeConnection(userId: string, provider: RemoteProviderId): Promise<RemoteConnection | null> {
  if ((await db().getUser(userId))?.disabledAt) return null;
  return getConnection(userId, provider);
}

export async function getConnection(userId: string, provider: RemoteProviderId): Promise<RemoteConnection | null> {
  const c = await db().getConnection(userId, provider);
  return c && typeof c.token === 'string' ? (c as unknown as RemoteConnection) : null;
}
export function setConnection(userId: string, provider: RemoteProviderId, conn: RemoteConnection): Promise<void> {
  return db().setConnection(userId, provider, conn as unknown as Record<string, unknown>);
}
export function disconnect(userId: string, provider: RemoteProviderId): Promise<void> {
  return db().deleteConnection(userId, provider);
}


// A project's own token lives in the same secrets store as account
// connections, under an owner key no account id can take (account ids
// never contain a colon).
const projectOwner = (projectId: string) => `project:${projectId}`;

export async function getProjectConnection(projectId: string, provider: RemoteProviderId): Promise<RemoteConnection | null> {
  return getConnection(projectOwner(projectId), provider);
}
export function setProjectConnection(projectId: string, provider: RemoteProviderId, conn: RemoteConnection): Promise<void> {
  return setConnection(projectOwner(projectId), provider, conn);
}
/** Every provider: a project's token goes with the project, whichever host it was for. */
export async function clearProjectConnections(projectId: string): Promise<void> {
  for (const p of ALL) await db().deleteConnection(projectOwner(projectId), p.id);
}

/**
 * Whether a failed call failed because the host refused `conn`'s token.
 * Git's own failure text names no cause a user can act on, so after a failed
 * git call the host is asked whose token it is: a 401 there means an expired
 * or revoked token, which the editor answers with its Reconnect action.
 */
export async function tokenRefused(provider: RemoteProvider, conn: RemoteConnection, err: unknown): Promise<boolean> {
  if (err instanceof RemoteApiError) return err.status === 401;
  try { await provider.whoami(conn); return false; }
  catch (e) { return e instanceof RemoteApiError && e.status === 401; }
}
