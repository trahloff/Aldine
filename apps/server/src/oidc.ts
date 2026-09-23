import crypto from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import type { OAuthProfile, OAuthProvider } from './oauth.js';

/**
 * Generic OpenID Connect sign-in (Keycloak, Authentik, Authelia, Pocket ID,
 * any compliant IdP): authorization code flow with PKCE S256, state and
 * nonce; the ID token is verified with jose against the issuer's JWKS.
 * Configuration is env-only and read on every call, so nothing here runs
 * until someone signs in — an IdP that is down at boot costs nothing.
 *
 * The account subject is `oidc:<issuer digest>:<sub>`: `sub` is unique only
 * per issuer, so pointing OIDC_ISSUER elsewhere must never land a person in
 * an account that belongs to someone else's `sub` at the old IdP.
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  label: string;
  scopes: string;
  allowedGroups: string[];
  groupsClaim: string;
  trustEmail: boolean;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export const DEFAULT_LABEL = 'Single sign-on';
const DISCOVERY_TIMEOUT_MS = 5_000;
const TOKEN_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** A failed discovery is retried after this, so an outage does not turn every click into a 5 s wait. */
const DISCOVERY_RETRY_MS = 15_000;
/** Seconds of clock skew tolerated on exp/iat/nbf. */
const CLOCK_SKEW_S = 60;
/** An ID token older than this at the callback was not minted for this exchange. */
const MAX_ID_TOKEN_AGE_S = 10 * 60;
/** Asymmetric JWS algorithms only: an HMAC alg would let the public JWKS double as a shared secret. */
const ASYMMETRIC_ALGS = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA', 'Ed25519']);

export function oidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  const scopes = new Set((env.OIDC_SCOPES || 'openid email profile').split(/[\s,]+/).filter(Boolean));
  scopes.add('openid');
  return {
    issuer,
    clientId,
    clientSecret: env.OIDC_CLIENT_SECRET || null,
    label: (env.OIDC_LABEL || '').trim().slice(0, 60) || DEFAULT_LABEL,
    scopes: ['openid', ...[...scopes].filter((s) => s !== 'openid')].join(' '),
    allowedGroups: (env.OIDC_ALLOWED_GROUPS || '').split(',').map((g) => g.trim()).filter(Boolean),
    groupsClaim: env.OIDC_GROUPS_CLAIM?.trim() || 'groups',
    trustEmail: (env.OIDC_EMAIL_VERIFIED || 'require').trim().toLowerCase() === 'trust',
  };
}

/**
 * Boot warnings for a configuration that would otherwise be ignored without a
 * trace: one of the two required variables missing (a typo such as
 * OIDC_CLIENTID, or a line left commented out), or an OIDC_EMAIL_VERIFIED
 * value that silently means `require`. Names variables, never their values,
 * except for OIDC_EMAIL_VERIFIED.
 */
export function oidcConfigWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const present = Object.keys(env).filter((k) => k.startsWith('OIDC_') && env[k]?.trim()).sort();
  if (!present.length) return [];
  const out: string[] = [];
  const missing = ['OIDC_ISSUER', 'OIDC_CLIENT_ID'].filter((k) => !present.includes(k));
  if (missing.length) out.push(`[aldine] OIDC sign-in is off: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set (found ${present.join(', ')})`);
  const ev = env.OIDC_EMAIL_VERIFIED?.trim().toLowerCase();
  if (ev && ev !== 'require' && ev !== 'trust') out.push(`[aldine] OIDC_EMAIL_VERIFIED=${JSON.stringify(env.OIDC_EMAIL_VERIFIED!.trim().slice(0, 40))} is neither "require" nor "trust"; using "require"`);
  return out;
}

const TLS_CODE = /^(CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH$)/;
const DNS_CODE = /^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/;

/** The system error code behind a failed fetch (undici hides it in `cause`, sometimes inside an AggregateError). */
function causeCode(err: any): string | undefined {
  const c = err?.cause ?? err;
  return c?.code ?? c?.errors?.find?.((e: any) => e?.code)?.code;
}

