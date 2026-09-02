import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as auth from '../auth.js';
import { mcpLimiter } from '../ratelimit.js';
import { authenticateMcp, mcpRateKeys, type McpIdentity } from './guards.js';
import { registerTools } from './tools.js';

/**
 * Streamable HTTP MCP endpoint (POST/GET /mcp), env-gated behind ALDINE_MCP=1.
 * Stateless mode: every POST gets a fresh McpServer + transport, so no session
 * state survives a request and any node behind a load balancer can serve it.
 * The SDK transport is Node req/res-oriented — requests are bridged via
 * req.raw/reply.raw with reply.hijack().
 */

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

/** Global body limit is 32 MB — far too generous for JSON-RPC tool calls. */
const MCP_BODY_LIMIT = 2 * 1024 * 1024;

/** One server per identity per request/process; tools.ts owns the registry. */
export function createMcpServer(identity: McpIdentity): McpServer {
  const server = new McpServer({ name: 'aldine', version: pkg.version });
  registerTools(server, identity);
  return server;
}

/**
 * The token may arrive as `Authorization: Bearer …` or as `X-Aldine-Token: …`.
 * Claude's connector settings reserve the Authorization header for their own
 * OAuth bearer, so a custom header is the only way a static token reaches us
 * from claude.ai; Authorization wins when both are present.
 */
function presentedCredential(req: FastifyRequest): string | undefined {
  if (req.headers.authorization) return req.headers.authorization;
  const alt = req.headers['x-aldine-token'];
  const raw = Array.isArray(alt) ? alt[0] : alt;
  return raw ? `Bearer ${raw.trim()}` : undefined;
}

export async function registerMcp(app: FastifyInstance): Promise<void> {
  const staticToken = process.env.ALDINE_MCP_TOKEN || undefined;
  if (!auth.AUTH_ENABLED && !staticToken) {
    console.log('[aldine] /mcp is enabled but has no credential configured — every request gets 401. Set AUTH_ENABLED=1 (connect with a personal access token) or set ALDINE_MCP_TOKEN.');
  }

  // onRequest runs before Fastify's body parsing, so the limiter and the auth
  // check never touch the JSON-RPC payload of an unauthenticated request.
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    const credential = presentedCredential(req);
    // Both keys (IP, then token digest) must pass — see mcpRateKeys for why
    // the IP bucket has to gate before the token-keyed one exists.
    for (const rateKey of mcpRateKeys(credential, req.ip)) {
      if (!(await mcpLimiter.take(rateKey))) {
        return reply.code(429).send({ error: 'Too many requests — slow down' });
      }
    }
    const identity = await authenticateMcp(credential, staticToken);
    if (!identity) return reply.code(401).send({ error: 'A valid access token is required' });
    (req as any)._mcpIdentity = identity;
  };

  app.post('/mcp', { bodyLimit: MCP_BODY_LIMIT, onRequest: guard }, async (req, reply) => {
    const identity = (req as any)._mcpIdentity as McpIdentity;
    const server = createMcpServer(identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // The SDK writes directly to the Node response; Fastify must not touch it again.
    reply.hijack();
    reply.raw.on('close', () => {
      server.close().catch(() => {});
      transport.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      } else {
        reply.raw.end();
      }
    }
  });

  // Stateless server: no standing SSE stream to resume and no session to
  // delete — 405 per the MCP spec, but only after the same auth guard so an
  // unauthenticated scan learns nothing.
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', { onRequest: guard }, methodNotAllowed);
  app.delete('/mcp', { onRequest: guard }, methodNotAllowed);
}
