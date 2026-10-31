/**
 * Every MCP tool tells the client what it is and whether it changes anything,
 * as read from a real tools/list: a non-empty title (top-level and in
 * annotations, the same text), an explicit readOnlyHint and openWorldHint,
 * and for each tool that is not read-only an explicit destructiveHint and
 * idempotentHint. A hint left out takes the spec default (writes, destroys,
 * reaches the internet), which makes a client ask before harmless calls, and
 * connector directories refuse a tool without a title and a read-only or
 * destructive hint.
 *
 * The expected hints of the tools that change something are pinned below, so
 * downgrading a destructive tool to a harmless one is a reviewed change.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mcp-annotations-'));
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { createMcpServer } = await import('../src/mcp/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const server = createMcpServer({ user: null, tokenScope: null }, '');
await server.connect(serverSide);
const client = new Client({ name: 'aldine-annotations', version: '0.0.0' });
await client.connect(clientSide);

const { tools } = await client.listTools();
check(tools.length >= 16, `tools/list serves every tool (got ${tools.length})`);

for (const t of tools) {
  const a = t.annotations ?? {};
  check(typeof t.title === 'string' && t.title.trim() !== '', `${t.name}: has a title`);
  check(a.title === t.title, `${t.name}: annotations.title matches the title (got ${JSON.stringify(a.title)} vs ${JSON.stringify(t.title)})`);
  check(/^[A-Z]/.test(t.title) && !/\.$/.test(t.title), `${t.name}: the title is sentence case without a full stop (got ${JSON.stringify(t.title)})`);
  check(typeof a.readOnlyHint === 'boolean', `${t.name}: sets readOnlyHint`);
  check(typeof a.openWorldHint === 'boolean', `${t.name}: sets openWorldHint`);
  if (a.readOnlyHint === false) {
    check(typeof a.destructiveHint === 'boolean', `${t.name}: changes something, so it sets destructiveHint`);
    check(typeof a.idempotentHint === 'boolean', `${t.name}: changes something, so it sets idempotentHint`);
  }
}

const titles = tools.map((t) => t.title);
check(new Set(titles).size === titles.length, `titles are distinct (got ${titles.join(', ')})`);

const WRITES = {
  edit_file: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  write_file: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  batch_write: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  compile: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  commit: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  references_add: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  create_project: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  trash_project: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
};
for (const t of tools) {
  const want = WRITES[t.name];
  if (!want) {
    check(t.annotations.readOnlyHint === true, `${t.name}: is read-only (or belongs in WRITES with its hints)`);
    continue;
  }
  check(t.annotations.readOnlyHint === false, `${t.name}: is not read-only`);
  for (const [hint, value] of Object.entries(want)) {
    check(t.annotations[hint] === value, `${t.name}: ${hint} is ${value} (got ${t.annotations[hint]})`);
  }
}
for (const name of Object.keys(WRITES)) check(tools.some((t) => t.name === name), `tool ${name} is listed`);

await client.close();
await server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`MCP annotations: ALL PASSED (${tools.length} tools)`);
process.exit(0);
