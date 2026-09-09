import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

/**
 * Optional error tracking. Structured error logging is always on; Sentry is
 * enabled only when SENTRY_DSN is set (and @sentry/node is installed). Dynamic
 * import keeps it out of the hot path and tolerant of a missing package.
 */
let sentry: { captureException(e: unknown): void } | null = null;

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

interface ScrubbableEvent {
  request?: { url?: string; query_string?: unknown; data?: unknown; cookies?: unknown; headers?: unknown };
}

/**
 * What leaves the instance with an error. A URL's query carries the things a
 * document platform must not hand to a third party: the path of the file being
 * read, the branch, and the signature on a PDF link (a valid credential for
 * that artifact until it expires). Headers can carry the session cookie or an
 * access token. The stack frames and the message are the diagnosis; none of
 * this is.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const req = event.request;
  if (req) {
    if (typeof req.url === 'string') req.url = req.url.split('?')[0];
    delete req.query_string;
    delete req.data;
    delete req.cookies;
    delete req.headers;
  }
  return event;
}

export interface SentrySettings { dsn: string; environment: string; release: string }

/**
 * Settings for this process, or null when error tracking is off. The
 * environment is its own variable rather than NODE_ENV: a staging deployment
 * runs NODE_ENV=production like every other production build, and errors filed
 * under the wrong environment are worse than none. A test run never reports —
 * a developer machine often exports SENTRY_DSN for another project, and the
 * suites would file this app's errors into it.
 */
export function sentrySettings(env: NodeJS.ProcessEnv = process.env): SentrySettings | null {
  const dsn = env.SENTRY_DSN;
  if (!dsn || env.ALDINE_TEST_HOOKS === '1') return null;
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'production',
    // The build a trace belongs to: prod and staging run different commits.
    release: env.SENTRY_RELEASE || env.ALDINE_VERSION || pkg.version,
  };
}

export async function initObservability(app: FastifyInstance): Promise<void> {
  const settings = sentrySettings();
  if (settings) {
    try {
      const Sentry = await import('@sentry/node');
      Sentry.init({
        dsn: settings.dsn,
        environment: settings.environment,
        release: settings.release,
        tracesSampleRate: 0,
        sendDefaultPii: false,
        beforeSend: (event) => scrubEvent(event),
      });
      sentry = Sentry;
      console.log(`[aldine] Sentry error tracking enabled — environment ${settings.environment}, release ${settings.release}`);
    } catch {
      console.warn('[aldine] SENTRY_DSN is set but @sentry/node is not installed — run `npm i @sentry/node` to enable it');
    }
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode;
    req.log.error({ err, url: req.url, method: req.method }, 'request error');
    if (!status || status >= 500) captureError(err);
    if (!reply.sent) {
      reply.code(status && status < 500 ? status : 500)
        .send({ error: status && status < 500 ? err.message : 'Internal server error' });
    }
  });
}

export function captureError(e: unknown): void {
  if (sentry) { try { sentry.captureException(e); } catch { /* never let telemetry throw */ } }
}
