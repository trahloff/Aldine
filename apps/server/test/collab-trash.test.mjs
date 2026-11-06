/**
 * Without accounts there is no collab auth hook, so the trash itself has to
 * keep a project's documents from everyone: moving a project to the trash
 * closes its live sockets, a reconnect is refused (closed as Forbidden) and
 * no document of it loads, until a restore opens them again.
 *
 * Real route table (Fastify inject) and real collab sockets
 * (HocuspocusProvider over ws), auth off, a throwaway datastore; env is set
 * before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as Y from 'yjs';
import WS, { WebSocketServer } from 'ws';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-collab-trash-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'REMOTE_PROVIDERS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { HocuspocusProvider, HocuspocusProviderWebsocket } = await import('@hocuspocus/provider');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);
await app.ready();
const wsServer = http.createServer();
const wss = new WebSocketServer({ noServer: true });
wsServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => collab.hocuspocus.handleConnection(ws, req)));
await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
const wsUrl = `ws://127.0.0.1:${wsServer.address().port}/collab`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const providers = [];
/** A browser's socket on `name`: `closes` collects the codes the server closed it with. */
function open(name) {
  const document = new Y.Doc();
  const websocketProvider = new HocuspocusProviderWebsocket({ url: wsUrl, WebSocketPolyfill: WS, quiet: false });
  const provider = new HocuspocusProvider({ websocketProvider, name, document });
  const closes = [];
  provider.on('close', ({ event }) => closes.push(event.code));
  providers.push(provider, websocketProvider);
  return { provider, closes, text: document.getText('content') };
}
const connections = (name) => collab.hocuspocus.documents.get(name)?.getConnectionsCount() ?? 0;

const p = await store.createProject('Trash me', { 'main.tex': '\\documentclass{article}\\begin{document}hi\\end{document}\n' });
const name = collab.docName(p.id, 'main', 'main.tex');
const send = (method, url) => app.inject({ method, url });
const origWarn = console.warn;
console.warn = () => {}; // the provider's own note on a Forbidden close

try {
  const a = open(name);
  await until('the doc to sync', () => a.provider.synced);
  check(a.text.toString().includes('documentclass'), 'the open doc holds the file');
  eq(connections(name), 1, 'one live socket on it');

  eq((await send('DELETE', `/api/projects/${p.id}`)).statusCode, 200, 'the project goes to the trash');
  await until('the open socket to be refused on its reconnect', () => a.closes.includes(4403));
  eq(connections(name), 0, 'nobody is connected to it any more');
  const before = a.text.toString();
  a.text.insert(0, 'typed after the trash ');
  await sleep(300);
  check(!fs.readFileSync(path.join(store.branchDir(p.id, 'main'), 'main.tex'), 'utf8').includes('typed after the trash'), 'what the old tab types reaches nobody');
  check(before.length > 0, 'the tab kept its copy');

  const b = open(name);
  await until('a fresh socket to be refused', () => b.closes.includes(4403));
  check(!b.provider.synced, 'and it never syncs');
  let loaded = null;
  try { await collab.hocuspocus.openDirectConnection(collab.docName(p.id, 'main', 'other.tex'), {}); loaded = 'loaded'; } catch (err) { loaded = err?.message ?? String(err); }
  eq(loaded, 'project not found', 'no document of a trashed project loads');

  eq((await send('POST', `/api/projects/${p.id}/restore`)).statusCode, 200, 'restored');
  const c = open(name);
  await until('a socket after the restore to sync', () => c.provider.synced);
  check(c.text.toString().includes('documentclass'), 'and it holds the file again');
  eq(connections(name), 1, 'one live socket again');
} finally {
  console.warn = origWarn;
  for (const x of providers) { try { x.destroy(); } catch { /* closed */ } }
}

await app.close();
wss.close();
wsServer.close();
console.log('collab-trash: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
