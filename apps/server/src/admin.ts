import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db/index.js';
import type { Invitation, ProjectMeta, User } from './db/types.js';
import * as auth from './auth.js';
import * as email from './email.js';
import * as store from './store.js';
import { config } from './config.js';
import { isAdmin } from './authz.js';
import { providers } from './oauth.js';
import { meteringEnabled, usageFor } from './usage.js';
import { hocuspocus, onlineUserIds, closeUserConnections } from './collab.js';
import { publishProjectEvent } from './events.js';
import { trashProject } from './trash.js';
import { adminLimiter, clientKey } from './ratelimit.js';

/**
 * Instance administration: server-wide metadata for the operator, and the
 * account actions (disable, confirm an address, reset link, delete). No
 * route here returns project content, and none bypasses the project ACL;
 * two change who passes it (a reset link shown to the administrator, a
 * deleted account's projects given to another account), see isAdmin.
 * Guarded by isAdmin at the plugin level so a route added later cannot
 * forget the check.
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
  /** `awaitingApproval`: accounts created under ALDINE_SIGNUP=approval that nobody approved yet. */
  users: { total: number; active7d: number; active30d: number; onlineNow: number; awaitingApproval: number };
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
  /** How the account signs in: "Password", or the provider's name. */
  signIn: string;
  /** A password account: the only kind a reset link serves. */
  password: boolean;
  createdAt: string;
  lastSeenAt?: string;
  /** A password sign-up that has not confirmed its address yet. */
  emailPending: boolean;
  /** Since when an administrator has had the account disabled. */
  disabledAt?: string;
  /** Created under ALDINE_SIGNUP=approval and not approved yet: disabled
   *  since it was created, and Enable approves it. */
  awaitingApproval: boolean;
  /** On ALDINE_ADMIN_EMAILS with a confirmed address. */
  admin: boolean;
  projects: number;
  trashedProjects: number;
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
      awaitingApproval: users.filter(auth.awaitingApproval).length,
    },
    projects: { total: metas.filter((m) => !m.deletedAt).length, trashed: metas.filter((m) => !!m.deletedAt).length },
    collab: { documents: hocuspocus.getDocumentsCount(), connections: hocuspocus.getConnectionsCount() },
    compile: { month, seconds: Math.round(seconds), quotaSeconds, metering: meteringEnabled() },
    admins: [...auth.ADMIN_EMAILS],
  };
}

const signInLabel = (u: User) => (u.provider ? providers.find((p) => p.id === u.provider)?.label ?? u.provider : 'Password');

async function rows(users: User[], now: number): Promise<AdminUserRow[]> {
  const metas = await db().listMeta();
  const owned = new Map<string, { live: number; trashed: number }>();
  for (const m of metas) {
    if (!m.ownerId) continue;
    const n = owned.get(m.ownerId) || { live: 0, trashed: 0 };
    if (m.deletedAt) n.trashed++; else n.live++;
    owned.set(m.ownerId, n);
  }
  return Promise.all(users.map(async (u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    provider: u.provider,
    signIn: signInLabel(u),
    password: auth.hasPassword(u),
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
    emailPending: !!u.emailPending,
    ...(u.disabledAt ? { disabledAt: u.disabledAt } : {}),
    awaitingApproval: auth.awaitingApproval(u),
    admin: isAdmin(auth.pub(u)),
    projects: owned.get(u.id)?.live || 0,
    trashedProjects: owned.get(u.id)?.trashed || 0,
    compileSecondsThisMonth: Math.round((await usageFor(u.id, new Date(now))).seconds),
  })));
}

export async function adminUsers(now = Date.now()): Promise<AdminUserRow[]> {
  return rows(await db().listUsers(), now);
}

async function adminUser(id: string): Promise<AdminUserRow | null> {
  const u = await db().getUser(id);
  return u ? (await rows([u], Date.now()))[0] : null;
}

// ---------- account actions ----------

/** The account's name in the log: never the display name, which is free text. */
const who = (u: { id: string; email: string | null; subject?: string }) => `${u.email ?? u.subject ?? 'no address'} [${u.id}]`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Every account action leaves one line naming who did what to whom. */
function audit(actor: auth.PublicUser, action: string, target: User, detail?: string): void {
  console.log(`[aldine] admin ${who(actor)} ${action} ${who(target)}${detail ? ` (${detail})` : ''}`);
}

/** Why this administrator may not disable or delete the account, or null.
 *  An address on the list that is not confirmed yet is not protected: that
 *  account may be someone squatting on the administrator's address. */
function protectedReason(actor: auth.PublicUser, user: User, verb: 'disable' | 'delete'): string | null {
  if (user.id === actor.id) return `You cannot ${verb} your own account.`;
  if (isAdmin(auth.pub(user))) return `${user.email} is on ALDINE_ADMIN_EMAILS. Remove it from that list and restart the server, then ${verb} the account here.`;
  return null;
}

/** The address is on ALDINE_ADMIN_EMAILS, confirmed or not. */
const onAdminList = (u: User) => !!u.email && auth.ADMIN_EMAILS.has(u.email.toLowerCase());

