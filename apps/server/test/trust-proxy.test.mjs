/**
 * TRUST_PROXY is a hop count (or the proxies' addresses): the client address
 * is the one the trusted proxy appended to X-Forwarded-For, so an entry the
 * client wrote itself can neither change its rate-limit bucket nor pin
 * someone else's. Covers the value parsing and, through the real buildApp(),
 * the login limiter behind an appending proxy (nginx's
 * $proxy_add_x_forwarded_for, a load balancer) and a replacing one (Caddy).
 *
 * Env is set before any src import: AUTH_ENABLED, the data roots and the
 * login burst are read at module load, TRUST_PROXY when the app is built.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-trustproxy-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_LOGIN_BURST = '3';
process.env.TRUST_PROXY = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.SENTRY_DSN;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;
delete process.env.ALDINE_BASE_PATH;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { buildApp, trustProxySetting } = await import('../src/app.ts');

// ---- parsing ----
const warn = console.warn;
console.warn = () => {};
eq(trustProxySetting(undefined), false, 'unset is off');
eq(trustProxySetting(''), false, 'empty is off');
eq(trustProxySetting('0'), false, '0 is off');
eq(trustProxySetting('1'), 1, '1 trusts one hop');
eq(trustProxySetting(' 2 '), 2, 'a hop count is read as a number');
eq(trustProxySetting('loopback, 10.0.0.0/8'), 'loopback,10.0.0.0/8', 'a list of proxy names and ranges passes through');
eq(trustProxySetting('::1,fd00::/8'), '::1,fd00::/8', 'IPv6 proxy addresses and ranges pass through');
eq(trustProxySetting('true'), false, 'a word that is no address is off, never "trust everything"');
eq(trustProxySetting('10.0.0.0/8/1'), false, 'a malformed range is off');
console.warn = warn;

// ---- the login limiter behind a proxy ----
await auth.register('ada@example.com', 'password123', 'Ada');
const app = await buildApp();
// A new email per try: these count address buckets, and five failures on one
// account would bring in the per-account backoff (signin-backoff.test.mjs).
let tries = 0;
const login = (xff) => app.inject({
  method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1',
  headers: { 'x-forwarded-for': xff }, payload: { email: `try${++tries}@example.com`, password: 'wrong-password' },
});
const statuses = async (xffs) => { const out = []; for (const x of xffs) out.push((await login(x)).statusCode); return out; };
const five = (f) => Array.from({ length: 5 }, (_, i) => f(i));

// Caddy replaces the header: one entry, the client.
eq(await statuses(five(() => '203.0.113.7')), [401, 401, 401, 429, 429], 'one client behind a replacing proxy is limited after the burst');

// nginx/ALB append the client to whatever the client sent.
eq(await statuses(five((i) => `10.66.${i}.1, 203.0.113.8`)), [401, 401, 401, 429, 429], 'a client-written leftmost entry does not open new buckets');

// Nor can a client-written entry spend another client's bucket.
eq(await statuses(five(() => '203.0.113.9, 203.0.113.10')), [401, 401, 401, 429, 429], 'a client naming another address spends its own bucket');
eq((await login('203.0.113.9')).statusCode, 401, 'the address it named keeps its own bucket');
eq((await login('203.0.113.10, 203.0.113.11')).statusCode, 401, "naming the limited client's address does not limit a third");

await app.close();
console.log('trust-proxy: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
