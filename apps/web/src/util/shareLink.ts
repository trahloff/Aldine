import { safeSession, type SafeStore } from './safeStorage';

/** A share link's token waits here from the moment its page opens until the
 *  server has let the account in: through a sign-in, an SSO round trip
 *  included, in the same tab. */
const key = (projectId: string) => `aldine.shareLink.${projectId}`;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Keep the `link` token of the page's query, if it has one. Returns the
 *  query without it, or null when there was none. */
export function keepShareLink(projectId: string, search: string, store: SafeStore = safeSession): string | null {
  const params = new URLSearchParams(search);
  const token = params.get('link');
  if (token === null) return null;
  if (TOKEN_RE.test(token)) store.set(key(projectId), token);
  params.delete('link');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

export function pendingShareLink(projectId: string, store: SafeStore = safeSession): string | null {
  const token = store.get(key(projectId));
  return token && TOKEN_RE.test(token) ? token : null;
}

export function forgetShareLink(projectId: string, store: SafeStore = safeSession): void {
  store.remove(key(projectId));
}
