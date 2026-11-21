import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from './db/index.js';
import type { Invitation, ProjectMeta, User } from './db/types.js';
import * as auth from './auth.js';
import * as store from './store.js';
import * as gitops from './gitops.js';
import * as remotes from './remotes.js';
import { config } from './config.js';
import { isAdmin, isMember, roleOf } from './authz.js';
import { closeUserConnections } from './collab.js';
import { publishProjectEvent } from './events.js';
import { trashProject } from './trash.js';
import { typesetsSettled } from './compile.js';
import { deprovisionProject } from './provision.js';
import { readAvatar } from './avatars.js';
import { loadPersonalRepos, personalView } from './templaterepos.js';
import { normalizeEntry, recipientKeys } from './invites.js';
import { linksOf, rolesOf } from './sharelinks.js';
import { branchArchive } from './archive.js';
import { ZipStream } from './zipstream.js';
import { clientKey, exportGate, exportLimiter, loginLimiter } from './ratelimit.js';

/**
 * The account's own data and its end: everything an account takes with it
 * when it goes (removeAccount, for the administrator's Delete and the
 * person's own), the export a person downloads from Account settings, and
 * deleting one's own account there.
 */

// ---------- removing an account ----------

/** Collab sockets of the account, here and on every other node. */
export function endSockets(userId: string): void {
  closeUserConnections(userId);
  publishProjectEvent({ type: 'account-ended', userId });
}

/** Does this share-list entry name the account: its confirmed address or
 *  its ORCID iD? An invite to an address nobody confirmed is for whoever
 *  owns the address, and stays. */
function namesAccount(u: User, orcid: string | undefined, entry: string): boolean {
  const address = u.emailPending ? undefined : u.email?.toLowerCase();
  return (!!address && entry.toLowerCase() === address) || (!!orcid && entry.toUpperCase() === orcid.toUpperCase());
}

/** Withdraw the open ones: an invitation nobody may accept any more. */
async function withdrawOpen(invitations: Invitation[]): Promise<void> {
  const at = new Date().toISOString();
  for (const inv of invitations) if (inv.status === 'pending') await store.settleInvitation(inv.id, 'withdrawn', at);
}

async function transferProject(meta: ProjectMeta, to: User): Promise<void> {
  const orcid = await auth.orcidFor(to);
  await store.updateMeta(meta.id, (m) => {
    const share = m.share ?? { collaborators: [], links: [] };
    const roles = share.roles && Object.fromEntries(Object.entries(share.roles).filter(([k]) => !namesAccount(to, orcid, k)));
    const next: ProjectMeta = { ...m, ownerId: to.id, share: { ...share, collaborators: share.collaborators.filter((c) => !namesAccount(to, orcid, c)), ...(roles ? { roles } : {}) } };
    // The link carries the previous owner's Zotero key, and searching it reads
    // their whole personal library.
    delete next.zotero;
    return next;
  });
  // The new owner invited nobody.
  await withdrawOpen(await store.listProjectInvitations(meta.id));
}

/** Take the account off every project it was let into: share-list entries
 *  naming it (with their roles), the share links it came in through, and open
 *  invitations to it. Returns how many projects' sharing changed. */
async function removeFromShares(u: User): Promise<number> {
  let changed = 0;
  const orcid = await auth.orcidFor(u);
  const names = (entry: string) => namesAccount(u, orcid, entry);
  for (const meta of await store.listProjects()) {
    const share = meta.share;
    const named = !!share?.collaborators.some(names) || Object.keys(share?.roles ?? {}).some(names);
    const joined = linksOf(meta).some((l) => l.members?.some((m) => m.id === u.id));
    if (!share || (!named && !joined)) continue;
    await store.updateMeta(meta.id, (m) => {
      const s = m.share;
      if (!s) return null;
      const roles = s.roles && Object.fromEntries(Object.entries(s.roles).filter(([k]) => !names(k)));
      return {
        ...m,
        share: {
          ...s,
          collaborators: s.collaborators.filter((c) => !names(c)),
          ...(roles ? { roles } : {}),
          ...(s.links ? { links: s.links.map((l) => (l.members?.some((x) => x.id === u.id) ? { ...l, members: l.members.filter((x) => x.id !== u.id) } : l)) } : {}),
        },
      };
    }).catch(() => {}); // a project deleted meanwhile has no sharing left to change
    changed++;
  }
  const keys = recipientKeys({ email: u.email, orcid, ...(u.emailPending ? { emailPending: true as const } : {}) });
  if (keys.length) await withdrawOpen(await store.listInvitationsTo(keys));
  return changed;
}