/** What the person deleting an account types to confirm it. */
const deleteConfirmation = (u: User) => u.email ?? u.name;

/** Collab sockets of the account, here and on every other node. */
function endSockets(userId: string): void {
  closeUserConnections(userId);
  publishProjectEvent({ type: 'account-ended', userId });
}

/** Does this share-list entry name the account: its confirmed address or
 *  its ORCID iD? An invite to an address nobody confirmed is for whoever
 *  owns the address, and stays. */
function namesAccount(u: User, entry: string): boolean {
  const address = u.emailPending ? undefined : u.email?.toLowerCase();
  const orcid = auth.orcidOf(u);
  return (!!address && entry.toLowerCase() === address) || (!!orcid && entry === orcid);
}

/** Withdraw the open ones: an invitation nobody may accept any more. */
async function withdrawOpen(invitations: Invitation[]): Promise<void> {
  const at = new Date().toISOString();
  for (const inv of invitations) if (inv.status === 'pending') await store.settleInvitation(inv.id, 'withdrawn', at);
}

async function transferProject(meta: ProjectMeta, to: User): Promise<void> {
  meta.ownerId = to.id;
  const share = meta.share ?? { mode: 'private' as const, collaborators: [] };
  meta.share = { ...share, collaborators: share.collaborators.filter((c) => !namesAccount(to, c)) };
  // The link carries the previous owner's Zotero key, and searching it reads
  // their whole personal library.
  delete meta.zotero;
  await store.writeMeta(meta);
  // The new owner invited nobody.
  await withdrawOpen(await store.listProjectInvitations(meta.id));
}

async function removeFromShares(u: User): Promise<number> {
  let removed = 0;
  for (const meta of await db().listMeta()) {
    const list = meta.share?.collaborators;
    if (!meta.share || !list?.some((c) => namesAccount(u, c))) continue;
    meta.share = { ...meta.share, collaborators: list.filter((c) => !namesAccount(u, c)) };
    await store.writeMeta(meta);
    removed++;
  }
  // Open invitations to the account go the same way as its share entries.
  const keys = [...(u.email && !u.emailPending ? [u.email.toLowerCase()] : []), ...(auth.orcidOf(u) ? [auth.orcidOf(u)!] : [])];
  if (keys.length) await withdrawOpen(await store.listInvitationsTo(keys));
  return removed;
}

const sendsEmail = () => email.emailConfigured() && !!config.publicUrl;

