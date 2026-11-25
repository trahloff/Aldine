/**
 * What the error tracker would be sent, read off the SDK's own transport.
 * observability.test.mjs pins the scrubbing as a pure function; this runs
 * the real SDK behind a real Fastify error handler, because what the SDK
 * collects by itself changes between its versions (11 began recording
 * request bodies, cookies, headers and local variables unless told not to).
 *
 * Every secret below is made at run time: a literal would sit in this file's
 * own source lines, which a stack frame legitimately quotes.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { check, eq } from './assert.mjs';

process.env.SENTRY_DSN = 'https://key@o1.ingest.de.sentry.io/2';
process.env.SENTRY_ENVIRONMENT = 'envelope-test';
process.env.ALDINE_VERSION = '9.9.9';
delete process.env.ALDINE_TEST_HOOKS;
delete process.env.SENTRY_RELEASE;

const Sentry = await import('@sentry/node');
const { initObservability, captureError, NOTHING_COLLECTED } = await import('../src/observability.ts');

const made = () => crypto.randomBytes(9).toString('hex');
const secret = {
  cookie: made(), bearer: made(), body: made(), signature: made(), person: made(),
  outgoingKey: made(), gitToken: made(), projectId: made(), consoleLine: made(),
};
const email = `${secret.person}@example.org`;

// A service Aldine calls while handling the request (Zotero, a git host):
// it must not receive trace headers that tie the call to an error report.
const outgoing = [];
const other = http.createServer((req, res) => { outgoing.push(req.headers); res.end('ok'); });
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const otherUrl = `http://127.0.0.1:${other.address().port}`;

const sent = [];
const transport = (options) => Sentry.createTransport(options, async (request) => {
  sent.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8'));
  return { statusCode: 200 };
});
const items = () => sent.flatMap((body) => {
  const lines = body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const out = [];
  for (let i = 1; i + 1 < lines.length; i += 2) out.push({ type: lines[i].type, payload: lines[i + 1] });
  return out;
});

const log = console.log;
console.log = () => {};
const app = Fastify();
await initObservability(app, transport);
console.log = log;

app.post('/api/projects/:id/boom', async (req) => {
  const draft = req.body.content; // a local variable holding the document
  console.warn(`[aldine] ${secret.consoleLine} approved ${email}`);
  await fetch(`${otherUrl}/items?key=${secret.outgoingKey}`);
  execFileSync(process.execPath, ['-e', '0', `https://oauth2:${secret.gitToken}@git.example.org/x.git`]);
  throw new Error(`push to https://oauth2:${secret.gitToken}@git.example.org/x.git failed for ${email} (${draft.length})`, { cause: new Error('the remote hung up') });
});
app.get('/api/projects/:id/gone', async () => { throw Object.assign(new Error('project not found'), { statusCode: 404 }); });

const warn = console.warn;
console.warn = () => {};
const res = await app.inject({
  method: 'POST', url: `/api/projects/${secret.projectId}/boom?branch=main&sig=${secret.signature}`,
  headers: { cookie: `aldine_session=${secret.cookie}`, authorization: `Bearer ${secret.bearer}` },
  payload: { content: `\\section{${secret.body}}` },
});
console.warn = warn;
eq(res.statusCode, 500, 'the route fails with a 500');
eq(res.json().error, 'Internal server error', 'and the response says nothing more');
await Sentry.flush(5000);

// ---- one error event, nothing else ----
let got = items();
eq(got.map((i) => i.type), ['event'], 'one envelope item, an error event: no session, no span, no log, no client report');
const event = got[0].payload;
const wire = sent.join('\n');
for (const [what, value] of Object.entries(secret)) {
  check(!wire.includes(value), `the ${what} never leaves the instance`);
}

// ---- what the event does hold ----
eq(event.environment, 'envelope-test', 'the environment');
eq(event.release, '9.9.9', 'the release');
eq(event.tags, { route: '/api/projects/:id/boom', method: 'POST' }, 'the route as registered and the method, not the URL');
const values = event.exception.values;
check(values.some((v) => v.value === 'the remote hung up'), 'the cause of the error is reported with it');
const top = values[values.length - 1];
check(top.value.startsWith('push to https://[redacted]@') && top.value.includes('[email]'), `the message is scrubbed (got ${top.value})`);
const frames = values.flatMap((v) => v.stacktrace?.frames ?? []);
check(frames.some((f) => String(f.filename).endsWith('sentry-envelope.test.mjs')), 'the stack names the file that threw');
check(frames.every((f) => f.vars === undefined), 'no frame carries local variables');
eq(event.request, undefined, 'no request data');
eq(event.user, undefined, 'no user');
eq(event.breadcrumbs, undefined, 'no trail of console lines, outgoing requests or spawned commands');
eq(event.modules, undefined, 'no list of installed modules');
// SpanStreaming is the one the SDK adds whatever it is told; with tracing
// off it has no span to send, which the item list above shows.
eq([...event.sdk.integrations].sort(), ['Context', 'ContextLines', 'Dedupe', 'EventFilters', 'LinkedErrors', 'OnUncaughtException', 'SpanStreaming'],
  'the SDK runs the six integrations Aldine names and none of its other defaults');

// ---- the service called during the request ----
eq(outgoing.length, 1, 'the outgoing request was made');
check(!('sentry-trace' in outgoing[0]) && !('baggage' in outgoing[0]) && !('traceparent' in outgoing[0]),
  'a request to another service carries no trace headers');

// ---- a refusal is not an error ----
eq((await app.inject({ method: 'GET', url: `/api/projects/${secret.projectId}/gone` })).statusCode, 404, 'a 404 stays a 404');
await Sentry.flush(5000);
eq(items().length, 1, 'a 4xx is not reported');

// ---- an error outside a request ----
captureError(new Error('background task failed'));
await Sentry.flush(5000);
got = items();
eq(got.length, 2, 'an error outside a request is reported');
eq(got[1].payload.tags, undefined, 'without route tags');

// ---- every category off ----
const off = (v) => v === false || (Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && Object.values(v).every(off));
check(Object.values(NOTHING_COLLECTED).every(off), 'every data-collection category is off');

other.close();
console.log('sentry-envelope: ALL PASSED');
process.exit(0);
