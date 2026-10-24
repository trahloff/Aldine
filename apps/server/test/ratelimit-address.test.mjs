/**
 * Per-address rate limits count an IPv6 client by its /64 and an IPv4-mapped
 * address as its IPv4 address, in the REST limiters (clientKey) and the /mcp
 * ones (mcpRateKeys, compileKey) alike; through the real route table, every
 * address of one /64 shares the login bucket.
 *
 * Env is set before any src import (AUTH_ENABLED, the data roots and the
 * login burst are read at module load).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-rladdr-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_LOGIN_BURST = '3';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { addressKey, clientKey } = await import('../src/ratelimit.ts');
const { mcpRateKeys, compileKey } = await import('../src/mcp/guards.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

// ---- addressKey ----
eq(addressKey('203.0.113.7'), '203.0.113.7', 'IPv4 is kept as is');
eq(addressKey('::ffff:203.0.113.7'), '203.0.113.7', 'IPv4-mapped (dotted) counts as its IPv4 address');
eq(addressKey('::FFFF:cb00:7107'), '203.0.113.7', 'IPv4-mapped (hex) counts as its IPv4 address');
eq(addressKey('0:0:0:0:0:ffff:203.0.113.7'), '203.0.113.7', 'IPv4-mapped (uncompressed) counts as its IPv4 address');
const net64 = '2001:db8:aa:cc::/64';
for (const a of ['2001:db8:aa:cc::1', '2001:db8:aa:cc:ffff:1:2:3', '2001:0DB8:00aa:00cc:0:0:0:9', '2001:db8:aa:cc::5%eth0', '2001:db8:aa:cc::192.0.2.1']) {
  eq(addressKey(a), net64, `${a} counts as its /64`);
}
eq(addressKey('2001:db8:aa:cd::1'), '2001:db8:aa:cd::/64', 'the neighbouring /64 is another client');
eq(addressKey('::1'), '0:0:0:0::/64', 'loopback reduces like any address');
eq(addressKey('2001:db8::'), '2001:db8:0:0::/64', 'a trailing :: expands');
eq(addressKey('not-an-address'), 'not-an-address', 'anything else is kept as is');

// ---- the keys the limiters use ----
eq(clientKey({ ip: '2001:db8:aa:cc::77' }), `ip:${net64}`, 'clientKey keys an IPv6 client by its /64');
eq(clientKey({ ip: '::ffff:198.51.100.4' }), 'ip:198.51.100.4', 'clientKey keys a mapped client by its IPv4 address');
eq(clientKey({ ip: '2001:db8:aa:cc::77' }, 'u1'), 'u:u1', 'a signed-in user is keyed by account');
eq(clientKey({}), 'ip:unknown', 'no address is one bucket');
eq(mcpRateKeys(undefined, '2001:db8:aa:cc::77'), [`ip:${net64}`], '/mcp keys an IPv6 client by its /64');
eq(compileKey({ user: null, tokenScope: null, ip: '2001:db8:aa:cc::77' }), `mcp:ip:${net64}`, 'the agent typeset budget keys an IPv6 client by its /64');
eq(compileKey({ user: null, tokenScope: null, ip: '203.0.113.7' }), 'mcp:ip:203.0.113.7', 'the agent typeset budget keeps IPv4 as is');

// ---- one /64 shares the login bucket ----
await auth.register('ada@example.com', 'password123', 'Ada');
const app = Fastify();
await registerRoutes(app);
const login = (remoteAddress) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { email: 'ada@example.com', password: 'wrong-password' } });
const codes = [];
for (let i = 1; i <= 6; i++) codes.push((await login(`2001:db8:aa:cc::${i.toString(16)}`)).statusCode);
eq(codes, [401, 401, 401, 429, 429, 429], 'new addresses in one /64 share the bucket');
eq((await login('2001:db8:aa:cd::1')).statusCode, 401, 'the neighbouring /64 has its own bucket');
for (let i = 0; i < 3; i++) await login('198.51.100.4');
eq((await login('::ffff:198.51.100.4')).statusCode, 429, 'the IPv4-mapped form shares the IPv4 bucket');

console.log('ratelimit-address: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
