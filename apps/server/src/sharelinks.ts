import crypto from 'node:crypto';
import type { ProjectMeta, ShareLink, ShareRole } from './db/types.js';
import { normalizeEntry } from './invites.js';

export type { ShareLink, ShareRole } from './db/types.js';
type Share = NonNullable<ProjectMeta['share']>;

export const SHARE_ROLES: readonly ShareRole[] = ['edit', 'review', 'view'];
export const isShareRole = (r: unknown): r is ShareRole => typeof r === 'string' && (SHARE_ROLES as readonly string[]).includes(r);
const RANK: Record<ShareRole, number> = { view: 1, review: 2, edit: 3 };
/** The wider of two roles; null is no access. */
export const widerRole = (a: ShareRole | null, b: ShareRole | null): ShareRole | null => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);

/** The id of the link that link sharing before 1.17 is read as. */
export const ADDRESS_LINK_ID = 'address';
/** Active links a project may have at once, and links it keeps at all
 *  (revoked ones are dropped oldest first beyond it). */
export const MAX_ACTIVE_LINKS = 20;
export const MAX_STORED_LINKS = 100;
/** People one link lets in: the record of them rides in the project's metadata. */
export const MAX_LINK_MEMBERS = 500;
export const MAX_LINK_LABEL = 80;
/** 256 random bits, URL-safe. */
export const newLinkToken = () => crypto.randomBytes(32).toString('base64url');
export const newLinkId = () => crypto.randomBytes(8).toString('hex');
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const LINK_ID_RE = /^([0-9a-f]{16}|address)$/;

/**
 * The share as 1.17 stores it. A share written before has `mode`/`linkRole`
 * instead of `links`, and `viewers` instead of `roles`: link sharing becomes
 * one link without a token (the project's address keeps working), and an
 * entry that could "view" then could comment too, which is "review" now.
 * Pure and stable: reading the same old share twice gives the same links.
 */
export function normalizeShare(share: ProjectMeta['share'], createdAt: string): Share | undefined {
  if (!share) return share;
  if (share.links) {
    const { mode: _m, viewers: _v, linkRole: _l, ...rest } = share;
    return rest;
  }
  const { mode, viewers, linkRole, ...rest } = share;
  const roles: Record<string, 'review' | 'view'> = { ...(rest.roles ?? {}) };
  for (const v of viewers ?? []) roles[normalizeEntry(v)] = 'review';
  const links: ShareLink[] = mode === 'link' ? [{ id: ADDRESS_LINK_ID, role: linkRole === 'view' ? 'review' : 'edit', createdAt }] : [];
  return { ...rest, collaborators: rest.collaborators ?? [], ...(Object.keys(roles).length ? { roles } : {}), links };
}

/** `meta` with its share in the 1.17 shape (normalizeShare). */
export function normalizeMeta(meta: ProjectMeta): ProjectMeta {
  if (!meta.share) return meta;
  return { ...meta, share: normalizeShare(meta.share, meta.createdAt) };
}

export const linksOf = (meta: ProjectMeta): ShareLink[] => normalizeShare(meta.share, meta.createdAt)?.links ?? [];
export const rolesOf = (meta: ProjectMeta): Record<string, 'review' | 'view'> => normalizeShare(meta.share, meta.createdAt)?.roles ?? {};

export const linkExpired = (l: ShareLink, now = Date.now()) => !!l.expiresAt && Date.parse(l.expiresAt) <= now;
export const linkActive = (l: ShareLink, now = Date.now()) => !l.revokedAt && !linkExpired(l, now);

/** The link `token` opens, active or not. */
export function linkByToken(meta: ProjectMeta, token: string): ShareLink | undefined {
  const given = Buffer.from(token);
  return linksOf(meta).find((l) => {
    if (!l.token) return false;
    const stored = Buffer.from(l.token);
    return stored.length === given.length && crypto.timingSafeEqual(stored, given);
  });
}

/** The widest role the project's active links give account `userId`: the
 *  address link gives it to everyone signed in, a token link to the people
 *  who came in through it. */
export function linkRoleFor(meta: ProjectMeta, userId: string, now = Date.now()): ShareRole | null {
  let best: ShareRole | null = null;
  for (const l of linksOf(meta)) {
    if (!linkActive(l, now)) continue;
    if (!l.token || l.members?.some((m) => m.id === userId)) best = widerRole(best, l.role);
  }
  return best;
}

/** The first time one of the active links that let account `userId` in
 *  expires, in ms, or null when none of them has an expiry. */
export function linkAccessEnds(meta: ProjectMeta, userId: string, now = Date.now()): number | null {
  let first: number | null = null;
  for (const l of linksOf(meta)) {
    if (!l.expiresAt || !linkActive(l, now) || (l.token && !l.members?.some((m) => m.id === userId))) continue;
    const at = Date.parse(l.expiresAt);
    if (first === null || at < first) first = at;
  }
  return first;
}

/** Does some active link let people in? What `mode: 'link'` said before 1.17. */
export const anyActiveLink = (meta: ProjectMeta, now = Date.now()) => linksOf(meta).some((l) => linkActive(l, now));

/** `links` with the revoked ones beyond MAX_STORED_LINKS dropped, oldest first. */
export function pruneLinks(links: ShareLink[]): ShareLink[] {
  let extra = links.length - MAX_STORED_LINKS;
  if (extra <= 0) return links;
  return links.filter((l) => !(l.revokedAt && extra-- > 0));
}

/** What the owner's share dialog shows of a link: never who came in, only how many. */
export function ownerLinkView(l: ShareLink) {
  const { members, ...rest } = l;
  return { ...rest, joined: members?.length ?? 0 };
}
