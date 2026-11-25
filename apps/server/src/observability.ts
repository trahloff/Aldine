import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

/**
 * Optional error tracking. Structured error logging is always on; Sentry is
 * enabled only when SENTRY_DSN is set (and @sentry/node is installed). Dynamic
 * import keeps it out of the hot path and tolerant of a missing package.
 */
let sentry: { captureException(e: unknown, hint?: { tags?: Record<string, string> }): unknown } | null = null;

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

interface ScrubbableEvent {
  request?: { url?: string; query_string?: unknown; data?: unknown; cookies?: unknown; headers?: unknown };
  message?: string;
  exception?: { values?: Array<{ value?: string; stacktrace?: { frames?: Array<{ vars?: unknown }> } }> };
  breadcrumbs?: unknown;
  user?: unknown;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// The userinfo of a URL (`https://oauth2:<token>@github.com/...`): git
// tokens travel inline per operation, so a git error can quote one.
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const URL_QUERY_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi;

/** A message or exception text with addresses, URL credentials and URL queries cut. */
export function scrubText(s: string): string {
  return s.replace(URL_USERINFO_RE, '$1[redacted]@').replace(URL_QUERY_RE, '$1').replace(EMAIL_RE, '[email]');
}

/**
 * What leaves the instance with an error. A URL's query carries the things a
 * document platform must not hand to a third party: the path of the file being
 * read, the branch, and the signature on a PDF link (a valid credential for
 * that artifact until it expires). Headers can carry the session cookie or an
 * access token. Messages can name a person by email or quote a git URL with
 * its token. The stack frames and the message are the diagnosis; none of
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
  // Breadcrumbs repeat console lines and outgoing request URLs, which name
  // people and carry API keys in queries; the stack is the diagnosis.
  delete event.breadcrumbs;
  delete event.user;
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  for (const v of event.exception?.values ?? []) {
    if (typeof v.value === 'string') v.value = scrubText(v.value);
    // A frame's local variables hold whatever the function was working on:
    // the text of a file, a token, an address.
    for (const frame of v.stacktrace?.frames ?? []) delete frame.vars;
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

type Sentry = typeof import('@sentry/node');
type SentryOptions = NonNullable<Parameters<Sentry['init']>[0]>;

/**
 * Every category the SDK can collect, off. Typed as complete on purpose: a
 * category a later SDK adds fails the typecheck here instead of arriving
 * switched on, which is how version 11 introduced most of these.
 */
export const NOTHING_COLLECTED: Required<Omit<NonNullable<SentryOptions['dataCollection']>, 'frameContextLines'>> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

/**
 * What the SDK is started with. The integrations are named one by one
 * instead of taking the SDK's defaults: the defaults record console lines,
 * outgoing request URLs, the arguments of spawned git commands and local
 * variables as a trail on every event, add trace headers to requests Aldine
 * makes to other services, and grow with each SDK version. These six report
 * an error with its stack, its causes and the source lines around it, and
 * nothing about the request or the person. No tracesSampleRate: tracing is
 * off, not sampled at zero, so the span-streaming integration the SDK adds
 * regardless has nothing to send.
 */
export function sentryOptions(sdk: Sentry, settings: SentrySettings): SentryOptions {
  return {
    dsn: settings.dsn,
    environment: settings.environment,
    release: settings.release,
    defaultIntegrations: false,
    integrations: [
      sdk.eventFiltersIntegration(),
      sdk.linkedErrorsIntegration(),
      sdk.dedupeIntegration(),
      sdk.contextLinesIntegration(),
      sdk.nodeContextIntegration(),
      sdk.onUncaughtExceptionIntegration(),
    ],
    dataCollection: NOTHING_COLLECTED,
    sendClientReports: false,
    beforeSend: (event) => scrubEvent(event),
  };
}

/** `transport` replaces the SDK's HTTP transport; a test reads what would be sent through it. */
export async function initObservability(app: FastifyInstance, transport?: SentryOptions['transport']): Promise<void> {
  const settings = sentrySettings();
  if (settings) {
    try {
      const Sentry = await import('@sentry/node');
      Sentry.init({ ...sentryOptions(Sentry, settings), ...(transport ? { transport } : {}) });
      sentry = Sentry;
      console.log(`[aldine] Sentry error tracking enabled — environment ${settings.environment}, release ${settings.release}`);
    } catch {
      console.warn('[aldine] SENTRY_DSN is set but @sentry/node is not installed — run `npm i @sentry/node` to enable it');
    }
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode;
    req.log.error({ err, url: req.url, method: req.method }, 'request error');
    // The route as registered (`/api/projects/:id/file`), never the URL: the
    // pattern says where it failed without naming a project or a file.
    if (!status || status >= 500) captureError(err, { route: req.routeOptions?.url ?? 'unmatched', method: req.method });
    if (!reply.sent) {
      reply.code(status && status < 500 ? status : 500)
        .send({ error: status && status < 500 ? err.message : 'Internal server error' });
    }
  });
}

export function captureError(e: unknown, tags?: Record<string, string>): void {
  if (sentry) { try { sentry.captureException(e, tags ? { tags } : undefined); } catch { /* never let telemetry throw */ } }
}
