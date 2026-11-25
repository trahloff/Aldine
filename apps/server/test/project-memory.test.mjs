/**
 * Project memory (docs/PROJECT_MEMORY.md): every connected client is told the
 * convention at initialize, the article-memory template seeds the four
 * files, and project_structure lists the ones a project has, at the root
 * only and by exact name.
 *
 * In-memory MCP transport against real stores; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-project-memory-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL', 'REMOTE_PROVIDERS', 'TEMPLATE_REPOS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { listTemplates } = await import('../src/templates.ts');
const { createMcpServer, MEMORY_INSTRUCTIONS } = await import('../src/mcp/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await createMcpServer({ user: { id: ada.id, email: ada.email, name: ada.name }, tokenScope: { tokenId: 't-ada', projectIds: null } }, '').connect(serverSide);
const client = new Client({ name: 'project-memory-test', version: '0.0.0' });
await client.connect(clientSide);
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { isError: !!res.isError, body };
};
const MEMORY = ['FINDINGS.md', 'DECISIONS.md', 'TASKS.md', 'RESULTS.md'];

// ---- the instruction every client gets ----
const told = client.getInstructions();
eq(told, MEMORY_INSTRUCTIONS, 'initialize carries the memory instruction');
for (const f of MEMORY) check(told.includes(f), `it names ${f}`);
check(/project_structure/.test(told) && /edit_file/.test(told), 'and the tools to find and extend the files');
check(/unless the user asks/.test(told), 'and says not to create them unasked');

// ---- the template ----
const tpl = listTemplates().find((t) => t.id === 'article-memory');
check(tpl !== undefined && tpl.name === 'Article with project memory', 'the gallery lists the template');
let r = await call('create_project', { name: 'Egg paper', template: 'article-memory' });
check(!r.isError, `create_project from the template answers (got ${JSON.stringify(r.body)})`);
const id = r.body.id;
for (const f of [...MEMORY, 'main.tex', 'references.bib']) check(r.body.files.includes(f), `the project has ${f} (got ${JSON.stringify(r.body.files)})`);
check(!r.body.files.includes('template.json') && !r.body.files.includes('LICENSE'), 'gallery bookkeeping stays out');
eq(r.body.rootFile, 'main.tex', 'main.tex is the main document');

// ---- project_structure lists what exists, in the convention's order ----
r = await call('project_structure', { project: id });
eq(r.body.memory.map((m) => m.path), MEMORY, 'all four, in order');
eq(r.body.memory.map((m) => m.holds), ['findings', 'decisions', 'tasks', 'results'], 'each with what it holds');

r = await call('read_file', { project: id, path: 'TASKS.md' });
check(/owner/.test(r.body.content), 'the seeded file explains its format');

// an assistant extends a file the way the instruction says
r = await call('edit_file', { project: id, path: 'TASKS.md', edits: [{ quote: '- [ ] (task) — owner:', replacement: '- [ ] Digitise Fig. 2 — owner: Ada (2026-11-25)' }], message: 'Add the digitising task' });
check(!r.isError, `edit_file on a memory file works like on any file (got ${JSON.stringify(r.body)})`);

// only files at the root, by exact name, count
await call('write_file', { project: id, path: 'notes/FINDINGS.md', content: '# not the memory\n', message: 'A nested note' });
await call('write_file', { project: id, path: 'findings.md', content: '# lower case\n', message: 'A lower-case note' });
r = await call('project_structure', { project: id });
eq(r.body.memory.map((m) => m.path), MEMORY, 'a nested or differently spelled file is not memory');

// a project without the files says so
r = await call('create_project', { name: 'Plain paper' });
r = await call('project_structure', { project: r.body.id });
eq(r.body.memory, [], 'a project without memory files lists none');

await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Project memory: ALL PASSED');
process.exit(0);
