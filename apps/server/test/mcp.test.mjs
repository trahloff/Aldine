/**
 * MCP endpoint plumbing with AUTH_ENABLED: PAT-gated /mcp, 401 before body
 * parsing, the 2 MB body cap, the mcpLimiter, and a real Streamable HTTP
 * client round-trip against the ping tool.
 *
 * Env must be set before any src import (AUTH_ENABLED and the data roots are
 * read at module load). RL_MCP_BURST is lowered so the limiter tests do not
 * need 60+ requests. The limiter is keyed per token digest AND per IP (both
 * buckets must pass), so the limiter sections inject from dedicated client
 * addresses — 127.0.0.1 is left to the real SDK-client round-trip.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mcp-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_MCP_BURST = '10';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_MCP_TOKEN;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerMcp } = await import('../src/mcp/server.ts');
const Fastify = (await import('fastify')).default;

// Mirror production wiring: the global routes.ts hooks are registered first.
const app = Fastify();
await registerRoutes(app);
await registerMcp(app);

const user = await auth.register('ada@example.com', 'password123', 'Ada');
const { token } = await auth.createAccessToken(user.id, 'Agent', null, null);
const rpcPing = { jsonrpc: '2.0', method: 'ping', id: 1 };

// ---- auth runs before any JSON-RPC parsing ----
let res = await app.inject({ method: 'POST', url: '/mcp', remoteAddress: '203.0.113.1', payload: rpcPing });
check(res.statusCode === 401, `no credential → 401 (got ${res.statusCode})`);

res = await app.inject({ method: 'POST', url: '/mcp', remoteAddress: '203.0.113.1', headers: { authorization: 'Bearer aldn_wrongwrongwrongwrong' }, payload: rpcPing });
check(res.statusCode === 401, `wrong token → 401 (got ${res.statusCode})`);

res = await app.inject({ method: 'POST', url: '/mcp', remoteAddress: '203.0.113.1', headers: { 'x-aldine-token': 'aldn_wrongwrongwrongwrong' }, payload: rpcPing });
check(res.statusCode === 401, `wrong X-Aldine-Token → 401 (got ${res.statusCode})`);

// claude.ai reserves the Authorization header for its own OAuth bearer, so the
// token must also be accepted from X-Aldine-Token (raw, no "Bearer" prefix).
res = await app.inject({ method: 'GET', url: '/mcp', remoteAddress: '203.0.113.1', headers: { 'x-aldine-token': token } });
check(res.statusCode === 405, `X-Aldine-Token authenticates (GET → 405, got ${res.statusCode})`);

res = await app.inject({ method: 'GET', url: '/mcp', remoteAddress: '203.0.113.1', headers: { authorization: `Bearer ${token}` } });
check(res.statusCode === 405, `GET with a valid PAT → 405, stateless server offers POST only (got ${res.statusCode})`);
check(res.headers.allow === 'POST', 'the 405 names the allowed method');

// ---- ~2 MB body cap on this route only (global limit is 32 MB) ----
const bigBody = JSON.stringify({ ...rpcPing, params: { pad: 'x'.repeat(2 * 1024 * 1024 + 64) } });
res = await app.inject({ method: 'POST', url: '/mcp', remoteAddress: '203.0.113.1', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: bigBody });
check(res.statusCode === 413, `oversized body → 413 (got ${res.statusCode})`);

// ---- full Streamable HTTP round-trip with the official client ----
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const client = new Client({ name: 'aldine-test', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { authorization: `Bearer ${token}` } } },
));
const tools = await client.listTools();
const ping = tools.tools.find((t) => t.name === 'ping');
check(ping !== undefined, 'tools/list names ping');
check(ping.annotations?.readOnlyHint === true, 'ping carries readOnlyHint');
const result = await client.callTool({ name: 'ping', arguments: {} });
const body = JSON.parse(result.content[0].text);
check(body.ok === true, 'ping tool call succeeds over HTTP');
check(body.user === 'ada@example.com', 'the tool call runs as the PAT user');
await client.close();

// ---- limiter: a fresh PAT gets a bucket of RL_MCP_BURST tokens ----
const { token: rlTok } = await auth.createAccessToken(user.id, 'Limited', null, null);
const codes = [];
for (let i = 0; i < 16; i++) {
  const r = await app.inject({ method: 'GET', url: '/mcp', remoteAddress: '198.51.100.7', headers: { authorization: `Bearer ${rlTok}` } });
  codes.push(r.statusCode);
}
check(codes[0] === 405, `first request passes the limiter (got ${codes[0]})`);
check(codes.includes(429), `requests beyond the burst → 429 (got ${codes.join(',')})`);
check(!codes.slice(0, 10).includes(429), 'the burst itself is not limited');

// ---- limiter: rotating the bearer per request yields NO fresh buckets ----
// each guess is a new token digest, so only the shared IP bucket can stop a
// credential stuffer — guesses beyond the burst must 429, not keep costing
// datastore lookups at full rate
const rot = [];
for (let i = 0; i < 16; i++) {
  const r = await app.inject({ method: 'POST', url: '/mcp', remoteAddress: '198.51.100.8', headers: { authorization: `Bearer aldn_guess_number_${i}` }, payload: rpcPing });
  rot.push(r.statusCode);
}
check(rot[0] === 401, `a wrong guess inside the burst is refused as 401 (got ${rot[0]})`);
check(rot.slice(10).every((c) => c === 429), `guesses beyond the IP burst are rate limited (got ${rot.join(',')})`);

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP endpoint (PAT auth): ALL PASSED');
process.exit(0);
