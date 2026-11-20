import { ADMIN_EMAILS, AUTH_ENABLED, PublicUser, getUser } from './auth.js';
import { ProjectMeta } from './store.js';
import { normalizeEntry } from './invites.js';
import { linkRoleFor, rolesOf, widerRole, type ShareRole } from './sharelinks.js';

/**
 * Is this user a member of the project — its owner or someone the owner
 * invited by email (once the account confirmed it) or ORCID iD? Membership is the basis for listing and for anything
 * that reaches the owner's linked accounts (Zotero, GitHub remote): a link
 * grants entry to the document, it does not make the visitor part of the team.
 */
export function isMember(meta: ProjectMeta, user: PublicUser | null): boolean {
  if (!AUTH_ENABLED) return true;
  if (!meta.ownerId) return true;      // legacy project created before auth
  if (!user) return false;
  if (meta.ownerId === user.id) return true;
  return entriesOf(meta, user).length > 0;
}

/** The share entries that name this user. An address nobody confirmed is
 *  whatever the person typed at sign-up, so it names nobody. */
function entriesOf(meta: ProjectMeta, user: PublicUser): string[] {
  const email = user.emailPending ? undefined : user.email?.toLowerCase();
  return (meta.share?.collaborators ?? []).filter((c) => (email && c.toLowerCase() === email) || (user.orcid && c === user.orcid));
}

/** Members-only listing: what the Agent API's list_projects offers. A
 *  link-shared project must not surface for every signed-in user. */
export const isListed = isMember;

/**
 * What this user may do in the project, or null when they may not open it:
 * the widest of what the owner gave them by name (`share.roles`, "edit"
 * when absent) and what the project's active share links give them
 * (sharelinks.ts). Defined over isMember so the two can never drift.
 *   edit:   everything a member does.
 *   review: read, typeset, download, comment and suggest; change nothing.
 *   view:   read, typeset and download; no comments either.
 */
export function roleOf(meta: ProjectMeta, user: PublicUser | null, now = Date.now()): ShareRole | null {
  if (!AUTH_ENABLED || !meta.ownerId) return isMember(meta, user) ? 'edit' : null;
  if (!user) return null;
  if (meta.ownerId === user.id) return 'edit';
  const roles = rolesOf(meta);
  let best: ShareRole | null = null;
  for (const c of entriesOf(meta, user)) best = widerRole(best, roles[normalizeEntry(c)] ?? 'edit');
  return widerRole(best, linkRoleFor(meta, user.id, now));
}

/** May this user open this project? */
export function canAccess(meta: ProjectMeta, user: PublicUser | null): boolean {
  return roleOf(meta, user) !== null;
}

/**
 * May this user change the project: its files, branches, history and
 * settings? Only with the role "edit" (roleOf).
 */
export function canEdit(meta: ProjectMeta, user: PublicUser | null): boolean {
  return roleOf(meta, user) === 'edit';
}

/** May this user write review comments and suggestions? */
export function canComment(meta: ProjectMeta, user: PublicUser | null): boolean {
  const role = roleOf(meta, user);
  return role === 'edit' || role === 'review';
}

export type ListAccess = 'owner' | 'member' | 'link';

/**
 * Why the project is on this user's project list, or null when it is not.
 * `open` is the user's own row (ProjectOpen): a link visitor's project is
 * listed once they opened it, for as long as the link still lets them in, a
 * member's unless they removed it, and the owner's unless they archived it.
 */
export function listingAccess(meta: ProjectMeta, user: PublicUser | null, open: { hidden: boolean } | null): ListAccess | null {
  if (open?.hidden) return null;
  if (isOwner(meta, user)) return 'owner';
  if (isMember(meta, user)) return 'member';
  return open && canAccess(meta, user) ? 'link' : null;
}

/** Only the owner may change sharing / delete. Ownerless legacy projects
 *  (created before the operator enabled auth) have NO owner: they stay
 *  readable/editable for everyone (isMember), but manage-actions require
 *  claiming first (POST /:id/claim) — ownership is an explicit act, never
 *  an implicit free-for-all. */
export function isOwner(meta: ProjectMeta, user: PublicUser | null): boolean {
  if (!AUTH_ENABLED) return true;
  if (!meta.ownerId) return false;
  return !!user && meta.ownerId === user.id;
}

/**
 * Instance administrator: may read server-wide metadata (accounts, counts,
 * usage) and disable, reset or delete accounts. Deliberately NOT a superset
 * of canAccess — an admin sees that a project exists and who owns it, never
 * its content, unless they take it over: by giving a deleted account's
 * projects to themselves, or, on a server without email, with a reset link
 * for someone else's password (admin.ts). With auth off there is nobody to
 * distinguish, so the admin surface is open like everything else.
 */
export function isAdmin(user: PublicUser | null): boolean {
  if (!AUTH_ENABLED) return true;
  return !!user?.email && !user.emailPending && ADMIN_EMAILS.has(user.email.toLowerCase());
}

/** Resolve the owner's display name for listings (best-effort). A lookup
 *  failure must not fail the caller: the project list maps every project
 *  through this inside a Promise.all, where one rejection would 500 the whole
 *  list over a cosmetic field. */
export async function ownerName(meta: ProjectMeta): Promise<string | undefined> {
  if (!meta.ownerId) return undefined;
  return (await getUser(meta.ownerId).catch(() => null))?.name;
}