export async function registerAdminRoutes(app: FastifyInstance, reqUser: (req: FastifyRequest) => auth.PublicUser | null): Promise<void> {
  await app.register(async (admin) => {
    admin.addHook('preHandler', async (req, reply) => {
      // An access token is a project credential, never the administrator.
      if ((req as any)._tokenScope) return reply.code(403).send({ error: 'Access tokens cannot use the admin pages — sign in to do this' });
      if (!auth.AUTH_ENABLED) return;
      const user = reqUser(req);
      if (!user) return reply.code(401).send({ error: 'Sign in required' });
      if (!isAdmin(user)) return reply.code(403).send({ error: 'Administrator access required' });
      if (req.method === 'GET' || req.method === 'HEAD') return;
      // A cross-site form cannot send JSON, and a cross-site fetch that does
      // needs a CORS preflight this server never answers.
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
        return reply.code(415).send({ error: 'Send the request as JSON' });
      }
      if (!(await adminLimiter.take(clientKey(req, user.id)))) {
        return reply.code(429).send({ error: 'Too many account changes in a row — wait a moment and try again' });
      }
    });
    admin.get('/api/admin/stats', async () => adminStats());
    admin.get('/api/admin/users', async () => adminUsers());

    // `:userId`, never `:id`: the project guard in routes.ts reads `params.id`
    // as a project id on every route.
    type Act = { Params: { userId: string }; Body: Record<string, unknown> | undefined };
    /** The administrator and the account an action names; null after replying. */
    const target = async (req: FastifyRequest<Act>, reply: FastifyReply): Promise<{ actor: auth.PublicUser; user: User } | null> => {
      const actor = reqUser(req);
      if (!auth.AUTH_ENABLED || !actor) {
        reply.code(400).send({ error: 'Accounts are off on this server (AUTH_ENABLED is not set)' });
        return null;
      }
      const user = await db().getUser(req.params.userId);
      if (!user) {
        reply.code(404).send({ error: 'There is no such account' });
        return null;
      }
      return { actor, user };
    };

    admin.post<Act>('/api/admin/users/:userId/disable', async (req, reply) => {
      const t = await target(req, reply);
      if (!t) return;
      const refused = protectedReason(t.actor, t.user, 'disable');
      if (refused) return reply.code(403).send({ error: refused });
      if (!t.user.disabledAt) {
        const revoke = req.body?.revokeAgentAccess === true;
        await auth.disableAccount(t.user.id, revoke);
        endSockets(t.user.id);
        audit(t.actor, 'disabled', t.user, revoke ? 'access tokens and agent connections revoked' : undefined);
      }
      return adminUser(t.user.id);
    });

    // Enabling an account that waits for approval approves it.
    admin.post<Act>('/api/admin/users/:userId/enable', async (req, reply) => {
      const t = await target(req, reply);
      if (!t) return;
      if (t.user.disabledAt) {
        const approving = auth.awaitingApproval(t.user);
        await auth.enableAccount(t.user.id);
        audit(t.actor, approving ? 'approved' : 'enabled', t.user);
        if (approving && t.user.email && sendsEmail()) {
          email.sendMail(email.approvedMail(t.user.email, config.publicUrl, `${config.publicUrl}/`))
            .catch((err) => console.error('[aldine] approval email failed:', err?.message || err));
        }
      }
      return adminUser(t.user.id);
    });

    admin.post<Act>('/api/admin/users/:userId/confirm-email', async (req, reply) => {
      const t = await target(req, reply);
      if (!t) return;
      if (!t.user.emailPending) return adminUser(t.user.id);
      // Confirming such an address would hand its account administrator rights.
      if (onAdminList(t.user)) {
        return reply.code(403).send({ error: `${t.user.email} is on ALDINE_ADMIN_EMAILS, so confirming it would make this account an administrator. Its owner confirms it with the link from the sign-up email or the server log.` });
      }
      await auth.confirmEmailForAccount(t.user.id);
      audit(t.actor, 'confirmed the address of', t.user);
      return adminUser(t.user.id);
    });

    admin.post<Act>('/api/admin/users/:userId/reset-link', async (req, reply) => {
      const t = await target(req, reply);
      if (!t) return;
      if (auth.SSO_ONLY) return reply.code(403).send({ error: 'Password sign-in is disabled on this server (ALDINE_SSO_ONLY).' });
      if (!auth.hasPassword(t.user)) return reply.code(400).send({ error: `This account signs in with ${signInLabel(t.user)} and has no password to reset.` });
      const mails = sendsEmail();
      // A link shown here lets the administrator set the password, and
      // following it confirms the address: on an address from the list, even
      // one still pending, that makes an administrator.
      if (!mails && onAdminList(t.user) && t.user.id !== t.actor.id) {
        return reply.code(403).send({ error: `${t.user.email} is on ALDINE_ADMIN_EMAILS. Without email, its owner resets the password from the sign-in page and gets the link from the server log.` });
      }
      const r = await auth.issueReset(t.user.id);
      if (!r?.user.email) return reply.code(400).send({ error: 'This account has no password to reset.' });
      const link = `${config.publicUrl || config.basePath}/?reset_token=${encodeURIComponent(r.token)}`;
      reply.header('cache-control', 'no-store');
      if (mails) {
        email.sendMail(email.resetMail(r.user.email, link, r.token))
          .catch((err) => console.error('[aldine] reset email failed:', err?.message || err));
        audit(t.actor, 'sent a password reset email to', t.user);
        return { sent: true, to: r.user.email };
      }
      audit(t.actor, 'created a password reset link for', t.user);
      return { sent: false, link };
    });

    admin.post<Act>('/api/admin/users/:userId/delete', async (req, reply) => {
      const t = await target(req, reply);
      if (!t) return;
      const refused = protectedReason(t.actor, t.user, 'delete');
      if (refused) return reply.code(403).send({ error: refused });
      const body = req.body || {};
      const expected = deleteConfirmation(t.user);
      if (typeof body.confirm !== 'string' || body.confirm.trim().toLowerCase() !== expected.trim().toLowerCase()) {
        return reply.code(400).send({ error: `Type ${expected} to confirm.` });
      }
      if (body.projects !== 'transfer' && body.projects !== 'trash') {
        return reply.code(400).send({ error: 'Choose what happens to the projects: give them to another account, or move them to the trash.' });
      }
      let heir: User | null = null;
      if (body.projects === 'transfer') {
        heir = typeof body.transferTo === 'string' ? await db().getUser(body.transferTo) : null;
        if (!heir || heir.id === t.user.id) return reply.code(400).send({ error: 'Choose another account to give the projects to.' });
        if (heir.disabledAt) return reply.code(400).send({ error: `${heir.email ?? heir.name} is disabled. Enable it first, or choose another account.` });
      }
      // Nothing the account holds may work while the rest runs.
      await auth.disableAccount(t.user.id, true);
      endSockets(t.user.id);
      let transferred = 0, trashed = 0;
      for (const meta of (await db().listMeta()).filter((m) => m.ownerId === t.user.id)) {
        if (heir) {
          await transferProject(meta, heir);
          transferred++;
        } else if (!meta.deletedAt) {
          await trashProject(meta);
          trashed++;
        }
      }
      const sharesRemoved = await removeFromShares(t.user);
      await auth.deleteAccount(t.user.id);
      const where = heir ? `${count(transferred, 'project')} to ${who(heir)}` : `${count(trashed, 'project')} to the trash`;
      audit(t.actor, 'deleted', t.user, `${where}, taken off ${count(sharesRemoved, 'share list')}`);
      return { ok: true, transferred, trashed, sharesRemoved };
    });
  });
}
