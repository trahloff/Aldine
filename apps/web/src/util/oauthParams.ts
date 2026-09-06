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