/** What happens to the projects the account owns, the trashed ones included:
 *  another account takes them over, they go to the trash (purged on
 *  schedule), or they are deleted now with their history. */
export type ProjectFate = { transferTo: User } | 'trash' | 'delete';
export interface Removal { transferred: number; trashed: number; deleted: number; sharesRemoved: number }

/**
 * Remove an account and what exists only for it. Its credentials stop
 * working first, so nothing it holds acts while the rest runs; then its
 * projects meet `fate`, it comes off every project it was let into, and the
 * account row and its personal files go (auth.deleteAccount). Comments and
 * commits keep the name they were written under, and compile seconds stay
 * in the instance totals. Who may do this to which account is the caller's.
 */
export async function removeAccount(user: User, fate: ProjectFate): Promise<Removal> {
  await auth.disableAccount(user.id, true);
  endSockets(user.id);
  const out: Removal = { transferred: 0, trashed: 0, deleted: 0, sharesRemoved: 0 };
  for (const meta of (await store.listProjects()).filter((m) => m.ownerId === user.id)) {
    if (typeof fate === 'object') {
      await transferProject(meta, fate.transferTo);
      out.transferred++;
      continue;
    }
    if (!meta.deletedAt) await trashProject(meta);
    else if (fate === 'delete') await deprovisionProject(meta).catch((err) => console.error(`[aldine] remote clean-up of ${meta.id} failed`, err?.message || err));
    if (fate === 'delete') {
      // The trash above refuses new typesets; one still running writes into
      // the directory being removed.
      await typesetsSettled(meta.id);
      try {
        await store.deleteProject(meta.id);
      } catch (err: any) {
        // Trashed already, so the daily sweep purges what is left; the
        // account must still go, its owner can no longer sign in to retry.
        console.error(`[aldine] deleting project ${meta.id} of a deleted account failed, the trash sweep purges it`, err?.message || err);
      }
      out.deleted++;
    } else {
      if (!meta.deletedAt) out.trashed++;
      // Nobody is left to answer for them.
      await withdrawOpen(await store.listProjectInvitations(meta.id));
    }
  }
  out.sharesRemoved = await removeFromShares(user);
  await auth.deleteAccount(user.id);
  return out;
}

// ---------- what deleting one's own account involves ----------

/** What the person deleting an account types to confirm it. */
export const deleteConfirmation = (u: { email: string | null; name: string }) => u.email ?? u.name;

/** Why this account may not delete itself, or null. */
export function selfDeleteRefusal(u: auth.PublicUser): string | null {
  if (isAdmin(u)) return `${u.email} is on ALDINE_ADMIN_EMAILS, so this account administers the server. Ask whoever runs it to remove the address from that list and restart, then delete the account here.`;
  return null;
}

/** People besides the owner a project is open to: share-list entries, open
 *  invitations and whoever came in through a share link. */
async function othersIn(meta: ProjectMeta, now = Date.now()): Promise<number> {
  const people = new Set<string>(meta.share?.collaborators.map((c) => c.toLowerCase()) ?? []);
  for (const inv of await store.listProjectInvitations(meta.id)) if (inv.status === 'pending' && Date.parse(inv.expiresAt) > now) people.add(inv.to.toLowerCase());
  for (const l of linksOf(meta)) for (const m of l.members ?? []) if (m.id !== meta.ownerId) people.add(`id:${m.id}`);
  return people.size;
}

