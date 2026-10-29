import net from 'node:net';
import { getSharedRedis, type RedisLike } from './redis.js';

/**
 * Rate limiting. In-memory token buckets by default (perfect for a single node);
 * set REDIS_URL to share limits across multiple app nodes. The Redis path uses
 * an atomic Lua token-bucket so concurrent requests can't over-consume.
 * Keys are usually `${route}:${ip}` or `${route}:${userId}`.
 */

interface Bucket { tokens: number; last: number }

let redis: RedisLike | null = null;

/** Adopt the shared Redis client if REDIS_URL is set. Call once at startup. */
export async function initRateLimit(): Promise<void> {
  if (!process.env.REDIS_URL) return;
  redis = getSharedRedis(); // null when ioredis is missing (redis.ts warned once)
  if (redis) console.log('[aldine] rate limiting: redis (shared across nodes)');
}

// Atomic refill+consume. KEYS[1]=bucket, ARGV=capacity, refillPerSec, now(ms), cost.
const BUCKET_LUA = `
local d = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = tonumber(d[1]); local last = tonumber(d[2])
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4]) or 1
if tokens == nil then tokens = cap; last = now end
tokens = math.min(cap, tokens + ((now - last) / 1000) * rate)
local ok = 0
if tokens >= cost then tokens = tokens - cost; ok = 1 end
redis.call('HMSET', KEYS[1], 't', tokens, 'l', now)
redis.call('PEXPIRE', KEYS[1], 3600000)
return ok`;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private name: string, private capacity: number, private refillPerSec: number) {
    setInterval(() => this.sweep(), 300_000).unref?.();
  }

  /** Returns true if allowed (and consumes `cost` tokens), false if
   *  rate-limited. All or nothing: a refused take consumes none. */
  async take(key: string, now = Date.now(), cost = 1): Promise<boolean> {
    if (redis) {
      try {
        const ok = await redis.eval(BUCKET_LUA, 1, `rl:${this.name}:${key}`, this.capacity, this.refillPerSec, now, cost);
        return ok === 1;
      } catch { /* redis hiccup → fall back to this node's in-memory bucket */ }
    }
    return this.takeLocal(key, now, cost);
  }

  private takeLocal(key: string, now: number, cost: number): boolean {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, last: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.last) / 1000) * this.refillPerSec);
    b.last = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  private sweep(now = Date.now()): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens >= this.capacity && now - b.last > 600_000) this.buckets.delete(k);
    }
  }
}

// Atomic check+count. KEYS[1]=state, ARGV=free, capMs, now(ms), ttlMs.
// Returns 0 (go ahead, counted) or the milliseconds still to wait.
const BACKOFF_LUA = `
local d = redis.call('HMGET', KEYS[1], 'f', 'l')
local f = tonumber(d[1]) or 0; local l = tonumber(d[2]) or 0
local free = tonumber(ARGV[1]); local cap = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
if f >= free then
  local wait = math.min(cap, 1000 * 2 ^ (f - free))
  if now < l + wait then return math.ceil(l + wait - now) end
end
redis.call('HMSET', KEYS[1], 'f', f + 1, 'l', now)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return 0`;
const DEL_LUA = `return redis.call('DEL', KEYS[1])`;

/**
 * Exponential backoff on consecutive failures per key: `free` attempts go
 * ahead at once, then each further one must wait 1, 2, 4 … seconds after the
 * previous one, at most `capSeconds`. An attempt that goes ahead counts as a
 * failure until clear(), so parallel requests cannot share one free try.
 * State is forgotten `ttlMs` after the last counted attempt. Shared through
 * Redis like RateLimiter, with the same per-node fallback.
 */
export class BackoffLimiter {
  private state = new Map<string, { f: number; l: number }>();
  constructor(private name: string, private free: number, private capSeconds: number, private ttlMs = 3_600_000) {
    setInterval(() => this.sweep(), 300_000).unref?.();
  }