/**
 * Why a fetch to the IdP failed, as the end of a sentence ("the identity
 * provider at X …"). A certificate or name problem is a configuration fault
 * the operator must fix, so only transient failures say "try again later".
 */
export function describeFetchError(err: unknown, timeoutMs: number): string {
  const e = err as any;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `did not answer within ${Math.round(timeoutMs / 1000)} seconds — try again later`;
  const code = causeCode(e);
  if (code && TLS_CODE.test(code)) return `presented a TLS certificate that is not trusted (${code}) — if it uses a private CA, point NODE_EXTRA_CA_CERTS at that CA's certificate`;
  if (code && DNS_CODE.test(code)) return `could not be found (${code}): its host name does not resolve from the Aldine server`;
  if (/redirect/i.test(String(e?.cause?.message ?? ''))) return 'answered with a redirect — use the final URL';
  const detail = code ?? (typeof e?.cause?.message === 'string' ? e.cause.message.slice(0, 80) : '');
  return `could not be reached${detail ? ` (${detail})` : ''} — try again later`;
}

/** The boot log line: issuer, client and client type — never the secret. */
export function oidcBootLine(env: NodeJS.ProcessEnv = process.env): string | null {
  const c = oidcConfig(env);
  if (!c) return null;
  const groups = c.allowedGroups.length ? ` groups=${c.allowedGroups.join(',')}` : '';
  return `[aldine] OIDC sign-in: issuer=${c.issuer} client=${c.clientId} (${c.clientSecret ? 'confidential' : 'public, PKCE only'})${groups}`;
}

/** Stable, issuer-bound account subject for an ID token's (iss, sub). */
export function oidcSubject(iss: string, sub: string): string {
  const digest = crypto.createHash('sha256').update(iss).digest('base64url').slice(0, 16);
  return `oidc:${digest}:${sub}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (raw: string) => { try { return LOOPBACK.has(new URL(raw).hostname); } catch { return false; } };
/**
 * https, or plain http to this machine when the issuer itself is on this
 * machine (a local IdP, the test suites). A remote issuer's discovery document
 * must not steer the code, the client secret or the access token to a
 * plaintext port on the Aldine host.
 */
export function checkUrl(raw: unknown, what: string, allowLoopbackHttp: boolean): string {
  if (typeof raw !== 'string' || !raw) throw new Error(`the identity provider's discovery document has no ${what}`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`the identity provider's ${what} is not a URL`); }
  if (u.protocol !== 'https:' && !(allowLoopbackHttp && u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new Error(`the identity provider's ${what} must use https`);
  }
  return u.href;
}

/** IdP answers are small JSON documents; a larger body is refused unread. */
const MAX_IDP_BODY_BYTES = 1024 * 1024;
async function readCapped(res: Response): Promise<Buffer> {
  if (Number(res.headers.get('content-length')) > MAX_IDP_BODY_BYTES) throw new Error('the response is larger than 1 MB');
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IDP_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new Error('the response is larger than 1 MB'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function readJson(res: Response): Promise<unknown> {
  return JSON.parse((await readCapped(res)).toString('utf8'));
}

interface CacheEntry { key: string; value?: Discovery; valueAt: number; error?: Error; errorAt: number; pending?: Promise<Discovery> }
let cached: CacheEntry | null = null;
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Drops cached discovery and keys; tests switch IdPs between cases. */
export function resetOidcCache(): void {
  cached = null;
  jwksCache.clear();
}

async function fetchDiscovery(issuer: string): Promise<Discovery> {
  const local = isLoopback(issuer);
  checkUrl(issuer, 'issuer URL', local);
  // OpenID Connect Discovery §4: the well-known suffix goes after the issuer's
  // path, so https://idp/application/o/aldine/ keeps its path.
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), redirect: 'error' });
  } catch (err) {
    throw new Error(`the identity provider at ${issuer} ${describeFetchError(err, DISCOVERY_TIMEOUT_MS)}`);
  }
  if (!res.ok) throw new Error(`the identity provider at ${issuer} answered ${res.status} for its discovery document`);
  let doc: Partial<Discovery>;
  try { doc = (await readJson(res)) as Partial<Discovery>; } catch { throw new Error(`the identity provider at ${issuer} did not return a discovery document`); }
  // §4.3: the document's issuer must be the one we asked. A lone trailing
  // slash is forgiven in the env value; ID tokens are then checked against
  // the issuer exactly as the IdP spells it.
  if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
    throw new Error(`the discovery document names issuer ${JSON.stringify(doc.issuer)}, not ${issuer} — check OIDC_ISSUER`);
  }
  return {
    issuer: doc.issuer,
    authorization_endpoint: checkUrl(doc.authorization_endpoint, 'authorization endpoint', local),
    token_endpoint: checkUrl(doc.token_endpoint, 'token endpoint', local),
    jwks_uri: checkUrl(doc.jwks_uri, 'JWKS URI', local),
    userinfo_endpoint: doc.userinfo_endpoint ? checkUrl(doc.userinfo_endpoint, 'userinfo endpoint', local) : undefined,
    id_token_signing_alg_values_supported: Array.isArray(doc.id_token_signing_alg_values_supported) ? doc.id_token_signing_alg_values_supported : undefined,
    token_endpoint_auth_methods_supported: Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : undefined,
    authorization_response_iss_parameter_supported: doc.authorization_response_iss_parameter_supported === true,
  };
}

