import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
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

/**
 * Spend the share link waiting for project `projectId` before anything of
 * the project loads: each of the editor's first requests would be refused
 * until the server has let this account in. `problem` says why a link no
 * longer works; a link the server could not answer for stays for next time.
 * A guest (`asGuest`) is in already: the link has nothing more to give.
 */
export function useShareLinkJoin(projectId: string, asGuest = false): { ready: boolean; problem?: string } {
  const [state, setState] = useState<{ ready: boolean; problem?: string }>(() => ({ ready: asGuest || !pendingShareLink(projectId) }));
  useEffect(() => {
    const token = pendingShareLink(projectId);
    if (asGuest) forgetShareLink(projectId);
    if (!token || asGuest) { setState({ ready: true }); return; }
    let live = true;
    api.joinShareLink(projectId, token).then(
      () => { forgetShareLink(projectId); if (live) setState({ ready: true }); },
      (err: unknown) => {
        const gone = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;
        if (gone) forgetShareLink(projectId);
        if (live) setState({ ready: true, ...(gone ? { problem: (err as Error).message } : {}) });
      },
    );
    return () => { live = false; };
  }, [projectId, asGuest]);
  return state;
}