  /** 0 when the attempt may go ahead (and is counted), else the milliseconds to wait. */
  async attempt(key: string, now = Date.now()): Promise<number> {
    if (redis) {
      try {
        return Number(await redis.eval(BACKOFF_LUA, 1, `rl:${this.name}:${key}`, this.free, this.capSeconds * 1000, now, this.ttlMs));
      } catch { /* redis hiccup → this node's state */ }
    }
    let s = this.state.get(key);
    if (!s || now - s.l > this.ttlMs) s = { f: 0, l: 0 };
    if (s.f >= this.free) {
      const wait = Math.min(this.capSeconds * 1000, 1000 * 2 ** (s.f - this.free));
      if (now < s.l + wait) return Math.ceil(s.l + wait - now);
    }
    this.state.set(key, { f: s.f + 1, l: now });
    return 0;
  }

  async clear(key: string): Promise<void> {
    this.state.delete(key);
    if (redis) {
      try { await redis.eval(DEL_LUA, 1, `rl:${this.name}:${key}`); } catch { /* expires on its own */ }
    }
  }

  private sweep(now = Date.now()): void {
    for (const [k, s] of this.state) if (now - s.l > this.ttlMs) this.state.delete(k);
  }
}

/**
 * At most `max` concurrent operations per key. Deliberately per-node: it protects
 * a single node's compiler from overload; the shared cost ceiling is the metered
 * compile quota (usage.ts) and the AI rate limiter.
 */
export class ConcurrencyGate {
  private active = new Map<string, number>();
  constructor(private max: number) {}
  tryAcquire(key: string): boolean {
    const n = this.active.get(key) || 0;
    if (n >= this.max) return false;
    this.active.set(key, n + 1);
    return true;
  }
  release(key: string): void {
    const n = (this.active.get(key) || 1) - 1;
    if (n <= 0) this.active.delete(key); else this.active.set(key, n);
  }
}

// Shared limiters (tuned for a small self-hosted deployment; override via env).
const n = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

/** login: 10 attempts, refill 1 / 30s → slows brute force without annoying real users. */
export const loginLimiter = new RateLimiter('login', n(process.env.RL_LOGIN_BURST, 10), 1 / 30);
/** Password sign-in per account, across every address: 5 free failures,
 *  then 1, 2, 4 … s between tries, at most 60 s. Keyed by the typed email
 *  whether or not an account has it, so the answer never says which. A
 *  browser that signed in to the account before is counted on its own key
 *  instead (auth.ts, device cookie). */
export const signInBackoff = new BackoffLimiter('signin', 5, 60);
/** Confirmation links on request: 3 per account, then 1 / 10 min. */
export const confirmResendLimiter = new RateLimiter('confirm-resend', 3, 1 / 600);
/** register: 5 accounts per client, refill 1 / 5min — bounds account-store spam. */
export const registerLimiter = new RateLimiter('register', n(process.env.RL_REGISTER_BURST, 5), 1 / 300);
/** AI fix: 20 burst, refill 1 / 12s (≈5/min sustained) — bounds LLM spend per client. */
export const aiLimiter = new RateLimiter('ai', n(process.env.RL_AI_BURST, 20), n(process.env.RL_AI_REFILL_PER_MIN, 5) / 60);
/** reference lookups (DOI/OpenAlex): 30 burst, 1/2s. */
export const refLimiter = new RateLimiter('ref', n(process.env.RL_REF_BURST, 30), 0.5);
/** at most 2 concurrent compiles per client (per node). */
export const compileGate = new ConcurrencyGate(n(process.env.RL_COMPILE_CONCURRENCY, 2));
/** Optional per-client compile budget (ALDINE_COMPILE_PER_MIN, e.g. for a public
 *  demo under launch traffic). Off by default: 0 → no limiter. */
const compilePerMin = n(process.env.ALDINE_COMPILE_PER_MIN, 0);
export const compileLimiter = compilePerMin > 0
  ? new RateLimiter('compile', Math.max(2, compilePerMin), compilePerMin / 60)
  : null;

/** Review-mark writes (one per project open): 60 burst, 1/s — bounds datastore
 *  writes from a scripted session. */
export const visitLimiter = new RateLimiter('visit', n(process.env.RL_VISIT_BURST, 60), 1);
/** MCP requests: 60 burst, 1/s sustained — keyed per token digest (fallback IP) by the /mcp guard. */
export const mcpLimiter = new RateLimiter('mcp', n(process.env.RL_MCP_BURST, 60), 1);

/** OAuth token endpoint: 30 burst, 1/s per IP — code/refresh guessing is
 *  already hopeless (256-bit secrets); this bounds datastore churn. */
