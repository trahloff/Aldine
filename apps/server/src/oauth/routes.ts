import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as auth from '../auth.js';
import { oauthTokenLimiter, oauthRegisterLimiter, oauthClientLimiter, clientKey } from '../ratelimit.js';
import { publicBase, PROJECT_ID_RE } from '../util.js';
import { OAuthError } from './errors.js';
import { protectedResourceMetadata, authorizationServerMetadata, SCOPE } from './metadata.js';
import { resolveClient } from './clients.js';
import { registerClient } from './register.js';
import { issueCode } from './codes.js';
import { exchangeCode, refreshTokens, revokeToken, checkResource, param, type Params } from './token.js';

/**
 * Route wiring for the OAuth 2.1 authorization server. Everything 404s while
 * AUTH_ENABLED is off — there is no account to authorize against, and a
 * discovery document would send clients on a doomed flow.
 *
 * /oauth/authorize is deliberately NOT registered here: the SPA renders the
 * consent page at that path (index.ts falls through to index.html) and talks
 * to /api/oauth/client + /api/oauth/consent, which are cookie-session routes.
 * Their CSRF protection is the one every state-changing /api route relies
 * on: the session cookie is SameSite=Lax and the body must parse as
 * application/json (no form parser in this context, no CORS), so a
 * cross-site form post never carries the session, and a cross-site fetch
 * with a JSON content type is blocked by the browser's preflight.
 */

/** RFC 7591 §3.2.1 body cap: registrations are a few hundred bytes. */
const REGISTER_BODY_LIMIT = 8 * 1024;
const TOKEN_BODY_LIMIT = 8 * 1024;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_MAX = 1024;

type Reply = FastifyReply;

const noStore = (reply: Reply) => reply.header('cache-control', 'no-store').header('pragma', 'no-cache');

function sendError(reply: Reply, err: unknown): void {
  if (err instanceof OAuthError) { noStore(reply).code(err.status).send(err.toJSON()); return; }
  console.error('[aldine] oauth error', err);
  noStore(reply).code(500).send({ error: 'server_error', error_description: 'Something went wrong — try again' });
}

/** Append `params` to a validated redirect_uri, keeping its own query intact. */
function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** Parse the authorize parameters the SPA relays; throws OAuthError on any defect. */
function authorizeParams(issuer: string, body: Params) {
  const responseType = param(body, 'response_type');
  if (responseType !== 'code') throw new OAuthError('invalid_request', 'response_type must be "code"');
  const codeChallenge = param(body, 'code_challenge');
  if (!codeChallenge || !CODE_CHALLENGE_RE.test(codeChallenge)) throw new OAuthError('invalid_request', 'code_challenge (S256, base64url) is required');
  if (param(body, 'code_challenge_method') !== 'S256') throw new OAuthError('invalid_request', 'code_challenge_method must be "S256"');
  const state = param(body, 'state');
  if (state !== undefined && state.length > STATE_MAX) throw new OAuthError('invalid_request', 'state is too long');
  const scope = param(body, 'scope');
  if (scope !== undefined && scope.split(' ').filter(Boolean).some((s) => s !== SCOPE)) throw new OAuthError('invalid_scope', `Only the "${SCOPE}" scope is available`);
  const resource = param(body, 'resource');
  checkResource(issuer, resource);
  return { codeChallenge, state, resource: resource ?? null };
}