/**
 * The issuer's discovery document, cached for an hour. Once a document has
 * been fetched it keeps being served while a refresh is under way or has
 * failed (retried every DISCOVERY_RETRY_MS), so an IdP restart around the
 * hourly refresh does not break sign-ins whose endpoints still work.
 */
export async function discover(issuer: string): Promise<Discovery> {
  const now = Date.now();
  let entry = cached?.key === issuer ? cached : null;
  if (entry?.value && now - entry.valueAt < DISCOVERY_TTL_MS) return entry.value;
  if (entry?.pending) return entry.value ?? entry.pending;
  if (entry?.error && now - entry.errorAt < DISCOVERY_RETRY_MS) {
    if (entry.value) return entry.value;
    throw entry.error;
  }
  if (!entry) cached = entry = { key: issuer, valueAt: 0, errorAt: 0 };
  const e = entry;
  e.pending = fetchDiscovery(issuer).then(
    (value) => { e.value = value; e.valueAt = Date.now(); e.error = undefined; e.pending = undefined; return value; },
    (error: Error) => { e.error = error; e.errorAt = Date.now(); e.pending = undefined; throw error; },
  );
  if (e.value) {
    e.pending.catch((err: Error) => console.warn(`[aldine] OIDC discovery refresh failed, still using the last good document: ${err.message}`));
    return e.value;
  }
  return e.pending;
}

function jwks(uri: string) {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri), {
      timeoutDuration: DISCOVERY_TIMEOUT_MS,
      [customFetch]: async (url, init) => {
        const res = await fetch(url, init);
        return new Response(new Uint8Array(await readCapped(res)), { status: res.status, headers: res.headers });
      },
    });
    jwksCache.set(uri, set);
  }
  return set;
}

function signingAlgs(d: Discovery): string[] {
  // Core §3.1.3.7: RS256 is the default when the IdP does not say.
  const advertised = d.id_token_signing_alg_values_supported ?? ['RS256'];
  const algs = advertised.filter((a) => ASYMMETRIC_ALGS.has(a));
  if (!algs.length) throw new Error('the identity provider signs ID tokens only with algorithms Aldine does not accept (use RS256 or ES256)');
  return algs;
}