export const oauthTokenLimiter = new RateLimiter('oauth-token', n(process.env.RL_OAUTH_TOKEN_BURST, 30), 1);
/** Dynamic client registration: 10 burst, 1/min per IP — bounds client-store
 *  flooding alongside the 500-client cap. */
export const oauthRegisterLimiter = new RateLimiter('oauth-register', n(process.env.RL_OAUTH_REGISTER_BURST, 10), 1 / 60);
/** Consent-page client lookups (each may fetch a client metadata URL): 60
 *  burst, 1/5s per IP — bounds outbound fetches an attacker can trigger
 *  while a lab behind one NAT can onboard several people in one sitting.
 *  The cache holds only successful lookups, so for benign traffic the burst
 *  is mostly cache hits; 60 distinct or failing client ids from one IP are
 *  60 SSRF-guarded fetches (5 s / 64 KB each) before the refill applies. */
export const oauthClientLimiter = new RateLimiter('oauth-client', n(process.env.RL_OAUTH_CLIENT_BURST, 60), 0.2);

/** Project search: 60 burst, 2/s — the panel searches as you type, 300 ms after the last key. */
export const searchLimiter = new RateLimiter('search', n(process.env.RL_SEARCH_BURST, 60), 2);
/** Replace (one or all): 30 burst, 1/2s — every replace is a commit. */
export const replaceLimiter = new RateLimiter('replace', n(process.env.RL_REPLACE_BURST, 30), 0.5);
/** Duplicate: 10 burst, 1/30s — each copy writes the whole project to disk. */
export const copyLimiter = new RateLimiter('copy', n(process.env.RL_COPY_BURST, 10), 1 / 30);
/** Invitation mails per project owner: 20 burst, refill 20 / hour, Resend
 *  included. Over it, the invitation is still made; the address goes
 *  unmailed and the owner is told to send the link. */
const inviteBurst = n(process.env.RL_INVITE_BURST, 20);
export const inviteLimiter = new RateLimiter('invite', inviteBurst, Math.max(1, inviteBurst) / 3600);
/** Invitations made per project owner: 200 burst, refill 200 / hour. Each
 *  address or ORCID iD invited from the share dialog, and each Invite again,
 *  costs one. Over it the request is refused and nothing of it is saved. */
export const shareBurst = n(process.env.RL_SHARE_BURST, 200);
export const shareLimiter = new RateLimiter('share', shareBurst, Math.max(1, shareBurst) / 3600);
/** Account changes on the admin page: 30 burst, 1 / 2 s per administrator.
 *  Bounds the reset mails and project rewrites one session can set off. */
export const adminLimiter = new RateLimiter('admin', n(process.env.RL_ADMIN_BURST, 30), 0.5);
/** Every search and replace scans in a worker of its own: one in flight per
 *  client, and at most four per process (key 'all'), so slow scans cannot
 *  take every core. */
export const searchGate = new ConcurrencyGate(1);
export const searchSlots = new ConcurrencyGate(4);

/** Agent-originated compiles: 1 in flight per user, acquired BEFORE the shared
 *  2-slot compileGate — an agent can hold at most one of the user's two slots,
 *  so the human always keeps one. */
export const agentCompileGate = new ConcurrencyGate(1);

/**
 * The client a per-address limit counts: an IPv4 address as is (IPv4-mapped
 * IPv6 included), an IPv6 address by its /64. A /64 is the smallest block a
 * subscriber is assigned, so every address inside it is one client.
 */
export function addressKey(ip: string): string {
  const addr = ip.split('%')[0].toLowerCase(); // drop an IPv6 zone index
  if (!net.isIPv6(addr)) return ip;
  let s = addr;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = (tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]).map((g) => parseInt(g, 16));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/**
 * Rate-limit key: the signed-in user when available, else the client address
 * (addressKey). req.ip is resolved by Fastify — it only honors
 * X-Forwarded-For when the server is started with trustProxy (TRUST_PROXY),
 * so an untrusted client cannot spoof the header to change its key.
 */
export function clientKey(req: { ip?: string }, userId?: string): string {
  if (userId) return `u:${userId}`;
  return `ip:${req.ip ? addressKey(req.ip) : 'unknown'}`;
}
