import type { SafeStore } from './safeStorage';

/** A sign-in started longer ago than this was abandoned, not finished. */
export const RESUME_MAX_AGE_MS = 30 * 60_000;

/** A sign-in starts on the page `path`: an SSO provider's callback always
 *  lands on "/", and Home brings the person back to `path` from there. A
 *  path `valid` refuses clears the entry instead. */
export function writeResume(store: SafeStore, key: string, path: string, valid: RegExp, now: number): void {
  if (valid.test(path)) store.setJSON(key, { path, at: now });
  else store.remove(key);
}

/** The page to return to after signing in, once: the entry is gone after
 *  this call whatever it held, and it counts only for a path `valid`
 *  accepts and for RESUME_MAX_AGE_MS after it was written. */
export function takeResume(store: SafeStore, key: string, valid: RegExp, now: number): string | null {
  const entry = store.getJSON<unknown>(key, null);
  store.remove(key);
  if (!entry || typeof entry !== 'object') return null;
  const { path, at } = entry as { path?: unknown; at?: unknown };
  if (typeof path !== 'string' || !valid.test(path) || typeof at !== 'number') return null;
  const age = now - at;
  return age >= 0 && age <= RESUME_MAX_AGE_MS ? path : null;
}
