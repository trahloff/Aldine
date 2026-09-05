/**
 * Serving under a URL prefix (#27): routes stay declared at '/api/…', the
 * prefix is peeled off before routing, everything outside it is not ours, and
 * the served index.html carries the prefix for the client.
 *
 * Env must be set before any src import — the base path and the data/meta
 * roots are read at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-base-path-'));
process.env.ALDINE_BASE_PATH = '/internal/aldine';
delete process.env.ALDINE_PUBLIC_URL;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
delete process.env.AUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

// A Vite build with base './': asset references relative to index.html.
fs.mkdirSync(path.join(tmp, 'dist', 'assets'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <title>Aldine</title>',
  '    <script type="module" crossorigin src="./assets/index-abc.js"></script>',
  '    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>',
].join('\n'));
fs.writeFileSync(path.join(tmp, 'dist', 'assets', 'index-abc.js'), 'console.log("app")');

const { normalizeBasePath, publicAppUrl, config } = await import('../src/config.ts');

eq(publicAppUrl(undefined, '/x'), '', 'no public url → no trusted prefix');
eq(publicAppUrl('not a url', '/x'), '', 'malformed public url → no trusted prefix, no throw');
eq(publicAppUrl('https://server/internal/Aldine/', '/internal/Aldine'), 'https://server/internal/Aldine', 'origin + base path');
eq(publicAppUrl('https://server/ignored', '/b'), 'https://server/b', 'explicit base path wins over the url path');
eq(config.publicUrl, '', 'no ALDINE_PUBLIC_URL in this test');

eq(normalizeBasePath(undefined, undefined), '', 'unset → root');
eq(normalizeBasePath('', 'https://aldine.example.com'), '', 'public url without a path → root');
eq(normalizeBasePath('', 'https://aldine.example.com/'), '', 'public url with a bare slash → root');
eq(normalizeBasePath(undefined, 'https://server/internal/Aldine/'), '/internal/Aldine', 'path of the public url applies');
eq(normalizeBasePath('/x/', undefined), '/x', 'trailing slash dropped');
eq(normalizeBasePath('x', undefined), '/x', 'leading slash added');
eq(normalizeBasePath('/', 'https://server/y'), '', 'explicit root wins over the public url');
eq(normalizeBasePath('/a', 'https://server/b'), '/a', 'explicit base path wins over the public url');
await throws(() => normalizeBasePath('/a b', undefined), 'plain URL path', 'whitespace rejected');
eq(config.basePath, '/internal/aldine', 'config reads ALDINE_BASE_PATH');

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp, rewriteUrl, isCollabUpgrade, renderIndexHtml } = await import('../src/app.ts');
const auth = await import('../src/auth.ts');

eq(rewriteUrl('/internal/aldine'), '/', 'bare prefix → root');
eq(rewriteUrl('/internal/aldine?x=1'), '/?x=1', 'bare prefix keeps its query');
eq(rewriteUrl('/internal/aldine/api/projects?a=1'), '/api/projects?a=1', 'prefix peeled');
eq(rewriteUrl('/api/health'), '/api/health', 'root health check passes through');
check(rewriteUrl('/internal/aldine-other/x').startsWith('/__outside-base-path__/'), 'sibling path is outside');
check(rewriteUrl('/api/projects').startsWith('/__outside-base-path__/'), 'unprefixed api is outside');
check(isCollabUpgrade('/internal/aldine/collab?token=x'), 'prefixed collab upgrade accepted');
check(!isCollabUpgrade('/collab'), 'unprefixed collab upgrade refused');
check(!isCollabUpgrade(undefined), 'missing url refused');

check(auth.sessionCookie('sid').includes('Path=/internal/aldine;'), 'session cookie scoped to the base path');
check(auth.clearCookie().includes('Path=/internal/aldine;'), 'cleared cookie uses the same path');

const html = renderIndexHtml(fs.readFileSync(path.join(tmp, 'dist', 'index.html'), 'utf8'));
check(html.includes('<meta name="aldine-base-path" content="/internal/aldine/" />'), 'base path meta injected');
check(html.includes('src="/internal/aldine/assets/index-abc.js"'), 'script pinned to the base path');
check(html.includes('href="/internal/aldine/assets/index-abc.css"'), 'stylesheet pinned to the base path');
check(!html.includes('"./'), 'no document-relative reference survives');

const app = await buildApp();
const get = (url) => app.inject({ method: 'GET', url });

for (const url of ['/internal/aldine', '/internal/aldine/', '/internal/aldine/p/abc123', '/internal/aldine/index.html']) {
  const res = await get(url);
  eq(res.statusCode, 200, `${url} serves the app`);
  check(res.headers['content-type'].startsWith('text/html'), `${url} is html`);
  check(res.body.includes('aldine-base-path'), `${url} is the rendered index`);
}
let res = await get('/internal/aldine/assets/index-abc.js');
eq(res.statusCode, 200, 'asset under the prefix');
eq(res.body, 'console.log("app")', 'asset body');
res = await get('/internal/aldine/api/health');
eq(res.statusCode, 200, 'health under the prefix');
res = await get('/api/health');
eq(res.statusCode, 200, 'health at the root for container healthchecks');
res = await get('/internal/aldine/api/auth/me');
eq(res.statusCode, 200, 'api under the prefix');
eq(res.json().authEnabled, false, 'api answers');
res = await get('/internal/aldine/api/nope');
eq(res.statusCode, 404, 'unknown api route under the prefix is 404, not the app');
check(res.headers['content-type'].startsWith('application/json'), 'api 404 is json');

for (const url of ['/', '/other', '/internal', '/internal/aldine-other', '/api/projects', '/assets/index-abc.js', '/index.html']) {
  res = await get(url);
  eq(res.statusCode, 404, `${url} is outside the base path`);
  check(!res.body.includes('aldine-base-path'), `${url} does not leak the app`);
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('base-path: ok');
