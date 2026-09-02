import crypto from 'node:crypto';
import { db } from './db/index.js';
import type { TokenRecord, User } from './db/types.js';

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
export const COOKIE = 'aldine_session';
const SESSION_DAYS = 30;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export type { User } from './db/types.js';
export interface PublicUser { id: string; email: string; name: string; provider?: string }

/** Session and OAuth-state cookies get the Secure flag when the deployment is HTTPS. */
export const SECURE_COOKIES = (process.env.ALDINE_PUBLIC_URL || '').startsWith('https') || process.env.COOKIE_SECURE === '1';

export function pub(u: User): PublicUser { return { id: u.id, email: u.email, name: u.name, provider: u.provider }; }

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password: string, user: User): boolean {
  const attempt = hashPassword(password, user.salt);
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function register(email: string, password: string, name?: string, provider?: string): Promise<PublicUser> {
  email = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address');
  if (!provider && password.length < 8) throw new Error('Password must be at least 8 characters');
  if (await db().findUserByEmail(email)) throw new Error('An account with that email already exists');
  const salt = crypto.randomBytes(16).toString('hex');
  const user: User = {
    id: crypto.randomBytes(9).toString('base64url'),
    email,
    name: (name || email.split('@')[0]).trim(),
    salt,
    hash: password ? hashPassword(password, salt) : '',
    createdAt: new Date().toISOString(),
    provider,
  };
  await db().createUser(user);
  return pub(user);
}

export async function login(email: string, password: string): Promise<PublicUser> {
  const user = await db().findUserByEmail(email.trim().toLowerCase());
  if (!user || !user.hash || !verifyPassword(password, user)) throw new Error('Incorrect email or password');
  return pub(user);
}

export function getUser(id: string): Promise<User | null> {
  return db().getUser(id);
}

/**
 * Find an OAuth user by email or create one. Only merges into an existing
 * account created by the SAME provider — never into a password account, which
 * (registration doesn't verify email) an attacker could pre-create for the
 * victim's address. Prevents pre-account-hijacking.
 */
export async function findOrCreateOAuth(email: string, name: string, provider: string): Promise<PublicUser> {
  const existing = await db().findUserByEmail(email.trim().toLowerCase());
  if (existing) {
    if (existing.provider === provider) return pub(existing);
    const how = existing.provider ? `sign in with ${existing.provider}` : 'sign in with your password';
    throw new Error(`An account with this email already exists — ${how} instead.`);
  }
  return register(email, '', name, provider);
}

export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  if (next.length < 8) throw new Error('New password must be at least 8 characters');
  const user = await db().getUser(userId);
  if (!user) throw new Error('User not found');
  if (user.hash && !verifyPassword(current, user)) throw new Error('Current password is incorrect');
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(next, user.salt);
  await db().updateUser(user);
  await revokeUser(userId); // sign out everywhere; caller re-issues the current session
}

/** Create a reset token. Returns {token} for self-host relay; caller may also email it. */
export async function requestReset(email: string): Promise<{ token: string; user: PublicUser } | null> {
  const user = await db().findUserByEmail(email.trim().toLowerCase());
  if (!user) return null; // do not leak which emails exist
  const token = crypto.randomBytes(24).toString('base64url');
  await db().createReset(token, user.id, Date.now() + RESET_TTL_MS);
  return { token, user: pub(user) };
}

export async function resetPassword(token: string, next: string): Promise<void> {
  if (next.length < 8) throw new Error('New password must be at least 8 characters');
  const r = await db().getReset(token);
  if (!r || r.exp < Date.now()) throw new Error('This reset link is invalid or has expired');
  const user = await db().getUser(r.userId);
  if (!user) throw new Error('User not found');
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(next, user.salt);
  await db().updateUser(user);
  await db().deleteReset(token);
  await revokeUser(user.id);
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

/** OAuth provenance of a token; both null for hand-made tokens. */
export interface TokenOrigin { clientName: string | null; family: string | null }

/** Mint a token. The plaintext value is returned exactly once — only its digest is stored. */
export async function createAccessToken(userId: string, name: string, projectIds: string[] | null, expiresAt: string | null, origin: TokenOrigin = { clientName: null, family: null }): Promise<{ token: string; record: PublicToken }> {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const record: TokenRecord = {
    id: crypto.randomBytes(9).toString('base64url'),
    userId,
    name,
    hash: tokenDigest(token),
    projectIds,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function sessionCookie(sid: string): string {
  return `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIES ? '; Secure' : ''}`;
}
export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIES ? '; Secure' : ''}`;
}
export function sidFromRequest(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[COOKIE];
}
export function userFromRequest(cookieHeader: string | undefined): Promise<PublicUser | null> {
  if (!AUTH_ENABLED) return Promise.resolve(null);
  return verifyToken(sidFromRequest(cookieHeader));
}
