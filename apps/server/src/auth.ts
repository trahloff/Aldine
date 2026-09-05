import crypto from 'node:crypto';
import { db } from './db/index.js';
import type { User } from './db/types.js';
import { config } from './config.js';

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
// Scoped to the base path so a neighbouring app on the same host never sees it.
export const COOKIE_PATH = config.basePath || '/';
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
export function sidFromRequest(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[COOKIE];
}
export function userFromRequest(cookieHeader: string | undefined): Promise<PublicUser | null> {
  if (!AUTH_ENABLED) return Promise.resolve(null);
  return verifyToken(sidFromRequest(cookieHeader));
}
