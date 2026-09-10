import { db } from './db/index.js';
import { github } from './github.js';
import { gitlab } from './gitlab.js';
import type { RemoteConnection, RemoteProvider, RemoteProviderId } from './remote-types.js';
import type { RemoteLink } from './db/types.js';

export * from './remote-types.js';

const ALL: RemoteProvider[] = [github, gitlab];

/** Providers this deployment offers. REMOTE_PROVIDERS="github" hides GitLab entirely (routes 404). */
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
 * The one connection ladder for operations on a linked project: the acting
 * user's own connection, then the connection of whoever linked it, then (only
 * where allowed) the service account. Listing and importing repositories
 * never pass `allowService`: those decide what a user gets to see.
 */
export async function resolveConnection(link: RemoteLink, actingUserId: string | undefined, opts: { allowService: boolean }): Promise<RemoteConnection | null> {
  if (actingUserId) {
    const own = await getConnection(actingUserId, link.provider);
    if (own) return own;
  }
  if (link.connectedBy && link.connectedBy !== actingUserId) {
    const linker = await getConnection(link.connectedBy, link.provider);
    if (linker) return linker;
  }
  if (opts.allowService && link.provider === 'gitlab') return serviceConnection();
  return null;
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

