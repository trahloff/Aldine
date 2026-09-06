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
const { config } = await import('../config.js');
const { initDb, closeDb } = await import('../db/index.js');
const { ensureSigningSecret } = await import('../output-signing.js');
const { createMcpServer } = await import('./server.js');
const { shutdownFlushSet } = await import('../collab.js');
const { autoCommit } = await import('../gitops.js');

// Tools go through the datastore exactly like the HTTP path.
await initDb();
// The signer is checked at start, as index.ts does: inside the compile tool
// its failure would surface as "the compiler may not be responding".
try {
  ensureSigningSecret();
} catch (err) {
  console.error(`aldine-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
// No request to derive the origin from: links are absolute only with ALDINE_PUBLIC_URL.
const publicBase = config.publicUrl;
if (!publicBase) {
  console.error(`aldine-mcp: ALDINE_PUBLIC_URL is not set — pdfUrl and deepLink are root-relative and the inline PDF viewer is off (set it to the instance URL, path prefix included when Aldine is served under one, e.g. http://localhost:${process.env.PORT || 3000})`);
}
const server = createMcpServer({ user: null, tokenScope: null }, publicBase);

// The attribution ledger and the ~20 s debounce live in this process, and
// the client ends a session by closing stdin, then SIGTERM two seconds
// later, then SIGKILL: without this flush the next autosave (the server's,
// or the next stdio session's) sweeps the agent's delta anonymously — the
// same flush index.ts runs on a deploy. The SDK transport reads stdin but
// never closes on its end, so the end is watched here. Guarded: the stdin
// close and the SIGTERM that follows it must not commit twice.
let stopping = false;
async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    const dirty = shutdownFlushSet();
    await Promise.allSettled(dirty.map((d) => autoCommit(d.projectId, d.branch, 'aldine: autosave on shutdown')));
    if (dirty.length) console.error(`aldine-mcp: ${reason} — flushed ${dirty.length} project/branch(es)`);
  } catch (err) {
    console.error('aldine-mcp: shutdown flush error', err);
  }
  try { await closeDb(); } catch { /* noop */ }
  process.exit(0);
}
process.stdin.on('end', () => { void stop('stdin closed'); });
server.server.onclose = () => { void stop('client closed'); };
process.on('SIGTERM', () => { void stop('SIGTERM'); });
process.on('SIGINT', () => { void stop('SIGINT'); });

await server.connect(new StdioServerTransport());
console.error('aldine-mcp: ready (stdio)');