export async function registerOAuth(app: FastifyInstance): Promise<void> {
  const enabled = (reply: Reply): boolean => {
    if (auth.AUTH_ENABLED) return true;
    reply.code(404).send({ error: 'not found' });
    return false;
  };

  // ---------- discovery ----------
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(p, async (req, reply) => {
      if (!enabled(reply)) return;
      return protectedResourceMetadata(publicBase(req));
    });
  }
  app.get('/.well-known/oauth-authorization-server', async (req, reply) => {
    if (!enabled(reply)) return;
    return authorizationServerMetadata(publicBase(req));
  });

  // ---------- consent (cookie session only) ----------
  const sessionUser = (req: FastifyRequest, reply: Reply): auth.PublicUser | null => {
    if ((req as any)._tokenScope) { reply.code(403).send({ error: 'Access tokens cannot authorize connectors — sign in to do this' }); return null; }
    const user = (req as any)._user as auth.PublicUser | null;
    if (!user) { reply.code(401).send({ error: 'Sign in required' }); return null; }
    return user;
  };

  app.get<{ Querystring: { client_id?: string; redirect_uri?: string } }>('/api/oauth/client', async (req, reply) => {
    if (!enabled(reply)) return;
    if ((req as any)._tokenScope) return reply.code(403).send({ error: 'Access tokens cannot authorize connectors — sign in to do this' });
    if (!(await oauthClientLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many requests — wait a moment and try again' });
    try {
      const c = await resolveClient(req.query.client_id ?? '', req.query.redirect_uri ?? '');
      let redirectHost = '';
      try { redirectHost = new URL(req.query.redirect_uri!).host; } catch { /* validated above */ }
      return noStore(reply).send({ name: c.name, host: c.host, redirectHost, loopbackOnly: c.loopbackOnly, kind: c.kind });
    } catch (err) { return sendError(reply, err); }
  });

  app.post<{ Body: Params }>('/api/oauth/consent', async (req, reply) => {
    if (!enabled(reply)) return;
    const user = sessionUser(req, reply);
    if (!user) return;
    if (!(await oauthClientLimiter.take(clientKey(req, user.id)))) return reply.code(429).send({ error: 'Too many requests — wait a moment and try again' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Params;
    const issuer = publicBase(req);
    let client;
    try {
      client = await resolveClient(param(body, 'client_id') ?? '', param(body, 'redirect_uri') ?? '');
    } catch (err) { return sendError(reply, err); }  // never redirect to an unvalidated URL
    const redirectUri = param(body, 'redirect_uri')!;
    const state = param(body, 'state');
    const stateOk = state === undefined || state.length <= STATE_MAX;
    let params;
    try {
      params = authorizeParams(issuer, body);
    } catch (err) {
      // The client and its redirect are genuine, so the error goes back to it (RFC 6749 §4.1.2.1).
      const e = err instanceof OAuthError ? err : new OAuthError('server_error', 'Something went wrong');
      return noStore(reply).send({ redirectTo: redirectWith(redirectUri, { error: e.code, error_description: e.description, state: stateOk ? state : undefined, iss: issuer }) });
    }
    const decision = param(body, 'decision');
    if (decision === 'deny') {
      return noStore(reply).send({ redirectTo: redirectWith(redirectUri, { error: 'access_denied', error_description: 'The user declined', state: params.state, iss: issuer }) });
    }
    if (decision !== 'allow') return reply.code(400).send({ error: 'decision must be "allow" or "deny"' });
    let projectIds: string[] | null = null;
    if (body.projectIds !== null && body.projectIds !== undefined) {
      const ids = body.projectIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((p) => typeof p !== 'string' || !PROJECT_ID_RE.test(p))) {
        return reply.code(400).send({ error: 'projectIds must be a list of project ids, or null for all projects' });
      }
      projectIds = Array.from(new Set(ids as string[]));
    }
    const code = issueCode({
      clientId: client.id, clientName: client.name, redirectUri, codeChallenge: params.codeChallenge,
      resource: params.resource, scope: SCOPE, userId: user.id, projectIds,
    });
    return noStore(reply).send({ redirectTo: redirectWith(redirectUri, { code, state: params.state, iss: issuer }) });
  });

  // ---------- protocol endpoints (public clients, form-encoded) ----------
  // Encapsulated so the form parser exists ONLY for these routes — a global
  // form parser would let a cross-site <form> reach the JSON /api routes.
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: TOKEN_BODY_LIMIT }, (_req, body, done) => {
      try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); } catch (err) { done(err as Error); }
    });

    sub.post<{ Body: Params }>('/oauth/token', { bodyLimit: TOKEN_BODY_LIMIT }, async (req, reply) => {
      if (!enabled(reply)) return;
      if (!(await oauthTokenLimiter.take(clientKey(req)))) return noStore(reply).code(429).send({ error: 'invalid_request', error_description: 'Too many requests — slow down' });
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Params;
      const issuer = publicBase(req);
      try {
        const grant = param(body, 'grant_type');
        if (grant === 'authorization_code') return noStore(reply).send(await exchangeCode(issuer, body));
        if (grant === 'refresh_token') return noStore(reply).send(await refreshTokens(issuer, body));
        throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
      } catch (err) { return sendError(reply, err); }
    });

    sub.post('/oauth/register', { bodyLimit: REGISTER_BODY_LIMIT }, async (req, reply) => {
      if (!enabled(reply)) return;
      if (!(await oauthRegisterLimiter.take(clientKey(req)))) return noStore(reply).code(429).send({ error: 'invalid_request', error_description: 'Too many registrations — try again later' });
      try {
        return noStore(reply).code(201).send(await registerClient(req.body));
      } catch (err) { return sendError(reply, err); }
    });

    sub.post<{ Body: Params }>('/oauth/revoke', { bodyLimit: TOKEN_BODY_LIMIT }, async (req, reply) => {
      if (!enabled(reply)) return;
      if (!(await oauthTokenLimiter.take(clientKey(req)))) return noStore(reply).code(429).send({ error: 'invalid_request', error_description: 'Too many requests — slow down' });
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Params;
      const token = param(body, 'token');
      // RFC 7009 §2.2: invalid or unknown tokens still get 200 — the response
      // must not reveal whether a token existed.
      if (token && token.length <= 512) await revokeToken(token).catch((err) => console.error('[aldine] oauth revoke failed', err));
      return noStore(reply).send({});
    });
  });
}
