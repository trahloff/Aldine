/**
 * Every response that carries the app's index.html forbids framing: the root,
 * the OAuth consent page and any client-side route. Built with a stub
 * WEB_DIST; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-spa-framing-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
for (const k of ['ALDINE_BASE_PATH', 'ALDINE_PUBLIC_URL', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP', 'SENTRY_DSN']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'dist', 'assets'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><html><head><title>Aldine</title></head><body><div id="root"></div></body></html>');
fs.writeFileSync(path.join(tmp, 'dist', 'assets', 'index-abc.js'), 'console.log("app")');

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

for (const url of ['/', '/oauth/authorize?client_id=aldc_x&redirect_uri=https%3A%2F%2Fclaude.test%2Fcb&response_type=code', '/project/abc123', '/index.html']) {
  const res = await app.inject({ method: 'GET', url });
  eq(res.statusCode, 200, `${url} serves the app`);
  check(res.body.includes('<div id="root">'), `${url} is the index`);
  eq(res.headers['content-security-policy'], "frame-ancestors 'none'", `${url} forbids framing by CSP`);
  eq(res.headers['x-frame-options'], 'DENY', `${url} forbids framing for browsers without frame-ancestors`);
}
const asset = await app.inject({ method: 'GET', url: '/assets/index-abc.js' });
eq(asset.statusCode, 200, 'assets are still served');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('spa-framing: all assertions passed');
process.exit(0);
