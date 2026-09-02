/**
 * The same MCP tool registry over stdio, for Claude Code and private
 * instances: `tsx apps/server/src/mcp/stdio.ts` (same env as the server —
 * DATA_DIR/META_DIR must point at the instance's data).
 *
 * The local operator is implicitly trusted (they own the process and the
 * data dir), but when ALDINE_MCP_TOKEN is set the launcher must still present
 * it (`--token <t>` or ALDINE_MCP_CLIENT_TOKEN) so a wrapper that exposes
 * this process cannot silently bypass the configured secret.
 */

// stdout carries the protocol: anything the server modules console.log (boot
// lines, sweeps) must land on stderr or it corrupts the JSON-RPC stream.
// Redirect before the dynamic imports below evaluate any server module.
console.log = (...args: unknown[]) => console.error(...args);

const { timingSafeEqualStr } = await import('./guards.js');

const expected = process.env.ALDINE_MCP_TOKEN;
if (expected) {
  const i = process.argv.indexOf('--token');
  const presented = (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env.ALDINE_MCP_CLIENT_TOKEN;
  if (!presented || !timingSafeEqualStr(presented, expected)) {
    console.error('aldine-mcp: ALDINE_MCP_TOKEN is set — pass the same token via --token or ALDINE_MCP_CLIENT_TOKEN');
    process.exit(1);
  }
}

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { initDb } = await import('../db/index.js');
const { createMcpServer } = await import('./server.js');

// Tools go through the datastore exactly like the HTTP path.
await initDb();
const server = createMcpServer({ user: null, tokenScope: null });
await server.connect(new StdioServerTransport());
console.error('aldine-mcp: ready (stdio)');
