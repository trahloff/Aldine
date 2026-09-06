/**
 * OAuth sign-in providers (SSO). Each provider is gated on its client
 * id/secret env vars, so configuring one is purely deployment config. The flow
 * is the standard authorization-code grant with a CSRF `state` cookie; we only
 * ever trust a VERIFIED email from the provider, then find-or-create the user.
 * A provider that can vouch for a stable identity without an email (ORCID)
 * returns a `subject` instead; the account is then keyed by that.
 *
 * Add a provider by pushing another entry onto `providers`.
 */

export interface OAuthProfile {
  /** A verified address, or null when the provider has none to share. */
  email: string | null;
  name: string;
  /** Provider-scoped stable id (`orcid:0000-…`). Required when email is null. */
  subject?: string;
}

export interface OAuthProvider {
  id: string;
  label: string;
  configured(): boolean;
  /** URL to redirect the browser to, to begin sign-in. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchange the callback `code` for the user's verified profile. */
  exchange(code: string, redirectUri: string): Promise<OAuthProfile>;
}

const github: OAuthProvider = {
  id: 'github',
  label: 'GitHub',
  configured: () => !!(process.env.GITHUB_LOGIN_CLIENT_ID && process.env.GITHUB_LOGIN_CLIENT_SECRET),
  authorizeUrl(state, redirectUri) {
    const p = new URLSearchParams({
      client_id: process.env.GITHUB_LOGIN_CLIENT_ID!,
      scope: 'read:user user:email',
      state,
      redirect_uri: redirectUri,
    });
    return `https://github.com/login/oauth/authorize?${p}`;
  },
  async exchange(code, redirectUri) {
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_LOGIN_CLIENT_ID,
        client_secret: process.env.GITHUB_LOGIN_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tok = (await tokRes.json()) as { access_token?: string; error_description?: string };
    if (!tok.access_token) throw new Error(tok.error_description || 'no access token');
    const headers = { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'aldine' };
    const ghUser = (await (await fetch('https://api.github.com/user', { headers })).json()) as { login?: string; name?: string; email?: string };
    let email = ghUser.email;
    if (!email) {
      const emails = (await (await fetch('https://api.github.com/user/emails', { headers })).json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = (emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified))?.email;
    }
    if (!email) throw new Error('no verified email on the GitHub account');
    return { email, name: ghUser.name || ghUser.login || email.split('@')[0] };
  },
};

const google: OAuthProvider = {
  id: 'google',
  label: 'Google',
  configured: () => !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
  authorizeUrl(state, redirectUri) {
    const p = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  },
  async exchange(code, redirectUri) {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tok = (await tokRes.json()) as { access_token?: string; error_description?: string };
    if (!tok.access_token) throw new Error(tok.error_description || 'no access token');
    const info = (await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tok.access_token}` },
    })).json()) as { email?: string; email_verified?: boolean | string; name?: string };
    const verified = info.email_verified === true || info.email_verified === 'true';
    if (!info.email || !verified) throw new Error('no verified email on the Google account');
    return { email: info.email, name: info.name || info.email.split('@')[0] };
  },
};

/**
 * ORCID: the token response already carries the iD and name (scope
 * /authenticate); the address is fetched from the public API and is only
 * present when the researcher made it public, so most accounts arrive
 * without one. ORCID_SANDBOX=1 targets sandbox.orcid.org for testing; the
 * *_API_BASE overrides exist for the e2e stub.
 */
const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
function orcidBases() {
  const sandbox = process.env.ORCID_SANDBOX === '1';
  return {
    auth: process.env.ORCID_API_BASE || (sandbox ? 'https://sandbox.orcid.org' : 'https://orcid.org'),
    pub: process.env.ORCID_PUB_API_BASE || (sandbox ? 'https://pub.sandbox.orcid.org' : 'https://pub.orcid.org'),
  };
}
const orcid: OAuthProvider = {
  id: 'orcid',
  label: 'ORCID',
  configured: () => !!(process.env.ORCID_CLIENT_ID && process.env.ORCID_CLIENT_SECRET),
  authorizeUrl(state, redirectUri) {
    const p = new URLSearchParams({
      client_id: process.env.ORCID_CLIENT_ID!,
      response_type: 'code',
      scope: '/authenticate',
      redirect_uri: redirectUri,
      state,
    });
    return `${orcidBases().auth}/oauth/authorize?${p}`;
  },
  async exchange(code, redirectUri) {
    const bases = orcidBases();
    const tokRes = await fetch(`${bases.auth}/oauth/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.ORCID_CLIENT_ID!,
        client_secret: process.env.ORCID_CLIENT_SECRET!,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tok = (await tokRes.json()) as { access_token?: string; orcid?: string; name?: string; error_description?: string };
    if (!tok.access_token) throw new Error(tok.error_description || 'no access token');
    if (!tok.orcid || !ORCID_ID.test(tok.orcid)) throw new Error('no ORCID iD in the token response');
    let email: string | null = null;
    try {
      const res = await fetch(`${bases.pub}/v3.0/${tok.orcid}/email`, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const body = (await res.json()) as { email?: Array<{ email?: string; verified?: boolean; primary?: boolean }> };
        const list = (body.email || []).filter((e) => e.email && e.verified);
        email = (list.find((e) => e.primary) || list[0])?.email || null;
      }
    } catch { /* a public-API hiccup must not block sign-in: the iD is enough */ }
    return { email, name: (tok.name || '').trim() || tok.orcid, subject: `orcid:${tok.orcid}` };
  },
};

export const providers: OAuthProvider[] = [google, github, orcid];

export function configuredProviders(): OAuthProvider[] {
  return providers.filter((p) => p.configured());
}
export function getProvider(id: string): OAuthProvider | undefined {
  return providers.find((p) => p.id === id && p.configured());
}
