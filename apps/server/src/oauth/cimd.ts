import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { OAuthError } from './errors.js';

/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document):
 * a client_id that is an https URL names a JSON document describing the
 * client. This is what claude.ai and Claude Code present by default.
 *
 * The fetch is the one place Aldine makes an outbound request to a URL an
 * anonymous visitor chose, so it is SSRF-hardened: https only, default port,
 * no userinfo, the hostname is resolved first and EVERY address checked
 * against loopback/private/link-local/metadata ranges, and the connection is
 * then made to the checked address (TLS still verifies the hostname) — a
 * second resolution at connect time is what DNS rebinding exploits. No
 * redirects are followed, 5 s budget, 64 KB cap, successes cached 5 minutes.
 *
 * ALDINE_TEST_ALLOW_LOOPBACK_CIMD=1 lifts the https/port/private-address
 * rules so a unit test can serve a document from a loopback stub. Never set
 * it in a deployment.
 */

export const CIMD_TIMEOUT_MS = 5_000;
export const CIMD_MAX_BYTES = 64 * 1024;
export const CIMD_CACHE_MS = 5 * 60 * 1000;
/** Distinct client_ids held at once; the endpoint is anonymous, so the map must not grow with attacker-chosen URLs. */
export const CIMD_CACHE_MAX = 256;

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

const testLoopback = () => process.env.ALDINE_TEST_ALLOW_LOOPBACK_CIMD === '1';

/** Draft §3 URL rules. Throws invalid_client with a reason the consent page can show. */
export function parseClientIdUrl(clientId: string): URL {
  let u: URL;
  try { u = new URL(clientId); } catch { throw new OAuthError('invalid_client', 'client_id is not a valid URL'); }
  if (u.protocol !== 'https:' && !(testLoopback() && u.protocol === 'http:')) throw new OAuthError('invalid_client', 'client_id must be an https URL');
  if (u.username || u.password) throw new OAuthError('invalid_client', 'client_id must not contain credentials');
  if (u.hash) throw new OAuthError('invalid_client', 'client_id must not contain a fragment');
  if (u.port && !testLoopback()) throw new OAuthError('invalid_client', 'client_id must use the default https port');
  if (u.pathname === '/' || u.pathname === '') throw new OAuthError('invalid_client', 'client_id must have a path');
  if (u.pathname.split('/').some((seg) => seg === '.' || seg === '..')) throw new OAuthError('invalid_client', 'client_id must not contain . or .. path segments');
  if (u.href !== clientId) throw new OAuthError('invalid_client', 'client_id must be a normalised URL');
  return u;
}

// ---- address policy ----

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
}

/** Expand an IPv6 literal to 8 hextets (numbers); null when unparsable. */
function v6Parts(ip: string): number[] | null {
  let s = ip;
  // Embedded IPv4 tail (::ffff:1.2.3.4) → two hextets.
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const n = ipv4ToInt(m[2]);
    s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail].map((h) => parseInt(h || '0', 16));
  return parts.length === 8 && parts.every((x) => x >= 0 && x <= 0xffff) ? parts : null;
}
function v6Blocked(ip: string): boolean {
  const p = v6Parts(ip);
  if (!p) return true;
  const isV4Mapped = p.slice(0, 5).every((x) => x === 0) && p[5] === 0xffff;
  if (isV4Mapped) return v4Blocked(`${p[6] >> 8}.${p[6] & 0xff}.${p[7] >> 8}.${p[7] & 0xff}`);
  if (p.every((x) => x === 0)) return true;                       // ::
  if (p.slice(0, 7).every((x) => x === 0) && p[7] === 1) return true; // ::1
  if ((p[0] & 0xfe00) === 0xfc00) return true;                     // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true;                     // fe80::/10 link-local
  if ((p[0] & 0xff00) === 0xff00) return true;                     // ff00::/8 multicast
  if (p[0] === 0x64 && p[1] === 0xff9b) return true;               // 64:ff9b::/96 NAT64
  if (p[0] === 0x2001 && p[1] === 0x0db8) return true;             // documentation
  return false;
}

/** True when connecting to this address could reach something that is not the public internet. */
export function isBlockedAddress(ip: string): boolean {
  if (testLoopback()) return false;
  const fam = net.isIP(ip);
  if (fam === 4) return v4Blocked(ip);
  if (fam === 6) return v6Blocked(ip);
  return true;
}

// ---- fetch ----

interface Fetched { status: number; contentType: string; body: string }

/**
 * Resolve, check every address, connect to the first checked one. The whole
 * operation — lookup, connect, headers and body — runs under ONE deadline of
 * CIMD_TIMEOUT_MS: the socket `timeout` option alone is an idle timer that a
 * trickling server resets with every byte.
 */
