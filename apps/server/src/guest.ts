import crypto from 'node:crypto';
import { COOKIE_PATH, SECURE_COOKIES, parseCookies, type PublicUser } from './auth.js';
import type { ProjectMeta, ShareLink } from './db/types.js';
import { subkey } from './output-signing.js';
import { GUEST_ID_PREFIX, linkActive, linksOf } from './sharelinks.js';
import { readMeta } from './store.js';

/**
 * Guests: people without an account, let into one project by a share link
 * that admits guests. A guest is a member entry on that link (`guest:<random>`
 * with the name they gave) and an entry in this browser's guest cookie,
 * signed for (project, link, guest). The cookie names no account and is
 * never read as a session: it is consulted only for its own project's
 * routes and collab documents, and only while the link is active, still
 * admits guests and still lists the guest. Revoking, expiring or closing
 * the link to guests therefore ends every guest session through it.
 */
export const GUEST_COOKIE = 'aldine_guest';
export const GUEST_NAME_MAX = 60;
/** Sliding: a guest who stays away this long opens the link again. */
const GUEST_DAYS = 30;
const DAY_MS = 86400000;
/** The day the cookie was last set, leading its value, so a guest's
 *  requests renew it at most once a day. Unsigned: it moves only the renewal. */
const STAMP_RE = /^d(\d{1,8})$/;
/** Projects one browser is a guest in at once; the oldest entry drops out. */
const MAX_ENTRIES = 10;
const ENTRY_RE = /^([a-z0-9]{4,20})\.([0-9a-f]{16})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;

export const newGuestId = () => `${GUEST_ID_PREFIX}${crypto.randomBytes(12).toString('base64url')}`;

/** A name as a guest typed it, or null when it is empty or too long.
 *  Control and bidirectional-override characters become spaces, the name
 *  being shown to the other people in the project, and so do < and >, which
 *  would end the name in a commit's author line. */
export function cleanGuestName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return name && name.length <= GUEST_NAME_MAX ? name : null;
}

/** How everyone else sees a guest: on cursors, comments and commits. The
 *  suffix keeps a guest from passing as an account of the same name. */
export const guestDisplayName = (name: string) => `${name} (guest)`;

export interface GuestEntry { projectId: string; linkId: string; guestId: string; raw: string }

function signature(projectId: string, linkId: string, guestId: string): string {
  return crypto.createHmac('sha256', subkey('guest-session')).update(JSON.stringify([projectId, linkId, guestId])).digest('base64url');
}

/** The cookie's entries whose signature verifies. */
function entries(cookieHeader: string | undefined): GuestEntry[] {
  const raw = parseCookies(cookieHeader)[GUEST_COOKIE];
  if (!raw) return [];
  const out: GuestEntry[] = [];
  for (const part of raw.split('~').filter((p) => !STAMP_RE.test(p)).slice(0, MAX_ENTRIES)) {
    const m = ENTRY_RE.exec(part);
    if (!m) continue;
    const guestId = GUEST_ID_PREFIX + m[3];
    const want = Buffer.from(signature(m[1], m[2], guestId));
    const got = Buffer.from(m[4]);
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) out.push({ projectId: m[1], linkId: m[2], guestId, raw: part });
  }
  return out;
}

/** This browser's guest entry for `projectId`, if it has a valid one. */
export function guestEntry(cookieHeader: string | undefined, projectId: string): GuestEntry | null {
  return entries(cookieHeader).find((e) => e.projectId === projectId) ?? null;
}

/** The guest `entry` names in `meta`, while its link still lets them in. */
export function guestIn(meta: ProjectMeta, entry: GuestEntry, now = Date.now()): { user: PublicUser; link: ShareLink } | null {
  if (meta.id !== entry.projectId || meta.deletedAt) return null;
  const link = linksOf(meta).find((l) => l.id === entry.linkId);
  if (!link?.token || !link.guests || !linkActive(link, now)) return null;
  const member = link.members?.find((m) => m.id === entry.guestId);
  if (!member) return null;
  return { user: { id: member.id, email: null, name: guestDisplayName(member.name || 'Guest'), guest: true }, link };
}

/**
 * The guest a request without a session is, on project `projectId`: the
 * guest, 'ended' when the browser was a guest there but the link no longer
 * lets them in (so the editor can say so), or null when it never was.
 */
export async function guestFromRequest(cookieHeader: string | undefined, projectId: string): Promise<PublicUser | 'ended' | null> {
  const entry = guestEntry(cookieHeader, projectId);
  if (!entry) return null;
  let meta: ProjectMeta;
  try { meta = await readMeta(projectId); } catch { return 'ended'; }
  return guestIn(meta, entry)?.user ?? 'ended';
}

/** Set-Cookie for entries `raw`, or one that clears the cookie when there are none. */
function cookieOf(raw: string[], now = Date.now()): string {
  if (!raw.length) return clearGuestCookie();
  const value = [`d${Math.floor(now / DAY_MS)}`, ...raw.slice(0, MAX_ENTRIES)].join('~');
  return `${GUEST_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${GUEST_DAYS * 86400}${SECURE_COOKIES ? '; Secure' : ''}`;
}

export function clearGuestCookie(): string {
  return `${GUEST_COOKIE}=; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0${SECURE_COOKIES ? '; Secure' : ''}`;
}

/** Set-Cookie for a guest who just came in: their entry first, the
 *  browser's entries for other projects after it. */
export function guestCookie(cookieHeader: string | undefined, projectId: string, linkId: string, guestId: string): string {
  const fresh = `${projectId}.${linkId}.${guestId.slice(GUEST_ID_PREFIX.length)}.${signature(projectId, linkId, guestId)}`;
  return cookieOf([fresh, ...entries(cookieHeader).filter((e) => e.projectId !== projectId).map((e) => e.raw)]);
}

/** Set-Cookie for this browser's guest cookie without its entry for
 *  `projectId`: cleared when that was the last one. */
export function guestCookieWithout(cookieHeader: string | undefined, projectId: string): string {
  return cookieOf(entries(cookieHeader).filter((e) => e.projectId !== projectId).map((e) => e.raw));
}

/** Set-Cookie renewing the guest cookie for another GUEST_DAYS, or null
 *  when it was set today already. For a request a valid entry let in. */
export function guestRenewal(cookieHeader: string | undefined, now = Date.now()): string | null {
  const raw = parseCookies(cookieHeader)[GUEST_COOKIE];
  if (!raw) return null;
  const stamp = STAMP_RE.exec(raw.split('~')[0]);
  if (stamp && Number(stamp[1]) >= Math.floor(now / DAY_MS)) return null;
  const kept = entries(cookieHeader).map((e) => e.raw);
  return kept.length ? cookieOf(kept, now) : null;
}
