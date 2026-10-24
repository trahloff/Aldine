/**
 * A password reset or change ends every credential minted under the old
 * password: sessions, access tokens, OAuth refresh tokens (including one
 * whose access token was revoked on its own) and authorization codes not yet
 * exchanged. Another account's tokens are untouched, and a refused change
 * revokes nothing.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, eq } from './assert.mjs';

const ISSUER = 'https://aldine.test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-pwrevoke-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_PUBLIC_URL = ISSUER;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;
delete process.env.ALDINE_RESET_ECHO;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { issueCode } = await import('../src/oauth/codes.ts');
const { exchangeCode, refreshTokens } = await import('../src/oauth/token.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const bob = await auth.register('bob@example.com', 'password123', 'Bob');

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const grant = (userId) => ({ clientId: 'aldc_test', clientName: 'Claude', redirectUri: 'https://claude.test/cb', codeChallenge: challenge, resource: null, scope: 'mcp', userId, projectIds: null });
const exchange = (code) => exchangeCode(ISSUER, { code, client_id: 'aldc_test', redirect_uri: 'https://claude.test/cb', code_verifier: verifier });
const refresh = (secret) => refreshTokens(ISSUER, { refresh_token: secret, client_id: 'aldc_test' });
const works = async (token) => (await auth.userFromToken(`Bearer ${token}`)) !== null;
const refreshRefused = async (secret) => {
  try { await refresh(secret); return false; } catch (err) { return err.code === 'invalid_grant'; }
};

/** Every kind of credential the account can hold besides its sessions. */
async function credentials(userId) {
  const pat = (await auth.createAccessToken(userId, 'Script', null, null)).token;
  const connect = await exchange(issueCode(grant(userId)));
  // RFC 7009 revocation of the access token alone leaves the refresh token live.
  const orphan = await exchange(issueCode(grant(userId)));
  const orphanRec = await db().getTokenByHash(auth.secretDigest(orphan.access_token));
  await db().updateToken({ ...orphanRec, revokedAt: new Date().toISOString() });
  const pendingCode = issueCode(grant(userId));
  return { pat, connect, orphan, pendingCode };
}

// ---- reset ----
const before = await credentials(ada.id);
const bobToken = (await auth.createAccessToken(bob.id, 'Bob script', null, null)).token;
check(await works(before.pat) && await works(before.connect.access_token), 'credentials work before the reset');
const adaCookie = `aldine_session=${await auth.createSession(ada.id)}`;

const { token: resetToken } = await auth.requestReset('ada@example.com');
let res = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: resetToken, newPassword: 'reset-pass-1' } });
eq(res.statusCode, 200, 'reset succeeds');
eq(res.json().revokedTokens, 2, 'reset reports the listed tokens it revoked (the token and the connection)');

check(!(await works(before.pat)), 'reset revokes the personal access token');
check(!(await works(before.connect.access_token)), 'reset revokes the OAuth access token');
check(await refreshRefused(before.connect.refresh_token), 'reset revokes the OAuth refresh token');
check(await refreshRefused(before.orphan.refresh_token), 'reset revokes a refresh token whose access token was revoked on its own');
let codeRefused = false;
try { await exchange(before.pendingCode); } catch (err) { codeRefused = err.code === 'invalid_grant'; }
check(codeRefused, 'reset discards an authorization code not yet exchanged');
res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: adaCookie } });
eq(res.json().user, null, 'reset still signs out existing sessions');
check(await works(bobToken), "another account's token survives the reset");
res = await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${before.pat}` } });
eq(res.statusCode, 401, 'the revoked token is refused on the API');

// ---- change ----
const later = await credentials(ada.id);
const session = `aldine_session=${await auth.createSession(ada.id)}`;
res = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { cookie: session }, payload: { currentPassword: 'wrong-password', newPassword: 'changed-pass-2' } });
eq(res.statusCode, 400, 'a wrong current password is refused');
check(await works(later.pat) && await works(later.connect.access_token), 'a refused change revokes nothing');

res = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { cookie: session }, payload: { currentPassword: 'reset-pass-1', newPassword: 'changed-pass-2' } });
eq(res.statusCode, 200, 'change succeeds');
eq(res.json().revokedTokens, 2, 'change reports the listed tokens it revoked');
check(!(await works(later.pat)), 'change revokes the personal access token');
check(!(await works(later.connect.access_token)), 'change revokes the OAuth access token');
check(await refreshRefused(later.connect.refresh_token), 'change revokes the OAuth refresh token');
check(await refreshRefused(later.orphan.refresh_token), 'change revokes the orphaned refresh token');
const reissued = String(res.headers['set-cookie']).split(';')[0];
res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: reissued } });
eq(res.json().user?.id, ada.id, 'the session re-issued by the change works');
check(await works(bobToken), "another account's token survives the change");

res = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { cookie: reissued }, payload: { currentPassword: 'changed-pass-2', newPassword: 'changed-pass-3' } });
eq(res.json().revokedTokens, 0, 'a change with no live tokens reports none');

console.log('password-revokes-agents: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
