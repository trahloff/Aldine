import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { config, gitlabConfig } from './config.js';
import { registerRoutes } from './routes.js';
import { hocuspocus, flushAllDocs, closeProjectConnections } from './collab.js';
import { initProjectEvents } from './events.js';
import { commitAll } from './gitops.js';
import * as store from './store.js';
import { initObservability, captureError } from './observability.js';
import { initDb, closeDb } from './db/index.js';
import { initRateLimit } from './ratelimit.js';
import { autoProvisionEnabled, serviceConnection, resolveGroup } from './gitlab.js';
import { gitlabTemplatesEnabled, listGitlabTemplates } from './gitlab-templates.js';
import { listLocalTemplates } from './templates.js';
import { deleteRemoteRepo } from './provision.js';

// Never let a stray rejection take down the collaboration server.
process.on('unhandledRejection', (reason) => { console.error('[aldine] unhandledRejection', reason); captureError(reason); });

// Select and connect the datastore (JSON default, or Postgres via DATABASE_URL) before anything uses it.
await initDb();
// Connect Redis for cross-node rate limiting if REDIS_URL is set (else in-memory).
await initRateLimit();
// Cross-node revocation: when a peer node changes a project's access, close
// our local collab sockets for it so clients re-authenticate. No-op without Redis.
initProjectEvents({ onAccessChanged: closeProjectConnections });

// Resolve the GitLab home group once at boot: a typo'd group name should be a
// startup warning, not a mystery failure on someone's first project. Failure is
// not fatal — project creation degrades to local-only.
if (autoProvisionEnabled()) {
  try {
    const g = await resolveGroup(serviceConnection()!, gitlabConfig.defaultGroup);
    console.log(`[gitlab] new projects will be created in ${g.full_path}`);
  } catch (err) {
    console.warn(`[gitlab] GITLAB_DEFAULT_GROUP "${gitlabConfig.defaultGroup}" could not be resolved: ${(err as Error).message}. New projects will stay local until this is fixed.`);
  }
}

// Say what the New project dialog will offer. A misspelled group or an
// unreadable directory otherwise shows up only as an empty template grid.
{
  const local = listLocalTemplates();
  console.log(`[templates] ${local.length} in ${config.templatesDir}${local.length ? `: ${local.map((t) => t.id).join(', ')}` : ' (none found)'}`);
  // Not awaited: a slow GitLab must not hold up serving. It also warms the cache,
  // so the first New project dialog opens without a round trip.
  if (gitlabTemplatesEnabled()) {
    void listGitlabTemplates('local').then((remote) => {
      if (remote.length) console.log(`[templates] ${remote.length} from GitLab group ${gitlabConfig.templateGroup}`);
      else console.warn(`[templates] GITLAB_TEMPLATE_GROUP "${gitlabConfig.templateGroup}" returned no templates — check the path and that the token can read it.`);
    });
  }
}

// trustProxy makes req.ip honor X-Forwarded-For — enable ONLY behind a trusted
// reverse proxy (Caddy/nginx). Off by default so clients can't spoof their IP
// to evade rate limits or lock others out.
// Info level so operational lines (a failed ZIP import and its reason) reach
// the hosted instance's log; per-request access lines stay off because the
// load balancer already keeps those. LOG_LEVEL=warn restores the old quiet.
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 32 * 1024 * 1024,
  trustProxy: process.env.TRUST_PROXY === '1',
});

await initObservability(app);
await registerRoutes(app);

// Serve the built frontend (production). In dev, Vite serves it and proxies to us.
if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
  await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/plugins') || req.url.startsWith('/collab')) {
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
// The remote mirror is normally deleted when a project is trashed; retry here
// for the ones where that failed (host unreachable at the time), so a purge
// never leaves an orphaned repo behind.
const sweepTrash = () => store.purgeExpiredTrash(TRASH_DAYS, async (meta) => {
  const res = await deleteRemoteRepo(meta);
  if (res.deleted) console.log(`[aldine] trash purge: also deleted the remote for ${meta.id}`);
})
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
