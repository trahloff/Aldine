/**
 * What reaches the error tracker, and under which environment and release.
 * Both are pure functions on purpose: a test must be able to pin them without
 * a DSN, a network, or the SDK installed.
 */
import { check, eq } from './assert.mjs';

const { sentrySettings, scrubEvent } = await import('../src/observability.ts');

// ---- off unless configured ----------------------------------------------
eq(sentrySettings({}), null, 'no DSN: error tracking is off');
eq(sentrySettings({ SENTRY_DSN: '' }), null, 'an empty DSN is off, not a crash');

// A developer machine often exports SENTRY_DSN for an unrelated project; a
// test run must never file this app's errors into it.
eq(sentrySettings({ SENTRY_DSN: 'https://k@o1.ingest.de.sentry.io/2', ALDINE_TEST_HOOKS: '1' }), null,
  'the test hooks refuse a DSN outright');

// ---- environment ---------------------------------------------------------
const dsn = 'https://key@o1.ingest.de.sentry.io/2';
eq(sentrySettings({ SENTRY_DSN: dsn }).environment, 'production',
  'no hint: production, the safe assumption for a deployed instance');
eq(sentrySettings({ SENTRY_DSN: dsn, NODE_ENV: 'production', SENTRY_ENVIRONMENT: 'staging' }).environment, 'staging',
  'SENTRY_ENVIRONMENT wins: a staging box runs NODE_ENV=production like any build');
eq(sentrySettings({ SENTRY_DSN: dsn, NODE_ENV: 'development' }).environment, 'development',
  'NODE_ENV is the fallback');

// ---- release -------------------------------------------------------------
eq(sentrySettings({ SENTRY_DSN: dsn, ALDINE_VERSION: '0.7.0' }).release, '0.7.0', 'the deployed image tag');
eq(sentrySettings({ SENTRY_DSN: dsn, ALDINE_VERSION: '0.7.0', SENTRY_RELEASE: 'sha-abc1234' }).release, 'sha-abc1234',
  'SENTRY_RELEASE wins, for a build that is not a version tag');
check(/^\d+\.\d+\.\d+/.test(sentrySettings({ SENTRY_DSN: dsn }).release),
  'without either, the package version identifies the build');

// ---- what leaves the instance -------------------------------------------
const event = {
  request: {
    url: 'https://aldine.example.com/api/projects/abc123/output?branch=main&path=.aldine-out%2Fmain.pdf&exp=1&sig=deadbeef',
    query_string: 'branch=main&sig=deadbeef',
    data: { content: '\\section{Unpublished results}' },
    cookies: { aldine_session: 's3cret' },
    headers: { authorization: 'Bearer aldn_secret', 'x-aldine-token': 'aldn_secret' },
  },
  exception: { values: [{ type: 'Error', value: 'ENOENT' }] },
};
const scrubbed = scrubEvent(event);
eq(scrubbed.request.url, 'https://aldine.example.com/api/projects/abc123/output', 'the query is cut from the URL');
eq(scrubbed.request.query_string, undefined, 'no query string');
eq(scrubbed.request.data, undefined, 'no request body — it is the document');
eq(scrubbed.request.cookies, undefined, 'no cookies — the session lives there');
eq(scrubbed.request.headers, undefined, 'no headers — the access token lives there');
check(JSON.stringify(scrubbed).indexOf('sig=') === -1, 'no PDF-link signature anywhere in the event');
check(JSON.stringify(scrubbed).indexOf('aldn_') === -1, 'no access token anywhere in the event');
eq(scrubbed.exception.values[0].value, 'ENOENT', 'the diagnosis itself is untouched');

// An event without request data (a captureException outside a request) passes through.
const bare = scrubEvent({ exception: { values: [{ type: 'Error', value: 'boom' }] } });
eq(bare.exception.values[0].value, 'boom', 'an event with no request survives');

console.log('observability: ALL PASSED');
