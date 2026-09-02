import crypto from 'node:crypto';
import { db } from '../db/index.js';
import type { OAuthClient } from '../db/types.js';
import { OAuthError } from './errors.js';
import { isAllowedRedirectUri } from './cimd.js';
import { DCR_PREFIX } from './clients.js';

/**
 * Dynamic client registration (RFC 7591) for public clients. Anyone can call
 * it, so the store is capped: past MAX_CLIENTS the least recently used
 * registrations are evicted — a connector that was set up and then abandoned
 * for months simply re-registers on its next connect.
 */
export const MAX_CLIENTS = 500;
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const RESPONSE_TYPES = ['code'];

export interface RegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  grant_types: string[];
  response_types: string[];
  application_type?: string;
}

function stringList(v: unknown, allowed: string[], field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !allowed.includes(x))) {
    throw new OAuthError('invalid_client_metadata', `${field} may only contain ${allowed.join(', ')}`);
  }
  return Array.from(new Set(v as string[]));
}

/** Validate a registration request and store the client. */
export async function registerClient(body: unknown): Promise<RegistrationResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'The request body must be a JSON object');
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required');
  if (uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'At most 10 redirect_uris are allowed');
  for (const u of uris) {
    if (typeof u !== 'string' || !isAllowedRedirectUri(u)) throw new OAuthError('invalid_redirect_uri', 'Each redirect_uri must be an https URL or a loopback http URL without a fragment');
  }
  const redirectUris = Array.from(new Set(uris as string[]));
  // RFC 7591 defaults an omitted method to client_secret_basic, which a
  // public-client-only server cannot honour — treat omission as `none`.
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') {
    throw new OAuthError('invalid_client_metadata', 'token_endpoint_auth_method must be "none"');
  }
  const grantTypes = stringList(b.grant_types, GRANT_TYPES, 'grant_types') ?? ['authorization_code'];
  const responseTypes = stringList(b.response_types, RESPONSE_TYPES, 'response_types') ?? ['code'];
  if (b.client_name !== undefined && typeof b.client_name !== 'string') throw new OAuthError('invalid_client_metadata', 'client_name must be a string');
  const name = ((b.client_name as string | undefined) || '').trim().slice(0, 100) || new URL(redirectUris[0]).host;
  if (b.application_type !== undefined && b.application_type !== 'native' && b.application_type !== 'web') {
    throw new OAuthError('invalid_client_metadata', 'application_type must be "native" or "web"');
  }

  const excess = (await db().countOAuthClients()) - (MAX_CLIENTS - 1);
  if (excess > 0) await db().evictOldestOAuthClients(excess);

  const now = new Date();
  const client: OAuthClient = {
    id: DCR_PREFIX + crypto.randomBytes(18).toString('base64url'),
    name,
    redirectUris,
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
  };
  await db().createOAuthClient(client);
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: grantTypes,
    response_types: responseTypes,
    ...(b.application_type !== undefined ? { application_type: b.application_type as string } : {}),
  };
}
