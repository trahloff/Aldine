import Fastify, { LogController, type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { registerRoutes } from './routes.js';
import { initObservability } from './observability.js';

const BASE = config.basePath;

/** True when a raw request URL lies under the base path ('' matches everything). */
export function underBasePath(url: string): boolean {
  if (!BASE) return true;
  if (!url.startsWith(BASE)) return false;
  const next = url.charAt(BASE.length);
  return next === '' || next === '/' || next === '?';
}

/**
 * Routes are declared once, at '/api/...', and the base path is peeled off the
 * incoming URL before routing. Requests outside the base path 404 — the rest of
 * the host belongs to whatever else is deployed there — except the two probes
 * orchestrators aim at the container's own port and root: /api/health, and a
 * bare GET / (the default health check of most load balancers), which answers
 * 200 with a one-line pointer to where the app lives.
 */
export const ROOT_POINTER = '/__base-path-root__';
export function rewriteUrl(url: string): string {
  if (!BASE) return url;
  if (url === '/api/health') return url;
  if (url === '/') return ROOT_POINTER;
  if (!underBasePath(url)) return `/__outside-base-path__${url}`;
  const rest = url.slice(BASE.length);
  return rest === '' || rest.startsWith('?') ? `/${rest}` : rest;
}

export function isCollabUpgrade(url: string | undefined): boolean {
  return !!url && rewriteUrl(url).startsWith('/collab');
}

/**
 * The built index.html is served at every app route (/, /p/<id>, …), so its
 * asset references cannot stay relative to the document: Vite emits them as
 * `./assets/…` (relative base, so chunks resolve from the loaded script's own
 * URL) and the server pins them to the base path here. The meta tag is how
 * the client learns the base path for API and websocket URLs.
 */
export function renderIndexHtml(raw: string): string {
  return raw
    .replace(/(\s(?:src|href)=")\.\//g, `$1${BASE}/`)
    .replace('<head>', `<head>\n    <meta name="aldine-base-path" content="${BASE}/" />`);
}

export async function buildApp(): Promise<FastifyInstance> {
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
    rewriteUrl: (req) => rewriteUrl(req.url || '/'),
  });

  await initObservability(app);
  await registerRoutes(app);
  // MCP endpoint (agent connector), env-gated. Dynamic import keeps the SDK out
  // of the boot path entirely when the feature is off.
  if (process.env.ALDINE_MCP === '1') {
    const { registerMcp } = await import('./mcp/server.js');
    await registerMcp(app);
  }
  if (BASE) app.get(ROOT_POINTER, async (_req, reply) => reply.type('text/plain').send(`Aldine is served at ${BASE}/\n`));

  // Serve the built frontend (production). In dev, Vite serves it and proxies to us.
  const indexFile = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexFile)) {
    const indexHtml = renderIndexHtml(fs.readFileSync(indexFile, 'utf8'));
    const sendIndex = (_req: unknown, reply: FastifyReply) => reply.type('text/html').send(indexHtml);
    // The raw index.html never goes on the wire: '/' has its own route, the
    // static plugin is told not to serve directory indexes or the file itself,
    // and every other app route lands in the not-found fallback below.
    app.get('/', sendIndex);
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      index: false,
      allowedPath: (pathname) => pathname !== '/index.html',
    });
    app.setNotFoundHandler((req, reply) => {
      // /oauth/authorize is the SPA's consent page; the other /oauth/* paths,
      // /.well-known/* and /mcp are protocol endpoints that must never answer with HTML.
      if (/^\/(api|plugins|collab|mcp|__outside-base-path__|\.well-known)(\/|$|\?)/.test(req.url) || /^\/oauth\/(?!authorize(\/|$|\?))/.test(req.url)) {
        return reply.code(404).send({ error: 'not found' });
      }
      return sendIndex(req, reply);
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not found' }));
  }

  return app;
}