async function fetchChecked(u: URL): Promise<Fetched> {
  const timedOut = () => new OAuthError('invalid_client', 'The client metadata document did not load in time');
  let expired = false;
  let abort: () => void = () => { expired = true; };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort(); reject(timedOut()); }, CIMD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, connectAndRead(u, () => expired, (req) => {
      abort = () => { expired = true; req.destroy(timedOut()); };
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function connectAndRead(u: URL, isExpired: () => boolean, onRequest: (req: http.ClientRequest) => void): Promise<Fetched> {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new OAuthError('invalid_client', 'The client_id host could not be resolved');
    }
  }
  // The lookup cannot be cancelled; a late answer must not open a socket.
  if (isExpired()) throw new OAuthError('invalid_client', 'The client metadata document did not load in time');
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new OAuthError('invalid_client', 'The client_id host is not a public address');
  }
  const address = addresses[0];
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise<Fetched>((resolve, reject) => {
    const fail = (why: string) => reject(new OAuthError('invalid_client', why));
    const req = lib.request({
      host: address,
      port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
      servername: net.isIP(host) ? undefined : host,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { host: u.host, accept: 'application/json', 'user-agent': 'aldine-oauth' },
      timeout: CIMD_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > CIMD_MAX_BYTES) { req.destroy(new OAuthError('invalid_client', 'The client metadata document is too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => { done = true; resolve({ status: res.statusCode || 0, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }); });
      // A socket dropped mid-body is the client's fault, never a server_error:
      // both the 'error' (ECONNRESET/aborted) and a 'close' before 'end' map
      // to the same typed invalid_client the consent page can show.
      res.on('error', () => fail('The client metadata document could not be fetched'));
      res.on('close', () => { if (!done) fail('The client metadata document could not be fetched'); });
    });
    onRequest(req);
    req.on('timeout', () => req.destroy(new OAuthError('invalid_client', 'The client metadata document did not load in time')));
    req.on('error', (err) => reject(err instanceof OAuthError ? err : new OAuthError('invalid_client', 'The client metadata document could not be fetched')));
    req.end();
  });
}

/** Draft §4 document rules. Exported for the DCR validator to share the redirect-URI shape check. */
export function parseClientMetadata(clientId: string, doc: unknown): ClientMetadata {
  const bad = (why: string) => new OAuthError('invalid_client', `The client metadata document is invalid: ${why}`);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('not a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) throw bad('client_id does not match the document URL');
  if (typeof d.client_name !== 'string' || !d.client_name.trim()) throw bad('client_name is missing');
  if ('client_secret' in d || 'client_secret_expires_at' in d) throw bad('a metadata document must not carry a client secret');
  if (typeof d.token_endpoint_auth_method === 'string' && d.token_endpoint_auth_method.startsWith('client_secret_')) throw bad('client_secret authentication is not allowed');
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.length || d.redirect_uris.length > 20) throw bad('redirect_uris is missing');
  const redirectUris = d.redirect_uris.map((r) => {
    if (typeof r !== 'string' || !isAllowedRedirectUri(r)) throw bad('redirect_uris must be https or loopback http URLs');
    return r;
  });
  return { clientId, clientName: d.client_name.trim().slice(0, 100), redirectUris };
}

/** Redirect URIs an AS may send a code to: https, or RFC 8252 loopback http. No fragments. */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password || uri.length > 2000) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

const cache = new Map<string, { meta: ClientMetadata; exp: number }>();
const inflight = new Map<string, Promise<ClientMetadata>>();

/** Fetch and validate the document at `clientId`. Errors are never cached. */
export function fetchClientMetadata(clientId: string, now = Date.now()): Promise<ClientMetadata> {
  const hit = cache.get(clientId);
  if (hit && hit.exp > now) return Promise.resolve(hit.meta);
  const pending = inflight.get(clientId);
  if (pending) return pending;
  const p = (async () => {
    const u = parseClientIdUrl(clientId);
    const res = await fetchChecked(u);
    if (res.status !== 200) throw new OAuthError('invalid_client', `The client metadata document returned HTTP ${res.status}`);
    if (!/^application\/([a-z0-9.+-]+\+)?json\b/i.test(res.contentType)) throw new OAuthError('invalid_client', 'The client metadata document is not JSON');
    let doc: unknown;
    try { doc = JSON.parse(res.body); } catch { throw new OAuthError('invalid_client', 'The client metadata document is not valid JSON'); }
    const meta = parseClientMetadata(clientId, doc);
    remember(clientId, meta);
    return meta;
  })();
  inflight.set(clientId, p);
  return p.finally(() => inflight.delete(clientId));
}

/** Evict what has expired, then the oldest entries, so the map never exceeds CIMD_CACHE_MAX. */
function remember(clientId: string, meta: ClientMetadata, now = Date.now()): void {
  cache.delete(clientId);
  for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
  while (cache.size >= CIMD_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(clientId, { meta, exp: now + CIMD_CACHE_MS });
}

/** Test hook: forget cached documents. */
export function resetCimdCacheForTests(): void {
  cache.clear();
}

/** Test hook: how many documents are cached right now. */
export function cimdCacheSizeForTests(): number {
  return cache.size;
}
