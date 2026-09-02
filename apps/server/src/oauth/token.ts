import crypto from 'node:crypto';
import { db } from '../db/index.js';
import type { RefreshTokenRecord } from '../db/types.js';
import * as auth from '../auth.js';
import { OAuthError } from './errors.js';
import { consumeCode } from './codes.js';
import { isOurResource, SCOPE } from './metadata.js';

/**
 * Token endpoint logic (authorization_code + refresh_token grants) and
 * revocation. Access tokens are ordinary `aldn_` records, so /mcp and the
 * REST bearer path need no OAuth awareness; refresh tokens are `aldr_`
 * secrets stored by digest and rotated on every use.
 */

export const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_PREFIX = 'aldr_';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Form or JSON body: every value is read as a string or ignored. */
export type Params = Record<string, unknown>;
export const param = (p: Params, k: string): string | undefined => (typeof p[k] === 'string' ? (p[k] as string) : undefined);

interface Grant { userId: string; clientId: string; clientName: string; projectIds: string[] | null; family: string }

async function mint(g: Grant): Promise<TokenResponse> {
  const now = Date.now();
  const { token, record } = await auth.createAccessToken(
    g.userId, g.clientName, g.projectIds, new Date(now + ACCESS_TTL_MS).toISOString(),
    { clientName: g.clientName, family: g.family },
  );
  const refresh = REFRESH_PREFIX + crypto.randomBytes(32).toString('base64url');
  const rec: RefreshTokenRecord = {
    id: crypto.randomBytes(9).toString('base64url'),
    hash: auth.secretDigest(refresh),
    tokenId: record.id,
    userId: g.userId,
    clientId: g.clientId,
    family: g.family,
    projectIds: g.projectIds,
    clientName: g.clientName,
    expiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
    usedAt: null,
    revokedAt: null,
  };
  await db().createRefresh(rec);
  return { access_token: token, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: SCOPE };
}

async function revokeFamily(family: string): Promise<void> {
  if (!family) return;
  const now = new Date().toISOString();
  await db().revokeRefreshFamily(family, now);
  await db().revokeTokensInFamily(family, now);
}

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function pkceMatches(verifier: string, challenge: string): boolean {
  const a = crypto.createHash('sha256').update(verifier).digest();
  let b: Buffer;
  try { b = Buffer.from(challenge, 'base64url'); } catch { return false; }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** RFC 8707: an absent `resource` is fine; a present one must name this server. */
export function checkResource(issuer: string, resource: string | undefined): void {
  if (resource !== undefined && !isOurResource(issuer, resource)) {
    throw new OAuthError('invalid_target', 'resource must be this server\'s MCP endpoint');
  }
}

/** grant_type=authorization_code */
export async function exchangeCode(issuer: string, p: Params): Promise<TokenResponse> {
  const code = param(p, 'code'), clientId = param(p, 'client_id'), redirectUri = param(p, 'redirect_uri'), verifier = param(p, 'code_verifier');
  if (!code || !clientId || !redirectUri) throw new OAuthError('invalid_request', 'code, client_id and redirect_uri are required');
  if (!verifier || !VERIFIER_RE.test(verifier)) throw new OAuthError('invalid_request', 'code_verifier is required (43–128 unreserved characters)');
  checkResource(issuer, param(p, 'resource'));
  const hit = consumeCode(code);
  if (hit.status === 'reused') {
    // RFC 6749 §4.1.2: a second exchange revokes everything the first produced.
    await revokeFamily(hit.family);
    throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired');
  }
  if (hit.status === 'unknown') throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired');
  const g = hit.grant;
  // Every binding is checked AFTER the code is burned: one wrong parameter
  // costs the client its code (it restarts the flow), never a second try.
  const bound = g.clientId === clientId && g.redirectUri === redirectUri && pkceMatches(verifier, g.codeChallenge);
  if (!bound) throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired');
  const family = crypto.randomBytes(12).toString('base64url');
  const res = await mint({ userId: g.userId, clientId: g.clientId, clientName: g.clientName, projectIds: g.projectIds, family });
  if (hit.markUsed(family)) {
    // The code was presented again while this exchange was minting: the
    // replay could not name the family yet, so the revocation happens here.
    await revokeFamily(family);
    throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired');
  }
  return res;
}

async function lookupRefresh(secret: string): Promise<RefreshTokenRecord | null> {
  if (!secret.startsWith(REFRESH_PREFIX)) return null;
  const digest = auth.secretDigest(secret);
  const rec = await db().getRefreshByHash(digest);
  if (!rec) return null;
  const a = Buffer.from(rec.hash, 'hex'), b = Buffer.from(digest, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? rec : null;
}

/** grant_type=refresh_token — rotate, with family revocation on reuse. */
export async function refreshTokens(issuer: string, p: Params): Promise<TokenResponse> {
  const secret = param(p, 'refresh_token');
  if (!secret) throw new OAuthError('invalid_request', 'refresh_token is required');
  checkResource(issuer, param(p, 'resource'));
  const invalid = () => new OAuthError('invalid_grant', 'The refresh token is invalid, expired, or revoked');
  const rec = await lookupRefresh(secret);
  if (!rec || rec.revokedAt) throw invalid();
  // A rotated-out token presented again means it leaked (or the client lost
  // the rotation response); either way the whole family is burned.
  const reused = async () => { await revokeFamily(rec.family); return invalid(); };
  if (rec.usedAt) throw await reused();
  const clientId = param(p, 'client_id');
  if (clientId !== undefined && clientId !== rec.clientId) throw invalid();
  if (Date.parse(rec.expiresAt) <= Date.now()) throw invalid();
  const now = new Date().toISOString();
  // The mark is a compare-and-set: of two concurrent rotations of one token
  // exactly one wins, and the loser is treated exactly like a replay.
  if (!(await db().markRefreshUsed(rec.id, now))) throw await reused();
  const old = await db().getToken(rec.tokenId);
  if (old && !old.revokedAt) { old.revokedAt = now; await db().updateToken(old); }
  const res = await mint({ userId: rec.userId, clientId: rec.clientId, clientName: rec.clientName, projectIds: rec.projectIds, family: rec.family });
  // A family revocation (the loser's replay, or the user's revoke) that
  // landed while this rotation was minting could not reach the rows just
  // written. The presented record is revoked with the family, so re-reading
  // it tells: burn again — now covering the new pair — and fail closed.
  const after = await db().getRefreshByHash(rec.hash);
  if (!after || after.revokedAt) { await revokeFamily(rec.family); throw invalid(); }
  return res;
}

/** RFC 7009: an access token revokes itself; a refresh token revokes its family. Unknown tokens are ignored. */
export async function revokeToken(secret: string): Promise<void> {
  if (secret.startsWith(REFRESH_PREFIX)) {
    const rec = await lookupRefresh(secret);
    if (rec) await revokeFamily(rec.family);
    return;
  }
  if (secret.startsWith(auth.TOKEN_PREFIX)) {
    const digest = auth.secretDigest(secret);
    const rec = await db().getTokenByHash(digest);
    if (!rec) return;
    const a = Buffer.from(rec.hash, 'hex'), b = Buffer.from(digest, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return;
    if (!rec.revokedAt) { rec.revokedAt = new Date().toISOString(); await db().updateToken(rec); }
  }
}
