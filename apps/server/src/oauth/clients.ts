import { db } from '../db/index.js';
import { OAuthError } from './errors.js';
import { fetchClientMetadata, isLoopbackHost } from './cimd.js';

/**
 * One view over the two client kinds: `aldc_…` ids registered via DCR
 * (stored) and https-URL ids resolved via their metadata document (fetched).
 */
export interface ResolvedClient {
  id: string;
  name: string;
  /** What the consent page shows as the trusting identity: the metadata
   *  document's host for CIMD clients, the redirect host for DCR clients. */
  host: string;
  redirectUris: string[];
  /** Every registered redirect is loopback — the consent page warns (draft §5). */
  loopbackOnly: boolean;
  kind: 'cimd' | 'dcr';
}

export const DCR_PREFIX = 'aldc_';
const DCR_ID_RE = /^aldc_[A-Za-z0-9_-]{16,64}$/;

function hostOf(uri: string): string {
  try { return new URL(uri).host; } catch { return ''; }
}

/**
 * Exact match, except RFC 8252 §7.3 loopback redirects compare with the port
 * ignored: native clients bind an ephemeral port per run, and Claude Code's
 * metadata registers the portless form. Scheme, host, path and query must
 * still match exactly.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  let a: URL, b: URL;
  try { a = new URL(registered); b = new URL(presented); } catch { return false; }
  if (a.protocol !== 'http:' || b.protocol !== 'http:') return false;
  if (!isLoopbackHost(a.hostname) || a.hostname !== b.hostname) return false;
  return a.pathname === b.pathname && a.search === b.search && !b.hash && !b.username && !b.password;
}

/** Look the client up and check `redirectUri` against its registration. */
export async function resolveClient(clientId: string, redirectUri: string): Promise<ResolvedClient> {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 2048) throw new OAuthError('invalid_client', 'client_id is required');
  if (typeof redirectUri !== 'string' || !redirectUri || redirectUri.length > 2000) throw new OAuthError('invalid_request', 'redirect_uri is required');
  let client: ResolvedClient;
  if (clientId.startsWith(DCR_PREFIX)) {
    const rec = DCR_ID_RE.test(clientId) ? await db().getOAuthClient(clientId) : null;
    if (!rec) throw new OAuthError('invalid_client', 'Unknown client — register it again');
    await db().touchOAuthClient(rec.id, new Date().toISOString()).catch(() => {});
    client = { id: rec.id, name: rec.name, host: hostOf(rec.redirectUris[0]), redirectUris: rec.redirectUris, loopbackOnly: false, kind: 'dcr' };
  } else if (clientId.startsWith('http')) {
    const meta = await fetchClientMetadata(clientId);
    client = { id: meta.clientId, name: meta.clientName, host: new URL(clientId).host, redirectUris: meta.redirectUris, loopbackOnly: false, kind: 'cimd' };
  } else {
    throw new OAuthError('invalid_client', 'client_id must be an https metadata URL or a registered client id');
  }
  client.loopbackOnly = client.redirectUris.every((r) => { try { const u = new URL(r); return u.protocol === 'http:' && isLoopbackHost(u.hostname); } catch { return false; } });
  if (!client.redirectUris.some((r) => redirectUriMatches(r, redirectUri))) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri is not registered for this client');
  }
  return client;
}