/** Verifies an ID token's signature and claims; returns its payload. */
export async function verifyIdToken(idToken: string, d: Discovery, clientId: string, nonce: string): Promise<JWTPayload> {
  const algorithms = signingAlgs(d);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks(d.jwks_uri), {
      issuer: d.issuer,
      audience: clientId,
      algorithms,
      clockTolerance: CLOCK_SKEW_S,
      maxTokenAge: MAX_ID_TOKEN_AGE_S,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new Error(`the ID token has expired (${err.claim} claim) — check that the clocks of Aldine and the identity provider agree`);
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      if (err.reason === 'missing') throw new Error(`the ID token has no ${err.claim} claim`);
      if (err.claim === 'iat' || err.claim === 'nbf') throw new Error(`the ID token is dated in the future (${err.claim} claim) — check that the clocks of Aldine and the identity provider agree`);
      throw new Error(`the ID token was rejected (${err.claim} claim)`);
    }
    // jose reports an unreachable, slow or non-200 JWKS endpoint as these, and a network failure as a plain TypeError.
    if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid
      || (err instanceof joseErrors.JOSEError && err.code === 'ERR_JOSE_GENERIC' && /JSON Web Key Set/.test(err.message))
      || !(err instanceof joseErrors.JOSEError)) {
      const why = err instanceof joseErrors.JWKSTimeout ? `it did not answer within ${DISCOVERY_TIMEOUT_MS / 1000} seconds`
        : err instanceof joseErrors.JOSEError ? err.message.replace(/\.$/, '')
        : describeFetchError(err, DISCOVERY_TIMEOUT_MS).replace(/ — try again later$/, '');
      throw new Error(`the identity provider's signing keys could not be fetched from ${d.jwks_uri} (${why}) — try again later`);
    }
    throw new Error('the ID token signature could not be verified');
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  // Core §3.1.3.7 steps 4–5: with several audiences the token must name us as its authorized party.
  if (payload.azp !== undefined && payload.azp !== clientId) throw new Error('the ID token was rejected (azp claim)');
  if (aud.length > 1 && payload.azp === undefined) throw new Error('the ID token was rejected (azp claim)');
  if (typeof payload.nonce !== 'string' || !timingSafeEqualStr(payload.nonce, nonce)) throw new Error('the ID token was rejected (nonce claim)');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new Error('the ID token was rejected (sub claim)');
  return payload;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The groups claim as a list; an IdP may send one group as a bare string. */
export function groupsOf(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((g): g is string => typeof g === 'string');
  return null;
}

type Claims = Record<string, unknown>;

async function userinfo(d: Discovery, accessToken: string | undefined, sub: string): Promise<Claims | null> {
  if (!d.userinfo_endpoint || !accessToken) return null;
  try {
    const res = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), redirect: 'error' });
    // A signed (application/jwt) userinfo response is not read; the ID token carries what it would.
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    const body = (await readJson(res)) as Claims;
    // Core §5.3.2: a userinfo response for another subject must not be used.
    return body && typeof body === 'object' && body.sub === sub ? body : null;
  } catch (err) {
    console.warn(`[aldine] OIDC userinfo request to ${d.userinfo_endpoint} failed: the endpoint ${describeFetchError(err, DISCOVERY_TIMEOUT_MS)}`);
    return null;
  }
}

function tokenAuth(c: OidcConfig, d: Discovery): 'none' | 'client_secret_basic' | 'client_secret_post' {
  if (!c.clientSecret) return 'none';
  const methods = d.token_endpoint_auth_methods_supported;
  if (methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) return 'client_secret_post';
  return 'client_secret_basic';
}

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

/** Decides the profile from verified ID token claims plus (optional) userinfo. Exported for tests. */
export function profileFrom(idClaims: Claims, info: Claims | null, c: OidcConfig): OAuthProfile {
  const sub = idClaims.sub as string;
  const iss = idClaims.iss as string;
  // email and email_verified are read as a pair from one source, so an
  // unverified userinfo address can never borrow the ID token's verdict.
  const src = typeof idClaims.email === 'string' ? idClaims : info && typeof info.email === 'string' ? info : null;
  const rawEmail = src ? clean(src.email, 254) : '';
  const verified = !!src && (src.email_verified === true || c.trustEmail);
  const email = verified && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail) ? rawEmail : null;
  const pick = (k: string) => clean(idClaims[k], 100) || clean(info?.[k], 100);
  const name = pick('name') || pick('preferred_username') || (email ? email.split('@')[0] : '') || sub.slice(0, 100);
  return { email, name, subject: oidcSubject(iss, sub) };
}