export interface DeletionPreview {
  /** Typed to confirm. */
  confirm: string;
  /** Why the account cannot delete itself, or null. */
  refused: string | null;
  /** What confirming it is you takes now: nothing (a recent sign-in), the
   *  password, or signing in again. */
  reauth: 'none' | 'password' | 'sign-in';
  projects: Array<{ id: string; name: string; trashed: boolean; others: number }>;
}

export async function deletionPreview(u: auth.PublicUser, sid: string | undefined): Promise<DeletionPreview> {
  const user = await db().getUser(u.id);
  if (!user) throw new Error('User not found');
  const owned = (await store.listProjects()).filter((m) => m.ownerId === u.id);
  const projects = await Promise.all(owned.map(async (m) => ({ id: m.id, name: m.name, trashed: !!m.deletedAt, others: await othersIn(m) })));
  const reauth = (await auth.sessionIsRecent(sid)) ? 'none' : auth.hasPassword(user) && !auth.SSO_ONLY ? 'password' : 'sign-in';
  return { confirm: deleteConfirmation(user), refused: selfDeleteRefusal(u), reauth, projects };
}

// ---------- export ----------

/** A path segment from free text: no slashes, control or reserved characters. */
function segment(name: string, fallback: string): string {
  const s = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-').replace(/^[\s.-]+|[\s.]+$/g, '').slice(0, 80).replace(/[\ud800-\udbff]$/, '');
  return s || fallback;
}

/** Where a project's branches go in the export. */
const projectFolder = (m: ProjectMeta) => `projects/${segment(m.name, 'project')} (${m.id})`;

const AVATAR_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * Write the account's export into `zip`: account.json, the profile picture,
 * and every branch of every project the account owns (trashed ones too), each
 * as the ZIP the Share dialog downloads. One branch is in memory at a time.
 * A branch that cannot be archived is named in account.json under
 * `incomplete`, which is written last for that reason.
 */
