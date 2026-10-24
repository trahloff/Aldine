/**
 * The MCP contract of docs/STABILITY.md ("Agent API"): tools/list compared
 * with test/fixtures/mcp-contract.json, which holds each tool's parameters
 * (nested ones as `edits[].quote`), their JSON types and which are required.
 * Descriptions are left out: their wording may change in any release.
 *
 * Fails on a removed or renamed tool or parameter, a parameter that became
 * required, a new required parameter on an existing tool, and a changed type.
 * Anything added only prints what the snapshot is missing.
 * UPDATE_MCP_CONTRACT=1 rewrites the snapshot from the current tools.
 *
 * The error names a client branches on are exercised through the tools: a
 * rename passes the schema comparison but breaks every agent's retry loop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './assert.mjs';

const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-contract.json');
const UPDATE_HINT = 'cd apps/server && UPDATE_MCP_CONTRACT=1 npx tsx test/mcp-contract.test.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mcp-contract-'));
delete process.env.AUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const { createMcpServer } = await import('../src/mcp/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const server = createMcpServer({ user: null, tokenScope: null }, '');
await server.connect(serverSide);
const client = new Client({ name: 'aldine-contract', version: '0.0.0' });
await client.connect(clientSide);

function typeOf(s) {
  if (Array.isArray(s.type)) return [...s.type].sort().join('|');
  if (s.type === 'array') return `${s.items ? typeOf(s.items) : 'any'}[]`;
  if (s.type) return s.type;
  const alts = s.anyOf || s.oneOf;
  if (alts) return [...new Set(alts.map(typeOf))].sort().join('|');
  return 'any';
}

/** { 'edits': {type:'object[]', required:true}, 'edits[].quote': {...}, … } */
function flatten(schema, prefix = '', out = {}) {
  const required = new Set(schema.required || []);
  for (const [name, s] of Object.entries(schema.properties || {})) {
    const key = prefix + name;
    out[key] = { type: typeOf(s), required: required.has(name) };
    const inner = s.type === 'array' ? s.items : s;
    if (inner?.properties) flatten(inner, `${key}${s.type === 'array' ? '[]' : ''}.`, out);
  }
  return out;
}

const current = {};
for (const t of (await client.listTools()).tools) current[t.name] = flatten(t.inputSchema);

/** One parameter per line, sorted, so a diff of the snapshot reads as the change. */
function serialize(contract) {
  const tools = Object.keys(contract).sort().map((tool) => {
    const params = Object.keys(contract[tool]).sort()
      .map((p) => `    ${JSON.stringify(p)}: { "type": ${JSON.stringify(contract[tool][p].type)}, "required": ${contract[tool][p].required} }`);
    return params.length ? `  ${JSON.stringify(tool)}: {\n${params.join(',\n')}\n  }` : `  ${JSON.stringify(tool)}: {}`;
  });
  return `{\n${tools.join(',\n')}\n}\n`;
}

const snapshot = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : {};
const breaking = [];
const added = [];
for (const [tool, params] of Object.entries(snapshot)) {
  const now = current[tool];
  if (!now) { breaking.push(`tool ${tool} was removed or renamed`); continue; }
  for (const [name, was] of Object.entries(params)) {
    const is = now[name];
    if (!is) breaking.push(`${tool}: parameter ${name} was removed or renamed`);
    else {
      if (is.type !== was.type) breaking.push(`${tool}: parameter ${name} changed type from ${was.type} to ${is.type}`);
      if (is.required && !was.required) breaking.push(`${tool}: parameter ${name} became required`);
      if (!is.required && was.required) added.push(`${tool}: parameter ${name} is optional now`);
    }
  }
  for (const [name, is] of Object.entries(now)) {
    if (params[name]) continue;
    // A required field inside a new optional object is fine; one a call that
    // worked before does not send is not.
    const parent = name.includes('.') ? name.slice(0, name.lastIndexOf('.')).replace(/\[\]$/, '') : null;
    if (is.required && (parent === null || params[parent])) breaking.push(`${tool}: new parameter ${name} is required, and calls that worked before do not send it`);
    else added.push(`${tool}: new parameter ${name} ${JSON.stringify(is)}`);
  }
}
for (const tool of Object.keys(current)) if (!snapshot[tool]) added.push(`new tool ${tool} ${JSON.stringify(current[tool])}`);

if (process.env.UPDATE_MCP_CONTRACT === '1') {
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, serialize(current));
  for (const line of breaking) console.log(`BREAKING, now recorded: ${line}`);
  console.log(`wrote ${SNAPSHOT} (${Object.keys(current).length} tools)`);
} else {
  check(Object.keys(snapshot).length > 0, `no snapshot at ${SNAPSHOT}; record one with ${UPDATE_HINT}`);
  if (added.length) {
    console.log(`MCP contract: not in the snapshot yet (no failure). Record it with ${UPDATE_HINT}`);
    for (const line of added) console.log(`  + ${line}`);
  }
  check(breaking.length === 0, `the MCP tool contract changed in a way that breaks clients (docs/STABILITY.md, "Agent API"):\n  - ${breaking.join('\n  - ')}\nWithin 1.x this needs a deprecation instead. For a major release, record it with ${UPDATE_HINT}`);
}

// ---- error names ----
const p = await store.createProject('Contract paper');
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: { project: p.id, ...args } });
  return res.isError ? { toolError: res.content[0].text } : JSON.parse(res.content[0].text);
};
let body = await call('write_file', { path: 'twice.tex', content: 'A sentence that appears twice.\nA sentence that appears twice.\n' });
check(body.ok === true, `write_file seeds the fixture (got ${JSON.stringify(body)})`);
body = await call('edit_file', { path: 'twice.tex', edits: [{ quote: 'nowhere in this file at all', replacement: 'X' }] });
check(body.error === 'stale_anchor', `a quote that is not in the file answers error "stale_anchor" (got ${JSON.stringify(body)})`);
body = await call('edit_file', { path: 'twice.tex', edits: [{ quote: 'A sentence that appears twice.', replacement: 'X' }] });
check(body.error === 'ambiguous_anchor', `a quote found twice answers error "ambiguous_anchor" (got ${JSON.stringify(body)})`);
const { contentVersion } = await call('project_structure', {});
body = await call('write_file', { path: 'twice.tex', content: 'new\n', base_version: contentVersion + 999 });
check(body.error === 'version_conflict', `a base_version the file does not have answers error "version_conflict" (got ${JSON.stringify(body)})`);

await client.close();
await server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP contract: ALL PASSED');
process.exit(0);
