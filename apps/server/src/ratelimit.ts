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

// Atomic refill+consume. KEYS[1]=bucket, ARGV=capacity, refillPerSec, now(ms).
const BUCKET_LUA = `
local d = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = tonumber(d[1]); local last = tonumber(d[2])
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
if tokens == nil then tokens = cap; last = now end
tokens = math.min(cap, tokens + ((now - last) / 1000) * rate)
local ok = 0
if tokens >= 1 then tokens = tokens - 1; ok = 1 end
redis.call('HMSET', KEYS[1], 't', tokens, 'l', now)
redis.call('PEXPIRE', KEYS[1], 3600000)
return ok`;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private name: string, private capacity: number, private refillPerSec: number) {
    setInterval(() => this.sweep(), 300_000).unref?.();
  }

  /** Returns true if allowed (and consumes a token), false if rate-limited. */
  async take(key: string, now = Date.now()): Promise<boolean> {
    if (redis) {
      try {
        const ok = await redis.eval(BUCKET_LUA, 1, `rl:${this.name}:${key}`, this.capacity, this.refillPerSec, now);
        return ok === 1;
      } catch { /* redis hiccup → fall back to this node's in-memory bucket */ }
    }
    return this.takeLocal(key, now);
  }

  private takeLocal(key: string, now: number): boolean {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, last: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.last) / 1000) * this.refillPerSec);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private sweep(now = Date.now()): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens >= this.capacity && now - b.last > 600_000) this.buckets.delete(k);
    }
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
