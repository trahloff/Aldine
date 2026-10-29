import { safeSession, type SafeStore } from './safeStorage';
import { RESUME_MAX_AGE_MS, takeResume, writeResume } from './signInResume';

/**
 * The authorize request arrives as a query string and goes back to the server
 * verbatim in the consent POST: the server re-validates every parameter, so
 * nothing is interpreted here beyond picking out what the page displays.
 */
export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  /** Every query parameter, relayed unchanged (state, code_challenge, resource …). */
  all: Record<string, string>;
}

export function readAuthorizeParams(search: string): AuthorizeParams {
  const q = new URLSearchParams(search);
  const all: Record<string, string> = {};
  // A repeated key is a malformed request; the last value wins here and the
  // server rejects whatever does not validate.
  q.forEach((v, k) => { all[k] = v; });
  return { clientId: all.client_id ?? '', redirectUri: all.redirect_uri ?? '', all };
}

/** Body for POST /api/oauth/consent — the relayed params plus the decision. */
export function consentBody(params: AuthorizeParams, decision: 'allow' | 'deny', projectIds: string[] | null) {
  return { ...params.all, decision, projectIds: decision === 'allow' ? projectIds : null };
}

/** Where a signed-out user resumes after signing in through an SSO provider,
 *  whose callback always lands on "/". */
export const OAUTH_RESUME_KEY = 'aldine.oauth.resume';
export const OAUTH_RESUME_MAX_AGE_MS = RESUME_MAX_AGE_MS;
/** The consent page of this app with its query string, so nothing stored
 *  here can lead off the app or elsewhere in it. */
const AUTHORIZE_PATH_RE = /^\/oauth\/authorize\?[^#\s]*$/;

/** A sign-in starts on the consent page for the authorize request `search`
 *  (its query string): bring it back there. */
export function rememberOAuthResume(search: string, store: SafeStore = safeSession, now = Date.now()): void {
  writeResume(store, OAUTH_RESUME_KEY, `/oauth/authorize${search}`, AUTHORIZE_PATH_RE, now);
}

/** A sign-in starts anywhere else: whatever the consent page left behind
 *  belongs to a sign-in that was abandoned. */
export function forgetOAuthResume(store: SafeStore = safeSession): void {
  store.remove(OAUTH_RESUME_KEY);
}

/** The consent page to return to after signing in, once, and only within
 *  OAUTH_RESUME_MAX_AGE_MS of the sign-in starting there. */
export function takeOAuthResume(store: SafeStore = safeSession, now = Date.now()): string | null {
  return takeResume(store, OAUTH_RESUME_KEY, AUTHORIZE_PATH_RE, now);
}