/** Throws the sign-in refusal when OIDC_ALLOWED_GROUPS is set and the person is in none of them. */
export function checkGroups(idClaims: Claims, info: Claims | null, c: OidcConfig): void {
  if (!c.allowedGroups.length) return;
  const groups = groupsOf(idClaims[c.groupsClaim]) ?? groupsOf(info?.[c.groupsClaim]) ?? [];
  if (!groups.some((g) => c.allowedGroups.includes(g))) {
    throw new Error('your account is not in a group that may use this Aldine instance — ask the administrator for access');
  }
}

export const oidc: OAuthProvider = {
  id: 'oidc',
  get label() { return oidcConfig()?.label ?? DEFAULT_LABEL; },
  configured: () => oidcConfig() !== null,
  async authorizeUrl(state, redirectUri, attempt) {
    const c = oidcConfig()!;
    const d = await discover(c.issuer);
    signingAlgs(d);
    const u = new URL(d.authorization_endpoint);
    const p = u.searchParams;
    p.set('response_type', 'code');
    p.set('client_id', c.clientId);
    p.set('redirect_uri', redirectUri);
    p.set('scope', c.scopes);
    p.set('state', state);
    p.set('nonce', attempt.nonce);
    p.set('code_challenge', attempt.challenge);
    p.set('code_challenge_method', 'S256');
    return u.href;
  },
  async exchange(code, redirectUri, attempt, callback) {
    const c = oidcConfig()!;
    const d = await discover(c.issuer);
    // RFC 9207: an IdP that names itself in the response must name the one we sent the person to.
    const iss = callback?.get('iss');
    if (iss != null && iss !== d.issuer) throw new Error('the response came from a different identity provider');
    // RFC 9207 §2.4: an IdP that advertises the parameter must send it.
    if (iss == null && d.authorization_response_iss_parameter_supported) throw new Error('the response did not name its identity provider (iss parameter missing)');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: attempt.verifier });
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    const method = tokenAuth(c, d);
    if (method === 'client_secret_basic') {
      // RFC 6749 §2.3.1: both halves are form-encoded before base64.
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
      headers.authorization = `Basic ${Buffer.from(`${enc(c.clientId)}:${enc(c.clientSecret!)}`).toString('base64')}`;
    } else {
      body.set('client_id', c.clientId);
      if (method === 'client_secret_post') body.set('client_secret', c.clientSecret!);
    }
    let tok: { id_token?: unknown; access_token?: unknown; error?: unknown; error_description?: unknown };
    let res: Response;
    try {
      res = await fetch(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS), redirect: 'error' });
    } catch (err) {
      console.warn(`[aldine] OIDC token request to ${d.token_endpoint} failed: the endpoint ${describeFetchError(err, TOKEN_TIMEOUT_MS)}`);
      throw new Error(`the identity provider did not answer the token request: it ${describeFetchError(err, TOKEN_TIMEOUT_MS)}`);
    }
    try {
      tok = (await readJson(res)) as typeof tok;
    } catch {
      throw new Error(`the identity provider answered the token request with ${res.status} and no JSON — try again later`);
    }
    if (typeof tok.id_token !== 'string') {
      const why = clean(tok.error_description, 200) || clean(tok.error, 100);
      throw new Error(why ? `the identity provider refused the sign-in (${why})` : 'the identity provider returned no ID token');
    }
    const claims = (await verifyIdToken(tok.id_token, d, c.clientId, attempt.nonce)) as Claims;
    const access = typeof tok.access_token === 'string' ? tok.access_token : undefined;
    const needsInfo = typeof claims.email !== 'string'
      || (!claims.name && !claims.preferred_username)
      || (c.allowedGroups.length > 0 && groupsOf(claims[c.groupsClaim]) === null);
    const info = needsInfo ? await userinfo(d, access, claims.sub as string) : null;
    checkGroups(claims, info, c);
    return profileFrom(claims, info, c);
  },
};
