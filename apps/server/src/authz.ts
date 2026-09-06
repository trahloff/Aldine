import { AUTH_ENABLED, PublicUser, getUser } from './auth.js';
import { ProjectMeta } from './store.js';

/**
 * Is this user a member of the project — its owner or someone the owner
 * invited by email or ORCID iD? Membership is the basis for both listing and for anything
 * that reaches the owner's linked accounts (Zotero, GitHub remote): a link
 * grants entry to the document, it does not make the visitor part of the team.
 * Also the listing predicate — a link-shared project opens by URL but must not
 * surface on every signed-in user's home screen.
 */
export function isMember(meta: ProjectMeta, user: PublicUser | null): boolean {
  if (!AUTH_ENABLED) return true;
  if (!meta.ownerId) return true;      // legacy project created before auth
  if (!user) return false;
  if (meta.ownerId === user.id) return true;
  const email = user.email?.toLowerCase();
  return !!meta.share?.collaborators?.some((c) => (email && c.toLowerCase() === email) || (user.orcid && c === user.orcid));
}

/** Should this project appear in the user's project list? Members only. */
export const isListed = isMember;

/**
 * May this user open/edit this project? Membership, plus the link-mode grant.
 * Defined in terms of isMember so the two can never drift — a new membership
 * channel added to isMember is honoured by listing and access alike.
 */
export function canAccess(meta: ProjectMeta, user: PublicUser | null): boolean {
  if (isMember(meta, user)) return true;
  return !!user && meta.share?.mode === 'link';
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

/** Resolve the owner's display name for listings (best-effort). A lookup
 *  failure must not fail the caller: the project list maps every project
 *  through this inside a Promise.all, where one rejection would 500 the whole
 *  list over a cosmetic field. */
export async function ownerName(meta: ProjectMeta): Promise<string | undefined> {
  if (!meta.ownerId) return undefined;
  return (await getUser(meta.ownerId).catch(() => null))?.name;
}
