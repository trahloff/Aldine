import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db/index.js';
import type { EmailPending, TokenRecord, User } from './db/types.js';
import { config } from './config.js';
import { providers, type OAuthProfile } from './oauth.js';
import { DEFAULT_LABEL as OIDC_DEFAULT_LABEL } from './oidc.js';
import { discardCodesForUser } from './oauth/codes.js';
import { subkey } from './output-signing.js';

/** A provider's name for use inside a sentence ("sign in with single sign-on"). */
const providerLabel = (id: string) => {
  const label = providers.find((p) => p.id === id)?.label ?? id;
  return label === OIDC_DEFAULT_LABEL ? label.toLowerCase() : label;
};

/**
 * Optional, env-gated auth (AUTH_ENABLED=1). When off, every request is
 * anonymous with full access and none of this runs — the single-tenant default.
 *
 * Persistence goes through the DataStore (JSON or Postgres); this module owns
 * only the security logic: scrypt hashing, revocable sessions, reset tokens,
 * and cookie shaping.
 */

export const AUTH_ENABLED = process.env.AUTH_ENABLED === '1' || process.env.AUTH_ENABLED === 'true';
/** SSO-only mode: disable all password endpoints (register/login/reset/change) — sign-in is exclusively via a configured OAuth provider. */
export const SSO_ONLY = process.env.ALDINE_SSO_ONLY === '1' || process.env.ALDINE_SSO_ONLY === 'true';
/**
 * Instance administrators, by email (ALDINE_ADMIN_EMAILS, comma-separated).
 * Env rather than a role column: the operator who controls the process
 * controls admin, there is no bootstrap problem on a fresh install, and it
 * needs no migration on either datastore. Compared case-insensitively.
 */
