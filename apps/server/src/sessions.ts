import type { DataStore, SessionRow } from './db/types.js';

/**
 * How long a sign-in lasts. A session lasts SESSION_DAYS from its last
 * renewal, and a request renews one last renewed more than a day before, but
 * never past SESSION_MAX_DAYS from the sign-in: then the person signs in
 * again. The day between renewals keeps browsing from writing the session
 * row on every request. The store is an argument so the conformance suite
 * runs this against every backend.
 */
export const SESSION_DAYS = 30;
export const SESSION_MAX_DAYS = 90;
const DAY_MS = 864e5;

/** The expiry of a session signed in at `now`. */
export const firstExpiry = (now: number) => now + SESSION_DAYS * DAY_MS;

/** The expiry `s` gets when used at `now`, or null when it is not due:
 *  expired, renewed within the last day, or at the cap. The last renewal is
 *  SESSION_DAYS before the expiry it set; when the cap cut that expiry
 *  short, no later one can be greater. */
export function renewal(s: SessionRow, now: number): number | null {
  if (s.exp < now) return null;
  const exp = Math.min(now + SESSION_DAYS * DAY_MS, s.createdAt + SESSION_MAX_DAYS * DAY_MS);
  const renewedAt = s.exp - SESSION_DAYS * DAY_MS;
  return exp > s.exp && now - renewedAt > DAY_MS ? exp : null;
}

/** Renew `s`, the row of `sid` as read for a request at `now`, when it is
 *  due. Returns the new expiry, or null when nothing was written: not due,
 *  or the session ended since it was read, which leaves it ended. */
export async function renewIfDue(store: DataStore, sid: string, s: SessionRow, now: number): Promise<number | null> {
  const exp = renewal(s, now);
  if (exp === null) return null;
  // A bookkeeping write never fails the request it rides on.
  return (await store.renewSession(sid, exp).catch(() => false)) ? exp : null;
}