export async function writeExport(u: auth.PublicUser, zip: ZipStream, author?: gitops.CommitAuthor): Promise<void> {
  const user = await db().getUser(u.id);
  if (!user) throw new Error('User not found');
  const now = new Date();
  const metas = await store.listProjects();
  const opens = new Map((await db().listProjectOpens(u.id)).map((o) => [o.projectId, o]));
  const incomplete: Array<{ projectId: string; branch?: string; error: string }> = [];

  const owned = [];
  for (const meta of metas.filter((m) => m.ownerId === u.id)) {
    const folder = projectFolder(meta);
    let branches: string[] = [];
    try { branches = (await gitops.listBranches(meta.id)).map((b) => b.name).sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b))); }
    catch (err: any) { incomplete.push({ projectId: meta.id, error: String(err?.message || err) }); }
    const files: Record<string, string> = {};
    for (const branch of branches) {
      if (zip.closed) return;
      try {
        const data = await branchArchive(meta, branch, author);
        const name = `${folder}/${branch}.zip`;
        await zip.add(name, data, now);
        files[branch] = name;
      } catch (err: any) {
        if (zip.closed) return;
        incomplete.push({ projectId: meta.id, branch, error: String(err?.message || err) });
      }
    }
    const roles = rolesOf(meta);
    const remote = store.remoteLink(meta);
    owned.push({
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      ...(meta.deletedAt ? { trashedAt: meta.deletedAt } : {}),
      rootFile: meta.rootFile,
      engine: meta.engine,
      branches: files,
      sharedWith: (meta.share?.collaborators ?? []).map((c) => ({ entry: c, role: roles[normalizeEntry(c)] ?? 'edit' })),
      shareLinks: linksOf(meta).map((l) => ({ label: l.label ?? null, role: l.role, createdAt: l.createdAt, expiresAt: l.expiresAt ?? null, revokedAt: l.revokedAt ?? null, guests: !!l.guests, joined: l.members?.length ?? 0 })),
      invitations: (await store.listProjectInvitations(meta.id)).map((i) => ({ to: i.to, status: i.status, createdAt: i.createdAt, expiresAt: i.expiresAt })),
      ...(remote ? { remote: { provider: remote.provider, repository: remote.fullName, ...(remote.baseUrl ? { host: remote.baseUrl } : {}) } } : {}),
      ...(meta.zotero ? { zotero: { library: meta.zotero.libraryName ?? meta.zotero.libraryPrefix, ...(meta.zotero.collectionName ? { collection: meta.zotero.collectionName } : {}), bibFile: meta.zotero.bibFile } } : {}),
    });
  }

  const shared = [];
  const reachable: ProjectMeta[] = metas.filter((m) => m.ownerId === u.id);
  for (const meta of metas) {
    if (meta.ownerId === u.id || meta.deletedAt) continue;
    const role = roleOf(meta, u);
    if (!role) continue;
    const named = isMember(meta, u);
    const viaLink = linksOf(meta).some((l) => l.members?.some((m) => m.id === u.id)) || opens.has(meta.id);
    if (!named && !viaLink) continue;
    reachable.push(meta);
    const owner = meta.ownerId ? await db().getUser(meta.ownerId) : null;
    shared.push({ id: meta.id, name: meta.name, role, via: named ? 'share list' : 'share link', owner: owner ? owner.name : null, lastOpenedAt: opens.get(meta.id)?.at ?? null });
  }

  const comments = [];
  for (const meta of reachable) {
    for (const c of await db().loadComments(meta.id)) {
      if (c.authorId === u.id) {
        comments.push({ projectId: meta.id, branch: c.branch, file: c.file, createdAt: c.createdAt, body: c.body, ...(c.suggestion !== undefined ? { suggestion: c.suggestion } : {}), resolved: c.resolved });
      }
      for (const r of c.replies) {
        if (r.authorId === u.id) comments.push({ projectId: meta.id, branch: c.branch, file: c.file, createdAt: r.createdAt, body: r.body, replyTo: c.id });
      }
    }
  }

  const keys = recipientKeys(u);
  const invitations = keys.length ? (await store.listInvitationsTo(keys)).filter((i) => i.status === 'pending') : [];
  const invitedTo = await Promise.all(invitations.map(async (i) => ({ projectId: i.projectId, project: (await db().readMeta(i.projectId))?.name ?? null, to: i.to, createdAt: i.createdAt, expiresAt: i.expiresAt })));

  const connections = [];
  for (const p of remotes.providers()) {
    const conn = await remotes.getConnection(u.id, p.id);
    if (conn) connections.push({ provider: p.id, login: conn.login, ...(conn.baseUrl ? { host: conn.baseUrl } : {}) });
  }
  const zoteroKey = await db().getConnection(u.id, 'zotero');
  if (zoteroKey) connections.push({ provider: 'zotero', login: typeof zoteroKey.username === 'string' ? zoteroKey.username : null });

  const methods = await auth.signInMethods(u.id, undefined);
  const tokens = await db().listTokensForUser(u.id);

  const avatar = readAvatar(u.id);
  let avatarFile: string | null = null;
  if (avatar) {
    avatarFile = `avatar.${AVATAR_EXT[avatar.type] ?? 'img'}`;
    await zip.add(avatarFile, avatar.bytes, now);
  }

  const account = {
    format: 'aldine-account-export',
    version: 1,
    exportedAt: now.toISOString(),
    server: config.publicUrl || null,
    account: {
      id: user.id,
      email: user.email,
      emailConfirmed: !!user.email && !user.emailPending,
      name: user.name,
      orcid: u.orcid ?? null,
      commitEmail: user.commitEmail ?? null,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt ?? null,
      signupNote: user.signupNote ?? null,
      picture: avatarFile,
    },
    signIn: {
      password: methods.password,
      provider: user.provider ?? null,
      connected: methods.links.map((l) => ({ provider: l.provider, name: l.label, connectedAt: l.createdAt })),
    },
    accessTokens: tokens.map((t) => ({ name: t.name, connection: t.clientName ?? null, projects: t.projectIds, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt, revokedAt: t.revokedAt })),
    connections,
    personalTemplates: (await loadPersonalRepos(u.id)).map(personalView).map((r) => ({ name: r.label, url: r.url, ref: r.ref, path: r.path })),
    ownedProjects: owned,
    sharedWithYou: shared,
    invitationsToYou: invitedTo,
    comments,
    incomplete,
  };
  await zip.add('account.json', Buffer.from(`${JSON.stringify(account, null, 2)}\n`), now);
  await zip.finish();
}