export const ADMIN_EMAILS = new Set(
  (process.env.ALDINE_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);
export const COOKIE = 'aldine_session';
// Scoped to the base path so a neighbouring app on the same host never sees it.
export const COOKIE_PATH = config.basePath || '/';
const SESSION_DAYS = 30;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
export const CONFIRM_TTL_DAYS = 7;

export type { User } from './db/types.js';
/** `emailPending` is present (true) only while a password sign-up has not
 *  confirmed its address; isMember and isAdmin then ignore the address. */
export interface PublicUser { id: string; email: string | null; name: string; provider?: string; orcid?: string; emailPending?: true }

/** Session and OAuth-state cookies get the Secure flag when the deployment is HTTPS. */
export const SECURE_COOKIES = (process.env.ALDINE_PUBLIC_URL || '').startsWith('https') || process.env.COOKIE_SECURE === '1';

export function pub(u: User): PublicUser {
  return { id: u.id, email: u.email, name: u.name, provider: u.provider, orcid: orcidOf(u), ...(u.emailPending ? { emailPending: true as const } : {}) };
}
/** The ORCID iD behind an `orcid:…` subject, for display and author metadata. */
export function orcidOf(u: { subject?: string }): string | undefined {
  return u.subject?.startsWith('orcid:') ? u.subject.slice('orcid:'.length) : undefined;
}

// Asynchronous (libuv thread pool): one scrypt call costs tens of
// milliseconds, and a synchronous one stalls every request and collab socket
// on the node while it runs.
const scrypt = promisify(crypto.scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;
async function hashPassword(password: string, salt: string): Promise<string> {
  return (await scrypt(password, salt, 64)).toString('hex');
}
async function verifyPassword(password: string, user: User): Promise<boolean> {
  const a = Buffer.from(await hashPassword(password, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Longest display name an account keeps, from the sign-up form or a provider profile. */
export const NAME_MAX = 100;
/** A display name as stored: a string with no control characters, at most
 *  NAME_MAX UTF-16 units, never ending in half a surrogate pair. Every user
 *  write on the JSON datastore serialises every account, so the length is
 *  bounded here rather than by the request body limit. */
function cleanName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX).replace(/[\ud800-\udbff]$/, '').trim();
}

/** A fresh one-time confirmation link: the secret for the link, the digest for the store. */
function newConfirmation(now = Date.now()): { token: string; pending: EmailPending } {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, pending: { hash: tokenDigest(token), expiresAt: new Date(now + CONFIRM_TTL_DAYS * 864e5).toISOString() } };
}

/** Create an account. A password account starts with its address pending;
 *  signUp() is the entry point that also hands back the link's secret. */
export async function register(email: string | null, password: string, name?: string, provider?: string, subject?: string): Promise<PublicUser> {
  return pub((await createAccount(email, password, name, provider, subject)).user);
}

/** Password sign-up. `confirmToken` goes into the confirmation link only,
 *  never into a response. */
export async function signUp(email: string, password: string, name?: string): Promise<{ user: PublicUser; confirmToken: string }> {
  const r = await createAccount(email, password, name);
  return { user: pub(r.user), confirmToken: r.confirmToken! };
}

async function createAccount(email: string | null, password: string, name?: string, provider?: string, subject?: string): Promise<{ user: User; confirmToken: string | null }> {
  email = email ? email.trim().toLowerCase() : null;
  if (email === null && !(provider && subject)) throw new Error('Enter a valid email address');
  if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address');
  if (!provider && password.length < 8) throw new Error('Password must be at least 8 characters');
  if (email !== null && await db().findUserByEmail(email)) throw new Error('An account with that email already exists');
  const salt = crypto.randomBytes(16).toString('hex');
  // Anyone can type any address at sign-up; a provider vouches for its own.
  const confirm = provider ? null : newConfirmation();
  const user: User = {
    id: crypto.randomBytes(9).toString('base64url'),
    email,
    name: cleanName(name) || cleanName(email ? email.split('@')[0] : subject),
    salt,
    hash: password ? await hashPassword(password, salt) : '',
    createdAt: new Date().toISOString(),
    provider,
    subject,
    ...(confirm ? { emailPending: confirm.pending } : {}),
  };
  await db().createUser(user);
  return { user, confirmToken: confirm?.token ?? null };
}

/** A new link for an address still pending; the previous link stops
 *  working. Null when the account has nothing to confirm. */
export async function reissueConfirmation(userId: string): Promise<{ token: string; user: PublicUser } | null> {
  const user = await db().getUser(userId);
  if (!user?.emailPending || !user.email) return null;
  const c = newConfirmation();
  await db().setEmailPending(user.id, c.pending);
  return { token: c.token, user: pub(user) };
}

/** Confirm the address of `userId` (the signed-in account) with the link's
 *  secret. Confirming an address already confirmed is not an error. */
export async function confirmEmail(userId: string, token: string): Promise<PublicUser> {
  const user = await db().getUser(userId);
  if (!user) throw new Error('User not found');
  const p = user.emailPending;
  if (!p) return pub(user);
  const a = Buffer.from(p.hash, 'hex');
  const b = Buffer.from(tokenDigest(token), 'hex');
  if (!token || a.length !== b.length || !crypto.timingSafeEqual(a, b) || !(Date.parse(p.expiresAt) > Date.now())) {
    throw new Error('This confirmation link has expired, was replaced by a newer one, or belongs to another account.');
  }
  await db().setEmailPending(user.id, null);
  delete user.emailPending;
  return pub(user);
}

/**
 * Accounts created by single sign-on have no password and can never get one:
 * a password would let the person keep signing in after the IdP disabled
 * them or OIDC_ALLOWED_GROUPS stopped admitting them.
 */
function refuseSsoAccount(user: User): void {
  if (user.provider) throw new Error(`This account signs in with ${providerLabel(user.provider)}, which manages its password.`);
}

export async function login(email: string, password: string): Promise<PublicUser> {
  const user = await db().findUserByEmail(email.trim().toLowerCase());
  if (!user || user.provider || !user.hash || !(await verifyPassword(password, user))) throw new Error('Incorrect email or password');
  return pub(user);
}

export function getUser(id: string): Promise<User | null> {
  return db().getUser(id);
}

/**
 * Find an OAuth user or create one: by provider subject first, then by email.
 * Only merges into an existing account created by the SAME provider — never
 * into a password account, which an attacker could pre-create for the
 * victim's address (confirming it does not make the password the victim's).
 * Prevents pre-account-hijacking. A subject-less provider with no email is a bug in
 * the provider entry, not a sign-in path.
 */
export async function findOrCreateOAuth(profile: OAuthProfile, provider: string): Promise<PublicUser> {
  const email = profile.email ? profile.email.trim().toLowerCase() : null;
  if (profile.subject) {
    const bySubject = await db().findUserBySubject(profile.subject);
    if (bySubject) {
      // An account created while the IdP had no verified address for the
      // person takes the first one it reports. An address already on the
      // account is kept: project invites and shares are matched by it.
      if (!bySubject.email && email && !(await db().findUserByEmail(email))) {
        bySubject.email = email;
        await db().updateUser(bySubject).catch(() => { bySubject.email = null; });
      }
      return pub(bySubject);
    }
  }
  const existing = email ? await db().findUserByEmail(email) : null;
  if (existing) {
    if (existing.provider !== provider) {
      const how = existing.provider ? `sign in with ${providerLabel(existing.provider)}` : 'sign in with your password';
      throw new Error(`An account with this email already exists — ${how} instead.`);
    }
    // An account already bound to one identity is never rebound to another
    // that merely shares the address: at a self-hosted IdP an address can be
    // reassigned, or (OIDC_EMAIL_VERIFIED=trust) typed in by the user.
    if (profile.subject && existing.subject && existing.subject !== profile.subject) {
      throw new Error(`An account with this email already belongs to a different ${providerLabel(provider)} identity — ask the administrator for help.`);
    }
    if (profile.subject && existing.subject !== profile.subject) {
      // First sign-in since the provider started reporting subjects: bind it
      // so a later change of the public email cannot detach the account.
      existing.subject = profile.subject;
      await db().updateUser(existing);
    }
    return pub(existing);
  }
  if (email === null && !profile.subject) throw new Error(`${provider} did not share an email address`);
  return register(email, '', profile.name, provider, profile.subject);
}

/** Returns how many access tokens were revoked with the old password. */
export async function changePassword(userId: string, current: string, next: string): Promise<number> {
  if (next.length < 8) throw new Error('New password must be at least 8 characters');
  const user = await db().getUser(userId);
  if (!user) throw new Error('User not found');
  refuseSsoAccount(user);
  if (user.hash && !(await verifyPassword(current, user))) throw new Error('Current password is incorrect');
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = await hashPassword(next, user.salt);
  await db().updateUser(user);
  await revokeUser(userId); // sign out everywhere; caller re-issues the current session
  return revokeAgentAccess(userId);
}

/** Create a reset token. Returns {token} for self-host relay; caller may also email it. */
export async function requestReset(email: string): Promise<{ token: string; user: PublicUser } | null> {
  const user = await db().findUserByEmail(email.trim().toLowerCase());
  if (!user || user.provider) return null; // do not leak which emails exist
  const token = crypto.randomBytes(24).toString('base64url');
  await db().createReset(token, user.id, Date.now() + RESET_TTL_MS);
  return { token, user: pub(user) };
}

/** Returns how many access tokens were revoked with the old password. */
export async function resetPassword(token: string, next: string): Promise<number> {
  if (next.length < 8) throw new Error('New password must be at least 8 characters');
  const r = await db().getReset(token);
  if (!r || r.exp < Date.now()) throw new Error('This reset link is invalid or has expired');
  const user = await db().getUser(r.userId);
  if (!user) throw new Error('User not found');
  refuseSsoAccount(user);
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = await hashPassword(next, user.salt);
  // The reset link reached the person through the address (or through the
  // operator, from the log), so following it proves the address. Not when
  // ALDINE_RESET_ECHO=1 handed the token to whoever asked.
  if (process.env.ALDINE_RESET_ECHO !== '1') delete user.emailPending;
  await db().updateUser(user);
  await db().deleteReset(token);
  await revokeUser(user.id);
  return revokeAgentAccess(user.id);
}

// ---------- sessions (revocable) ----------
export async function createSession(userId: string): Promise<string> {
  const sid = crypto.randomBytes(24).toString('base64url');
  await db().createSession(sid, userId, Date.now() + SESSION_DAYS * 864e5);
  return sid;
}

export async function destroySession(sid: string | undefined): Promise<void> {
  if (sid) await db().deleteSession(sid);
}

export async function revokeUser(userId: string): Promise<void> {
  await db().deleteSessionsForUser(userId);
}

/**
 * End every agent credential of the account: access tokens, OAuth refresh
 * tokens and authorization codes not yet exchanged. A new password must
 * leave no credential minted under the old one. Returns how many tokens the
 * Agent access card listed.
 */
export async function revokeAgentAccess(userId: string): Promise<number> {
  const listed = (await db().listTokensForUser(userId)).filter((t) => !t.revokedAt).length;
  discardCodesForUser(userId);
  await db().revokeCredentialsForUser(userId, new Date().toISOString());
  return listed;
}

export async function verifyToken(sid: string | undefined): Promise<PublicUser | null> {
  if (!sid) return null;
  const s = await db().getSession(sid);
  if (!s || s.exp < Date.now()) return null;
  const user = await db().getUser(s.userId);
  return user ? pub(user) : null;
}

// ---------- personal access tokens (headless agent credentials) ----------
/** The prefix makes leaked tokens identifiable in logs and secret scanners. */
export const TOKEN_PREFIX = 'aldn_';
export interface TokenScope { tokenId: string; projectIds: string[] | null }
/** Token record without the digest — safe to serialize in API responses. */
export interface PublicToken { id: string; name: string; projectIds: string[] | null; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; clientName: string | null }

// SHA-256, not scrypt: a 256-bit random token needs no slow hashing, and the
// digest doubles as the constant-time lookup key.
const tokenDigest = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

function pubToken(t: TokenRecord): PublicToken {
  return { id: t.id, name: t.name, projectIds: t.projectIds, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt, clientName: t.clientName ?? null };
}

/** OAuth provenance of a token; both null for hand-made tokens. A rotation
 *  passes the record it replaces so the Agent access card keeps showing when
 *  the connection was made and last used, not when the token last rotated. */
export interface TokenOrigin { clientName: string | null; family: string | null; carry?: { createdAt: string; lastUsedAt: string | null } }

/** Mint a token. The plaintext value is returned exactly once — only its digest is stored. */
export async function createAccessToken(userId: string, name: string, projectIds: string[] | null, expiresAt: string | null, origin: TokenOrigin = { clientName: null, family: null }): Promise<{ token: string; record: PublicToken }> {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const record: TokenRecord = {
    id: crypto.randomBytes(9).toString('base64url'),
    userId,
    name,
    hash: tokenDigest(token),
    projectIds,
    createdAt: origin.carry?.createdAt ?? new Date().toISOString(),
    lastUsedAt: origin.carry?.lastUsedAt ?? null,
    expiresAt,
    revokedAt: null,
    clientName: origin.clientName,
    family: origin.family,
  };
  await db().createToken(record);
  return { token, record: pubToken(record) };
}

/** Digest a token or refresh-token secret for storage and lookup. */
export function secretDigest(secret: string): string { return tokenDigest(secret); }

export async function listAccessTokens(userId: string): Promise<PublicToken[]> {
  return (await db().listTokensForUser(userId)).filter((t) => !t.revokedAt).map(pubToken);
}

/** Revoke (effective on the next bearer request). False when the token isn't the caller's. */
export async function revokeAccessToken(userId: string, tokenId: string): Promise<boolean> {
  const t = await db().getToken(tokenId);
  if (!t || t.userId !== userId || t.revokedAt) return false;
  const now = new Date().toISOString();
  t.revokedAt = now;
  await db().updateToken(t);
  // An OAuth token's refresh token would otherwise mint a replacement on the
  // connector's next refresh, silently undoing the user's revoke.
  if (t.family) {
    await db().revokeRefreshFamily(t.family, now);
    await db().revokeTokensInFamily(t.family, now);
  }
  return true;
}

/** lastUsedAt writes are throttled to once per minute per token — every bearer
 *  request would otherwise rewrite tokens.json (JsonStore write amplification). */
const LAST_USED_THROTTLE_MS = 60_000;

/** Resolve a `Bearer aldn_…` header to its user. Null for anything else —
 *  malformed, unknown, revoked, or expired — so callers can't tell which. */
export async function userFromToken(authorizationHeader: string | undefined): Promise<{ user: PublicUser; tokenScope: TokenScope } | null> {
  if (!AUTH_ENABLED || !authorizationHeader) return null;
  const m = /^Bearer\s+(aldn_[A-Za-z0-9_-]+)$/.exec(authorizationHeader.trim());
  if (!m) return null;
  const digest = tokenDigest(m[1]);
  const rec = await db().getTokenByHash(digest);
  if (!rec) return null;
  // Re-compare digests timing-safely so equality never rides on the
  // datastore's (indexed, non-constant-time) string comparison.
  const a = Buffer.from(rec.hash, 'hex');
  const b = Buffer.from(digest, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (rec.revokedAt) return null;
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) return null;
  const user = await db().getUser(rec.userId);
  if (!user) return null;
  if (!rec.lastUsedAt || Date.now() - Date.parse(rec.lastUsedAt) >= LAST_USED_THROTTLE_MS) {
    // best effort: a bookkeeping write must never fail an authenticated request.
    // touchToken, never updateToken(rec): writing this whole in-memory record
    // back would overwrite a revocation persisted since getTokenByHash —
    // silently un-revoking the token.
    await db().touchToken(rec.id, new Date().toISOString()).catch(() => {});
  }
  return { user: pub(user), tokenScope: { tokenId: rec.id, projectIds: rec.projectIds } };
}

// ---------- cookies ----------
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeCookieValue(part.slice(i + 1).trim());
  }
  return out;
}
// The Cookie header carries every cookie on the host, not only ours: a
// neighbouring app's `x=100%` or a truncated `%E0%A4%A` must not turn every
// request into a 500. A value that is not valid percent-encoding is kept raw;
// it will simply fail session lookup.
function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
export function sessionCookie(sid: string): string {
  return `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIES ? '; Secure' : ''}`;
}
export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0${SECURE_COOKIES ? '; Secure' : ''}`;
}

// ---------- device cookie (per-account sign-in backoff) ----------
// OWASP's device-cookie pattern: a browser that signed in to an account
// before proves it with an entry signed for that account's email, and its
// failed tries count on the entry's own key instead of the account's. Someone
// who knows only the address can then slow down every other browser, but
// never the ones its owner uses.
export const DEVICE_COOKIE = 'aldine_device';
const DEVICE_DAYS = 365;
/** Accounts one browser stays trusted for; the oldest entry drops out. */
const DEVICE_ENTRIES = 5;
const NONCE_RE = /^[A-Za-z0-9_-]{16}$/;

function deviceSig(email: string, nonce: string): Buffer {
  return crypto.createHmac('sha256', subkey('device-cookie')).update(JSON.stringify([email, nonce])).digest();
}
function deviceEntries(cookieHeader: string | undefined): string[] {
  const raw = parseCookies(cookieHeader)[DEVICE_COOKIE];
  return raw ? raw.split('~').slice(0, DEVICE_ENTRIES) : [];
}
/** The entry's nonce when it is a valid entry for `email`. */
function entryFor(entry: string, email: string): string | null {
  const [nonce, sig, extra] = entry.split('.');
  if (extra !== undefined || !nonce || !sig || !NONCE_RE.test(nonce)) return null;
  let got: Buffer;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  const want = deviceSig(email, nonce);
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? nonce : null;
}
/** The nonce of this browser's entry for `email` (as typed), or null. */
export function trustedDevice(cookieHeader: string | undefined, email: string): string | null {
  const e = email.trim().toLowerCase();
  for (const entry of deviceEntries(cookieHeader)) {
    const nonce = entryFor(entry, e);
    if (nonce) return nonce;
  }
  return null;
}
/** Set-Cookie after a correct sign-in: a fresh entry for `email` first, the
 *  browser's entries for its other accounts after it. */
export function deviceCookie(cookieHeader: string | undefined, email: string): string {
  const e = email.trim().toLowerCase();
  const nonce = crypto.randomBytes(12).toString('base64url');
  const others = deviceEntries(cookieHeader).filter((entry) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(entry) && !entryFor(entry, e));
  const value = [`${nonce}.${deviceSig(e, nonce).toString('base64url')}`, ...others].slice(0, DEVICE_ENTRIES).join('~');
  return `${DEVICE_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${DEVICE_DAYS * 86400}${SECURE_COOKIES ? '; Secure' : ''}`;
}

export function sidFromRequest(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[COOKIE];
}
export function userFromRequest(cookieHeader: string | undefined): Promise<PublicUser | null> {
  if (!AUTH_ENABLED) return Promise.resolve(null);
  return verifyToken(sidFromRequest(cookieHeader));
}
