import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { buildApp, isCollabUpgrade } from './app.js';
import { hocuspocus, flushAllDocs, closeProjectConnections } from './collab.js';
import { initProjectEvents } from './events.js';
import { commitAll } from './gitops.js';
import * as store from './store.js';
import { captureError } from './observability.js';
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

const app = await buildApp();

await app.listen({ port: config.port, host: '0.0.0.0' });

// Yjs collaboration over WebSocket at <basePath>/collab
const wss = new WebSocketServer({ noServer: true });
app.server.on('upgrade', (request, socket, head) => {
  if (isCollabUpgrade(request.url)) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request);
    });
  } else {
    socket.destroy();
  }
});

console.log(`[aldine] server on :${config.port}${config.basePath} — data=${config.dataDir} compiler=${config.compilerUrl}`);

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