// ---------- routes ----------

const who = (u: { id: string; email: string | null; orcid?: string }) => `${u.email ?? u.orcid ?? 'no address'} [${u.id}]`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export async function registerAccountRoutes(app: FastifyInstance, reqUser: (req: FastifyRequest) => auth.PublicUser | null): Promise<void> {
  await app.register(async (acc) => {
    // The account's own surface: a browser session only. An access token is
    // an agent's project credential, never the person.
    acc.addHook('preHandler', async (req, reply) => {
      if (!auth.AUTH_ENABLED) return reply.code(404).send({ error: 'Accounts are off on this server' });
      if ((req as any)._tokenScope) return reply.code(403).send({ error: 'Access tokens cannot use your account settings — sign in to do this' });
      const user = reqUser(req);
      if (!user || user.guest) return reply.code(401).send({ error: 'Sign in required' });
      if (req.method === 'GET' || req.method === 'HEAD') return;
      // A cross-site form cannot send JSON, and a cross-site fetch that does
      // needs a CORS preflight this server never answers.
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
        return reply.code(415).send({ error: 'Send the request as JSON' });
      }
    });

    acc.get('/api/account/export', async (req, reply) => {
      const user = reqUser(req)!;
      const key = clientKey(req, user.id);
      if (!exportGate.tryAcquire(key)) return reply.code(429).send({ error: 'Your export is still being prepared. Wait for that download to finish.' });
      if (!(await exportLimiter.take(key))) {
        exportGate.release(key);
        return reply.code(429).header('retry-after', '600').send({ error: 'You exported your data a few times in a row. Try again in 10 minutes.' });
      }
      const zip = new ZipStream();
      let released = false;
      const release = () => { if (!released) { released = true; exportGate.release(key); } };
      zip.stream.once('close', release);
      const author = user.name ? (user.commitEmail ? { name: user.name, email: user.commitEmail } : user.name) : undefined;
      writeExport(user, zip, author).catch((err) => {
        if (!zip.closed) req.log.error({ err }, 'account export failed');
        zip.stream.destroy(err);
      }).finally(release);
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="aldine-export-${day}.zip"`)
        .header('cache-control', 'no-store')
        .send(zip.stream);
    });

    acc.get('/api/account/deletion', async (req) => {
      const user = reqUser(req)!;
      return deletionPreview(user, auth.sidFromRequest(req.headers.cookie));
    });

    acc.post<{ Body: { confirm?: unknown; password?: unknown } | undefined }>('/api/account/delete', async (req, reply) => {
      const user = reqUser(req)!;
      if (!(await loginLimiter.take(clientKey(req, user.id)))) return reply.code(429).send({ error: 'Too many attempts — wait a moment and try again' });
      const refused = selfDeleteRefusal(user);
      if (refused) return reply.code(403).send({ error: refused });
      const record = await db().getUser(user.id);
      if (!record) return reply.code(404).send({ error: 'There is no such account' });
      const expected = deleteConfirmation(record);
      const typed = req.body?.confirm;
      if (typeof typed !== 'string' || typed.trim().toLowerCase() !== expected.trim().toLowerCase()) {
        return reply.code(400).send({ error: `Type ${expected} to confirm.` });
      }
      try {
        await auth.confirmIdentity(record, auth.sidFromRequest(req.headers.cookie), req.body?.password);
      } catch (err: any) {
        if (err instanceof auth.ReauthRequiredError) return reply.code(403).send({ error: err.message, code: err.code });
        throw err;
      }
      const r = await removeAccount(record, 'delete');
      console.log(`[aldine] account ${who(user)} deleted itself (${count(r.deleted, 'project')} deleted, taken off ${count(r.sharesRemoved, 'share list')})`);
      reply.header('set-cookie', auth.clearCookie());
      return { ok: true, deleted: r.deleted, sharesRemoved: r.sharesRemoved };
    });
  });
}
