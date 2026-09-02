import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { registerRoutes } from './routes.js';
import { hocuspocus, flushAllDocs, closeProjectConnections } from './collab.js';
import { initProjectEvents } from './events.js';
import { commitAll } from './gitops.js';
import * as store from './store.js';
import { initObservability, captureError } from './observability.js';
import { initDb, closeDb } from './db/index.js';
import { initRateLimit } from './ratelimit.js';

// Never let a stray rejection take down the collaboration server.
process.on('unhandledRejection', (reason) => { console.error('[aldine] unhandledRejection', reason); captureError(reason); });

// Select and connect the datastore (JSON default, or Postgres via DATABASE_URL) before anything uses it.
await initDb();
// Connect Redis for cross-node rate limiting if REDIS_URL is set (else in-memory).
await initRateLimit();
// Cross-node revocation: when a peer node changes a project's access, close
// our local collab sockets for it so clients re-authenticate. No-op without Redis.
initProjectEvents({ onAccessChanged: closeProjectConnections });

// trustProxy makes req.ip honor X-Forwarded-For — enable ONLY behind a trusted
// reverse proxy (Caddy/nginx). Off by default so clients can't spoof their IP
// to evade rate limits or lock others out.
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 32 * 1024 * 1024, trustProxy: process.env.TRUST_PROXY === '1' });

await initObservability(app);
await registerRoutes(app);

// MCP endpoint (agent connector), env-gated. Dynamic import keeps the SDK out
// of the boot path entirely when the feature is off.
if (process.env.ALDINE_MCP === '1') {
  const { registerMcp } = await import('./mcp/server.js');
  await registerMcp(app);
}

// Serve the built frontend (production). In dev, Vite serves it and proxies to us.
if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
  await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    // /oauth/authorize is the SPA's consent page; the other /oauth/* paths and
    // /.well-known/* are protocol endpoints that must never answer with HTML.
    const api = req.url.startsWith('/api') || req.url.startsWith('/plugins') || req.url.startsWith('/collab')
      || req.url.startsWith('/.well-known') || (req.url.startsWith('/oauth/') && !req.url.startsWith('/oauth/authorize'));
    if (api) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.type('text/html').send(fs.readFileSync(path.join(config.webDist, 'index.html')));
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });

// Yjs collaboration over WebSocket at /collab
const wss = new WebSocketServer({ noServer: true });
app.server.on('upgrade', (request, socket, head) => {
  if (request.url && request.url.startsWith('/collab')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request);
    });
  } else {
    socket.destroy();
  }
});

console.log(`[aldine] server on :${config.port} — data=${config.dataDir} compiler=${config.compilerUrl}`);

// Trash purge: hard-delete soft-deleted projects after ALDINE_TRASH_DAYS
// (default 30). Swept on boot and daily; errors are logged, never fatal.
const TRASH_DAYS = Number(process.env.ALDINE_TRASH_DAYS || 30);
const sweepTrash = () => store.purgeExpiredTrash(TRASH_DAYS)
  .then((ids) => { if (ids.length) console.log(`[aldine] trash purge: removed ${ids.length} project(s) older than ${TRASH_DAYS}d`); })
  .catch((err) => console.error('[aldine] trash purge failed', err));
sweepTrash();
setInterval(sweepTrash, 24 * 60 * 60 * 1000).unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[aldine] ${signal} — flushing ${hocuspocus.documents.size} open documents…`);
  try {
    // commit only the branches that actually had open docs (typically a handful),
    // not every project — avoids a SIGTERM fan-out of hundreds of git processes
    const dirty = flushAllDocs();
    await Promise.allSettled(dirty.map((d) => commitAll(d.projectId, d.branch, 'aldine: autosave on shutdown')));
    console.log(`[aldine] flushed ${dirty.length} project/branch(es); exiting`);
  } catch (err) {
    console.error('[aldine] shutdown flush error', err);
  }
  try { await app.close(); await closeDb(); } catch { /* noop */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
