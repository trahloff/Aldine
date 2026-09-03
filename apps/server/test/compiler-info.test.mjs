/**
 * GET /api/compiler: the compiler's own /health reports TeX Live release and
 * scheme (probed from the real server.js), the app caches a good answer and
 * retries an unreachable compiler, and a compiler that predates the report
 * comes back as "unknown" rather than an error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compiler-info-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// ---- the real compiler script ----
const here = path.dirname(fileURLToPath(import.meta.url));
const compilerJs = path.resolve(here, '../../compiler/server.js');
const schemeFile = path.join(tmp, 'texlive-scheme');
fs.writeFileSync(schemeFile, 'medium\n');
const compilerPort = await freePort();
const child = spawn(process.execPath, [compilerJs], { env: { ...process.env, PORT: String(compilerPort), DATA_DIR: path.join(tmp, 'data'), TEXLIVE_SCHEME_FILE: schemeFile }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  child.on('exit', (code) => reject(new Error(`compiler exited early: ${code}`)));
  setTimeout(() => reject(new Error('compiler did not start')), 20_000);
});

// ---- a mock compiler that predates the report, counting requests ----
let mockHits = 0;
const mock = http.createServer((req, res) => {
  mockHits++;
  const buf = Buffer.from(JSON.stringify({ ok: true }));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const deadPort = await freePort();
process.env.COMPILER_URL = `http://127.0.0.1:${deadPort}`;

const { default: Fastify } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { config } = await import('../src/config.ts');

await initDb();
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();
const info = async () => (await app.inject({ method: 'GET', url: '/api/compiler' })).json();

try {
  const health = await (await fetch(`http://127.0.0.1:${compilerPort}/health`)).json();
  eq(health.ok, true, 'real compiler answers /health');
  eq(health.texlive.scheme, 'medium', 'scheme comes from the file the Dockerfile writes');
  check(/^(20\d\d|unknown)$/.test(health.texlive.release), `release is a year or "unknown": ${health.texlive.release}`);

  // unreachable compiler: honest, not an error
  let r = await info();
  eq(r, { ok: false, texlive: { release: 'unknown', scheme: 'unknown' } }, 'unreachable compiler reports ok:false with unknowns');

  // a compiler without the report, after the retry window
  config.compilerUrl = `http://127.0.0.1:${mock.address().port}`;
  await new Promise((res) => setTimeout(res, 5_200));
  r = await info();
  eq(r, { ok: true, texlive: { release: 'unknown', scheme: 'unknown' } }, 'a /health without texlive maps to unknown');
  eq(mockHits, 1, 'one probe');
  await info();
  await info();
  eq(mockHits, 1, 'a good answer is cached: two more calls, no more probes');

  // the cache holds even when the compiler goes away
  config.compilerUrl = `http://127.0.0.1:${deadPort}`;
  eq((await info()).ok, true, 'cached answer survives the compiler going away');

  // fresh process view of the real compiler through the app: exercised via a
  // direct probe above; here only the shape contract matters.
  const real = await (await fetch(`http://127.0.0.1:${compilerPort}/health`)).json();
  eq(Object.keys(real.texlive).sort(), ['release', 'scheme'], 'health carries exactly release and scheme');

  console.log('compiler info: all checks passed');
} finally {
  child.kill();
  mock.close();
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
