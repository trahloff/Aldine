/**
 * MCP endpoint with auth disabled: no credential configured → unconditional
 * 401 plus the boot hint; ALDINE_MCP_TOKEN set → static bearer works and the
 * ping tool answers as the anonymous operator. registerMcp reads the env at
 * call time, so both configurations run in one process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mcp-static-'));
delete process.env.AUTH_ENABLED;
delete process.env.ALDINE_MCP_TOKEN;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.RL_MCP_BURST;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');

const { registerMcp } = await import('../src/mcp/server.ts');
const Fastify = (await import('fastify')).default;
const rpcPing = { jsonrpc: '2.0', method: 'ping', id: 1 };

// ---- neither AUTH_ENABLED nor ALDINE_MCP_TOKEN: 401 always + boot hint ----
const logs = [];
const origLog = console.log;
console.log = (...a) => logs.push(a.join(' '));
const app1 = Fastify();
await registerMcp(app1);
console.log = origLog;
check(logs.some((l) => l.includes('ALDINE_MCP_TOKEN')), 'boot hint names ALDINE_MCP_TOKEN');

let res = await app1.inject({ method: 'POST', url: '/mcp', payload: rpcPing });
check(res.statusCode === 401, `no credential configured → unconditional 401 (got ${res.statusCode})`);
res = await app1.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer anything-at-all' }, payload: rpcPing });
check(res.statusCode === 401, `any bearer is still 401 when nothing is configured (got ${res.statusCode})`);
await app1.close();

// ---- ALDINE_MCP_TOKEN set: timing-safe static bearer ----
process.env.ALDINE_MCP_TOKEN = 'static-test-secret';
const app2 = Fastify();
await registerMcp(app2);

res = await app2.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer wrong-secret' }, payload: rpcPing });
check(res.statusCode === 401, `wrong static token → 401 (got ${res.statusCode})`);
res = await app2.inject({ method: 'POST', url: '/mcp', payload: rpcPing });
check(res.statusCode === 401, `missing header with a configured token → 401 (got ${res.statusCode})`);

await app2.listen({ port: 0, host: '127.0.0.1' });
const port = app2.server.address().port;
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const client = new Client({ name: 'aldine-test', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { authorization: 'Bearer static-test-secret' } } },
));
const result = await client.callTool({ name: 'ping', arguments: {} });
const body = JSON.parse(result.content[0].text);
check(body.ok === true, 'ping tool call succeeds with the static token');
check(body.user === null, 'static-token calls run as the anonymous operator');
await client.close();

await app2.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP endpoint (static token): ALL PASSED');
process.exit(0);
