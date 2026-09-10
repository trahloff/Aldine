import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from './db/index.js';
import * as auth from './auth.js';
import { isAdmin } from './authz.js';
import { meteringEnabled, usageFor } from './usage.js';
import { hocuspocus, onlineUserIds } from './collab.js';

/**
 * Instance administration: server-wide metadata for the operator. Metadata
 * only — no route here returns project content, and none bypasses the
 * project ACL. Guarded by isAdmin at the plugin level so a route added later
 * cannot forget the check.
 */

/** Activity older than this no longer counts as "active". */
const ACTIVE_WINDOWS_DAYS = [7, 30] as const;

/** Heartbeat write cadence: at most one datastore write per user per window.
 *  Per process; a multi-node deployment writes once per node per window,
 *  which is still cheap and still correct to the minute. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const lastTouch = new Map<string, number>();

/** Record that a signed-in user made a request. Fire-and-forget: the caller
 *  never waits on it and a datastore error must not fail the request. */
export function noteActivity(userId: string, now = Date.now()): void {
  const prev = lastTouch.get(userId) || 0;
  if (now - prev < TOUCH_INTERVAL_MS) return;
  lastTouch.set(userId, now);
  db().touchUser(userId, new Date(now).toISOString()).catch(() => { lastTouch.delete(userId); });
}

/** Test hook: forget the throttle so a follow-up request touches again. */
export function resetActivityThrottle(): void { lastTouch.clear(); }

export interface AdminStats {
  users: { total: number; active7d: number; active30d: number; onlineNow: number };
  projects: { total: number; trashed: number };
  collab: { documents: number; connections: number };
  compile: { month: string; seconds: number; quotaSeconds: number; metering: boolean };
  /** The configured allow-list, so the page can show who else can see it. */
  admins: string[];
}

export interface AdminUserRow {
  id: string;
  email: string | null;
  name: string;
  provider?: string;
  createdAt: string;
  lastSeenAt?: string;
  admin: boolean;
  projects: number;
  compileSecondsThisMonth: number;
}

function activeSince(users: { lastSeenAt?: string }[], days: number, now: number): number {
  const cutoff = now - days * 864e5;
  return users.filter((u) => u.lastSeenAt && Date.parse(u.lastSeenAt) >= cutoff).length;
}

export async function adminStats(now = Date.now()): Promise<AdminStats> {
  const [users, metas] = await Promise.all([db().listUsers(), db().listMeta()]);
  const month = `${new Date(now).getUTCFullYear()}-${String(new Date(now).getUTCMonth() + 1).padStart(2, '0')}`;
  const seconds = await db().totalUsageSeconds(month);
  const quotaSeconds = users[0] ? (await usageFor(users[0].id, new Date(now))).quotaSeconds : 0;
  return {
    users: {
      total: users.length,
      active7d: activeSince(users, ACTIVE_WINDOWS_DAYS[0], now),
      active30d: activeSince(users, ACTIVE_WINDOWS_DAYS[1], now),
      onlineNow: onlineUserIds().size,
    },
    projects: { total: metas.filter((m) => !m.deletedAt).length, trashed: metas.filter((m) => !!m.deletedAt).length },
    collab: { documents: hocuspocus.getDocumentsCount(), connections: hocuspocus.getConnectionsCount() },
    compile: { month, seconds: Math.round(seconds), quotaSeconds, metering: meteringEnabled() },
    admins: [...auth.ADMIN_EMAILS],
  };
}

export async function adminUsers(now = Date.now()): Promise<AdminUserRow[]> {
  const [users, metas] = await Promise.all([db().listUsers(), db().listMeta()]);
  const owned = new Map<string, number>();
  for (const m of metas) if (m.ownerId && !m.deletedAt) owned.set(m.ownerId, (owned.get(m.ownerId) || 0) + 1);
  return Promise.all(users.map(async (u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    provider: u.provider,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
    admin: isAdmin(auth.pub(u)),
    projects: owned.get(u.id) || 0,
    compileSecondsThisMonth: Math.round((await usageFor(u.id, new Date(now))).seconds),
  })));
}

export async function registerAdminRoutes(app: FastifyInstance, reqUser: (req: FastifyRequest) => auth.PublicUser | null): Promise<void> {
  await app.register(async (admin) => {
    admin.addHook('preHandler', async (req, reply) => {
      if (!auth.AUTH_ENABLED) return;
      const user = reqUser(req);
      if (!user) return reply.code(401).send({ error: 'Sign in required' });
      if (!isAdmin(user)) return reply.code(403).send({ error: 'Administrator access required' });
    });
    admin.get('/api/admin/stats', async () => adminStats());
    admin.get('/api/admin/users', async () => adminUsers());
  });
}
