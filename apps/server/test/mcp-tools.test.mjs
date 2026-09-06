/**
 * MCP tool surface (Phase 1 §1.3–1.5, Phase 2 §2.1): pure quote→offset
 * resolution rules (unique / ambiguous / occurrence / ≥8-char), stale_anchor
 * candidates, log-tail truncation, and a full SDK-client round-trip covering
 * the read tools, edit_file, write_file version_conflict, batch_write's
 * single named commit as author Claude, the commit tool, the Phase 2
 * wrappers (references_add against a mock upstream, list_citations,
 * list_labels, wordcount, create_project), and token project-scoping.
 *
 * Env must be set before any src import. RL_MCP_BURST is raised because the
 * round-trip makes dozens of requests on one PAT; RL_REF_BURST is lowered so
 * the reference-lookup budget refusal is reachable in-test.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

// Mock DOI / arXiv / OpenAlex upstream: one known DOI resolves, everything
// else is a 404 — references.ts reads the base URLs at import time.
const MOCK_BIB = '@article{doe2020,\n  title = {A Mock Paper &amp; More},\n  author = {Doe, Jane},\n  year = {2020},\n  journal = {Mock Journal},\n}';
const upstream = http.createServer((req, res) => {
  if (req.url === `/${encodeURIComponent('10.1145/mock.12345')}`) {
    res.writeHead(200, { 'content-type': 'application/x-bibtex' });
    res.end(MOCK_BIB);
    return;
  }
  res.writeHead(404).end('not found');
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
process.env.DOI_API_BASE = upstreamBase;
process.env.ARXIV_API_BASE = upstreamBase;
process.env.OPENALEX_API_BASE = upstreamBase;
process.env.RL_REF_BURST = '3';

// Mock compiler: answers with the next queued body and, when that body names
// a PDF, writes it (plus a .log) into the project dir the server asked for —
// compile.ts reads COMPILER_URL at import time, so this sits before any import.
const compilerQueue = [];
const compilerRequests = [];
const mockCompiler = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    // Route registration warms the venue catalog with a bodiless GET; this
    // mock compiles and nothing else, so anything but /compile is a 404 —
    // catalog.ts treats that as "no venue classes", which is what the test wants.
    if (req.method !== 'POST' || req.url !== '/compile') { res.writeHead(404).end('not found'); return; }
    const body = JSON.parse(raw);
    compilerRequests.push(body);
    const reply = compilerQueue.shift() ?? { ok: false, error: 'mock compiler queue empty' };
    if (reply.pdf) {
      const outDir = path.join(process.env.DATA_DIR, body.projectDir, path.dirname(reply.pdf));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, path.basename(reply.pdf)), reply.pdfBytes ?? '%PDF-1.7\n% mock compiler\n%%EOF\n');
      fs.writeFileSync(path.join(outDir, path.basename(reply.pdf).replace(/\.pdf$/, '.log')), reply.log ?? '');
    }
    // What pdfTeX does under -halt-on-error: the PDF is removed, the log stays.
    if (reply.deletePdf) {
      const abs = path.join(process.env.DATA_DIR, body.projectDir, reply.deletePdf);
      fs.rmSync(abs, { force: true });
      fs.writeFileSync(abs.replace(/\.pdf$/, '.log'), reply.log ?? '');
    }
    const buf = Buffer.from(JSON.stringify(reply));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
});
await new Promise((r) => mockCompiler.listen(0, '127.0.0.1', r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mcp-tools-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_MCP_BURST = '500';
process.env.COMPILER_URL = `http://127.0.0.1:${mockCompiler.address().port}`;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_MCP_TOKEN;
delete process.env.ALDINE_PROTECTED_PROJECTS;
delete process.env.ALDINE_PUBLIC_URL;
delete process.env.ALDINE_COMPILE_PER_MIN;
// The viewer asset is built separately; the path is pointed at a file this
// test writes later, so both the not-built and the built states are covered.
process.env.ALDINE_PDF_VIEWER_HTML = path.join(tmp, 'pdf-viewer.html');

const { resolveEdits, spliceEdits, nearestCandidates, logTail, LOG_TAIL_BYTES, MIN_QUOTE_LEN } =
  await import('../src/mcp/tools.ts');
const { forgetPdfUrls } = await import('../src/compile.ts');

// ---- quote→offset resolution (pure) ----
const doc = [
  '\\section{Introduction}',
  'Watch the quick brown fox jump over the lazy dog.',
  'A second line mentioning the quick brown fox again.',
  '\\section{Methods}',
  'Unique anchor sentence for testing.',
].join('\n');

let r = resolveEdits(doc, [{ quote: 'Unique anchor sentence', replacement: 'X' }]);
check(r.ok === true, 'unique quote resolves');
check(doc.slice(r.ranges[0].from, r.ranges[0].to) === 'Unique anchor sentence', 'resolved range covers the quote exactly');

r = resolveEdits(doc, [{ quote: 'the quick brown fox', replacement: 'X' }]);
check(r.ok === false && r.error === 'stale_anchor', 'ambiguous quote → stale_anchor');
check(r.candidates.length >= 1 && r.candidates.length <= 3, `ambiguity candidates are ≤3 nearest lines (got ${r.candidates.length})`);
check(r.candidates.every((c) => Number.isInteger(c.line) && typeof c.text === 'string'), 'candidates carry {line, text}');

r = resolveEdits(doc, [{ quote: 'the quick brown fox', replacement: 'X', occurrence: 2 }]);
check(r.ok === true, 'occurrence disambiguates');
check(r.ranges[0].from === doc.indexOf('the quick brown fox', doc.indexOf('the quick brown fox') + 1), 'occurrence 2 picks the second hit');

r = resolveEdits(doc, [{ quote: 'the quick brown fox', replacement: 'X', occurrence: 3 }]);
check(r.ok === false && r.error === 'stale_anchor', 'occurrence beyond the hit count → stale_anchor');

r = resolveEdits(doc, [{ quote: 'short', replacement: 'X' }]);
check(r.ok === false && r.error === 'invalid_quote', `quote under ${MIN_QUOTE_LEN} chars is rejected as invalid_quote`);

r = resolveEdits(doc, [{ quote: 'nowhere to be found in this document', replacement: 'X' }]);
check(r.ok === false && r.error === 'stale_anchor', 'missing quote → stale_anchor');

r = resolveEdits(doc, [
  { quote: 'Unique anchor sentence for testing.', replacement: 'X' },
  { quote: 'anchor sentence', replacement: 'Y' },
]);
check(r.ok === false && r.error === 'stale_anchor', 'overlapping edits → stale_anchor (single-snapshot application)');

// back-to-front splice keeps earlier offsets valid
const spliced = (() => {
  const edits = [
    { quote: '\\section{Introduction}', replacement: '\\section{Intro}' },
    { quote: '\\section{Methods}', replacement: '\\section{Approach}' },
  ];
  const res = resolveEdits(doc, edits);
  check(res.ok === true, 'two disjoint edits resolve');
  return spliceEdits(doc, edits, res.ranges);
})();
check(spliced.includes('\\section{Intro}') && spliced.includes('\\section{Approach}'), 'spliceEdits applies all edits');
check(!spliced.includes('\\section{Introduction}'), 'spliceEdits replaced the original text');

// ---- stale_anchor candidates point at near-miss lines ----
const cands = nearestCandidates(doc, 'Unique anchor sentense for testing.');
check(cands.length >= 1 && cands.length <= 3, `nearestCandidates returns ≤3 (got ${cands.length})`);
check(cands[0].line === 5 && cands[0].text.includes('Unique anchor sentence'), 'the near-miss line ranks first');

// ---- log-tail truncation ----
const bigLog = 'HEAD-MARKER\n' + 'x'.repeat(10_000) + '\nTAIL-MARKER';
const tail = logTail(bigLog);
check(Buffer.byteLength(tail, 'utf8') <= LOG_TAIL_BYTES, `log tail is ≤${LOG_TAIL_BYTES} bytes (got ${Buffer.byteLength(tail, 'utf8')})`);
check(tail.endsWith('TAIL-MARKER'), 'log tail keeps the end of the log');
check(!tail.includes('HEAD-MARKER'), 'log tail drops the head of the log');
check(logTail('tiny log') === 'tiny log', 'short logs pass through untruncated');

// ---- full round-trip over the SDK client ----
const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerMcp, createMcpServer } = await import('../src/mcp/server.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);
await registerMcp(app);
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;

const user = await auth.register('ada@example.com', 'password123', 'Ada');
const p1 = await store.createProject('Agent paper', undefined, user.id);
const p2 = await store.createProject('Other paper', undefined, user.id);
const { token } = await auth.createAccessToken(user.id, 'Agent', null, null);

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const connect = async (tok) => {
  const c = new Client({ name: 'aldine-test', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${tok}` } } },
  ));
  return c;
};
const client = await connect(token);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: res.isError ? res.content[0].text : JSON.parse(res.content[0].text) };
};
/** stdout lines written while fn runs — the success-metric lines are log lines, not storage. */
const captureLog = async (fn) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
};

// tools/list: the 8 Phase 1 tools + the 5 Phase 2 wrappers + ping;
// readOnlyHint on reads, never on writes
const listed = (await client.listTools()).tools;
const names = listed.map((t) => t.name).sort();
const expected = [
  'batch_write', 'commit', 'compile', 'create_project', 'edit_file', 'get_pdf_url', 'list_citations', 'list_labels',
  'list_projects', 'ping', 'project_structure', 'read_file', 'references_add', 'wordcount', 'write_file',
];
check(JSON.stringify(names) === JSON.stringify(expected), `tool surface is exactly the 13 spec tools + get_pdf_url + ping (got ${names.join(',')})`);
for (const t of listed) {
  const ro = ['list_projects', 'project_structure', 'read_file', 'ping', 'list_citations', 'list_labels', 'wordcount', 'get_pdf_url'].includes(t.name);
  check((t.annotations?.readOnlyHint === true) === ro, `${t.name} readOnlyHint ${ro ? 'present' : 'absent'}`);
}
// The viewer resource is listed whether or not the asset is built, but
// tools only point at it once it is (no host renders a broken frame).
const { PDF_VIEWER_URI, MCP_APP_MIME } = await import('../src/mcp/tools.ts');
check(PDF_VIEWER_URI === 'ui://aldine/pdf-viewer' && MCP_APP_MIME === 'text/html;profile=mcp-app', 'viewer URI and MIME are the SEP-1865 values');
let resources = (await client.listResources()).resources;
let viewer = resources.find((r) => r.uri === PDF_VIEWER_URI);
check(viewer && viewer.mimeType === MCP_APP_MIME, `the viewer resource is listed with the mcp-app MIME (got ${JSON.stringify(resources)})`);
check(viewer._meta?.ui?.csp?.connectDomains?.length === 1 && /^http:\/\/127\.0\.0\.1:\d+$/.test(viewer._meta.ui.csp.connectDomains[0]), `the resource CSP allowlists exactly the instance origin (got ${JSON.stringify(viewer._meta)})`);
check(listed.every((t) => t._meta?.ui === undefined), 'no tool references the viewer while the asset is not built');
let readErr = null;
try { await client.readResource({ uri: PDF_VIEWER_URI }); } catch (err) { readErr = err; }
check(readErr && /not built/.test(readErr.message) && /pdf-viewer\.html/.test(readErr.message), `reading an unbuilt viewer fails with a clear message (got ${readErr?.message})`);
fs.writeFileSync(process.env.ALDINE_PDF_VIEWER_HTML, '<!doctype html><title>viewer fixture</title>');
const listedBuilt = (await client.listTools()).tools;
for (const name of ['compile', 'get_pdf_url']) {
  const t = listedBuilt.find((x) => x.name === name);
  check(t._meta?.ui?.resourceUri === PDF_VIEWER_URI, `${name} carries _meta.ui.resourceUri once the asset exists`);
}
check(listedBuilt.filter((t) => t._meta?.ui).length === 2, 'only compile and get_pdf_url reference the viewer');
const read = await client.readResource({ uri: PDF_VIEWER_URI });
check(read.contents.length === 1 && read.contents[0].mimeType === MCP_APP_MIME && read.contents[0].text.includes('viewer fixture'), 'resources/read returns the built HTML as text');
check(read.contents[0]._meta?.ui?.csp?.connectDomains?.length === 1, 'the read contents repeat the CSP metadata');
// stdio without ALDINE_PUBLIC_URL: no absolute origin, so pdfUrl/deepLink are
// root-relative and the sandbox could not fetch them — the tools must not
// advertise the viewer (the text result still carries the links).
{
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const local = createMcpServer({ user: null, tokenScope: null }, '');
  await local.connect(serverSide);
  const c = new Client({ name: 'aldine-test-stdio', version: '0.0.0' });
  await c.connect(clientSide);
  const tools = (await c.listTools()).tools;
  check(tools.every((t) => t._meta?.ui === undefined), 'with no public origin (stdio, ALDINE_PUBLIC_URL unset) no tool references the viewer even though the asset is built');
  const res = (await c.listResources()).resources.find((r) => r.uri === PDF_VIEWER_URI);
  check(res && res._meta?.ui === undefined, 'and the viewer resource carries no CSP allowlist');
  await c.close();
  await local.close();
}
// descriptions are the model's API docs: the etiquette the spec requires
// must be stated where the model reads it
const desc = Object.fromEntries(listed.map((t) => [t.name, t.description]));
check(/re-read/.test(desc.edit_file) && /2 retries/.test(desc.edit_file), 'edit_file teaches the stale_anchor retry etiquette (re-read, ≤2 retries)');
check(/prefer edit_file/i.test(desc.write_file), 'write_file steers to edit_file for existing files');
check(/other files never conflict/.test(desc.edit_file), 'edit_file says writes to other files never conflict');
check(/fileVersion/.test(desc.read_file), 'read_file explains contentVersion vs fileVersion');
check(/3 times/.test(desc.compile) && /attempt 2 of 3/.test(desc.compile), 'compile states the 3-attempt fix-loop cap with narration');
check(/relay/.test(desc.compile), 'compile tells the model to relay quota/unreachable errors instead of retrying');
check(/15 minutes/.test(desc.compile) && /get_pdf_url/.test(desc.compile) && /pdfStale/.test(desc.compile), 'compile explains the signed link, its expiry, the re-fetch tool and pdfStale');
check(/without recompiling/.test(desc.get_pdf_url) && /compile first/.test(desc.get_pdf_url), 'get_pdf_url says it does not recompile and what to do with no output');
check(/before writing a \\cite/.test(desc.list_citations) && /never invent/.test(desc.list_citations), 'list_citations demands a call before any \\cite');

// list_projects
let { body } = await call('list_projects');
check(body.length === 2 && body.some((p) => p.id === p1.id) && body.some((p) => p.id === p2.id), 'list_projects lists both projects');
const listedP1 = body.find((p) => p.id === p1.id);
check(listedP1.branches.includes('main') && listedP1.rootFile === 'main.tex' && listedP1.engine === 'pdf', 'list_projects carries branches/rootFile/engine');

// project_structure
({ body } = await call('project_structure', { project: p1.id }));
check(body.files.some((f) => f.path === 'main.tex' && f.type === 'file'), 'project_structure lists main.tex');
check(typeof body.contentVersion === 'number', 'project_structure returns contentVersion');
check(body.branch === 'main' && typeof body.head === 'string' && body.head.length >= 4, 'result echoes {branch, head}');

// read_file (whole + line window)
({ body } = await call('read_file', { project: p1.id, path: 'main.tex' }));
check(body.content.includes('\\documentclass'), 'read_file returns file content');
check(body.totalLines > 5, 'read_file reports totalLines');
const whole = body.content;
({ body } = await call('read_file', { project: p1.id, path: 'main.tex', from_line: 1, to_line: 3 }));
check(body.content === whole.split('\n').slice(0, 3).join('\n'), 'from_line/to_line windows the read (1-based, inclusive)');
let res = await call('read_file', { project: p1.id, path: '.git/config' });
check(res.isError, 'hidden paths are refused');

// edit_file (closed doc): applied + snippet, and the change reaches disk
({ body } = await call('edit_file', {
  project: p1.id, path: 'main.tex',
  edits: [{ quote: 'Start writing here', replacement: 'The agent wrote this' }],
}));
check(body.applied === 1, 'edit_file applies the edit');
check(body.snippet.includes('The agent wrote this'), 'edit_file returns a snippet around the change');
check(typeof body.contentVersion === 'number' && body.contentVersion > 0, 'edit_file bumps contentVersion');
check(store.readFile(p1.id, 'main', 'main.tex').toString('utf8').includes('The agent wrote this'), 'the edit reached disk');

// stale anchor after the text changed: candidates + contentVersion, nothing applied
({ body } = await call('edit_file', {
  project: p1.id, path: 'main.tex',
  edits: [{ quote: 'Start writing here\\ldots', replacement: 'X' }],
}));
check(body.error === 'stale_anchor', 'gone quote → stale_anchor');
check(Array.isArray(body.candidates) && body.candidates.length <= 3, 'stale_anchor carries ≤3 candidates');
check(typeof body.contentVersion === 'number', 'stale_anchor carries contentVersion');

// write_file: version_conflict on stale base_version, ok on the current one
({ body } = await call('project_structure', { project: p1.id }));
const v = body.contentVersion;
({ body } = await call('write_file', { project: p1.id, path: 'notes.tex', content: 'A modest note.\n', base_version: v + 999 }));
check(body.error === 'version_conflict' && body.currentVersion === v, 'stale base_version → version_conflict with currentVersion');
check(!store.fileExists(p1.id, 'main', 'notes.tex'), 'version_conflict writes nothing');
({ body } = await call('write_file', { project: p1.id, path: 'notes.tex', content: 'A modest note.\n', base_version: v }));
check(body.ok === true && body.contentVersion > v, 'matching base_version writes and bumps contentVersion');
check(store.readFile(p1.id, 'main', 'notes.tex').toString('utf8') === 'A modest note.\n', 'write_file content reached disk');

// batch_write: ONE named commit as author Claude, covering ONLY its own
// paths. A collaborator's flushed-but-uncommitted work — in another file, or
// pending in a file the batch touches — must not be signed Claude (the
// session toast would offer to revert it).
({ body } = await call('commit', { project: p1.id, message: 'Land the edits so far' }));
check(body.committed === true, 'setup: pending agent edits land before the batch');
store.writeFile(p1.id, 'main', 'human.tex', 'typed by a human, not yet autosaved\n');
store.writeFile(p1.id, 'main', 'notes.tex', 'A modest note.\nA human line in the same file.\n');
const logBefore = await gitops.log(p1.id, 'main');
({ body } = await call('batch_write', {
  project: p1.id,
  files: [
    { path: 'abstract.tex', content: 'The abstract.\n' },
    { path: 'notes.tex', edits: [{ quote: 'A modest note.', replacement: 'A sharper note.' }] },
  ],
  message: 'Add abstract and sharpen the note',
}));
check(body.ok === true && typeof body.commit === 'string' && body.commit.length >= 4, 'batch_write returns the commit hash');
check(body.head === body.commit, 'head echo matches the new commit');
const logAfter = await gitops.log(p1.id, 'main');
check(logAfter[0].message === 'Add abstract and sharpen the note', 'the commit message is the stated intent');
check(logAfter[0].author === 'Claude', 'the commit author is Claude');
check(logAfter.filter((c) => c.author === 'Claude').length === logBefore.filter((c) => c.author === 'Claude').length + 1, 'batch_write makes exactly ONE Claude commit');
const batchPatch = (await gitops.commitDiff(p1.id, logAfter[0].hash)).patch;
check(batchPatch.includes('+A sharper note.') && batchPatch.includes('+The abstract.'), "the Claude commit carries the batch's writes");
check(!batchPatch.includes('human.tex') && !batchPatch.includes('+A human line'), "the Claude commit carries NONE of the human's pending work");
const checkpoint = logAfter.find((c) => c.message === 'aldine: autosave');
check(checkpoint !== undefined && logAfter.indexOf(checkpoint) === 1, "the human's pending edit to a batch path was checkpointed as an autosave first");
check((await gitops.commitDiff(p1.id, checkpoint.hash)).patch.includes('+A human line'), 'the checkpoint holds the human line');
check((await gitops.commitDiff(p1.id, checkpoint.hash)).patch.includes('notes.tex') && !(await gitops.commitDiff(p1.id, checkpoint.hash)).patch.includes('human.tex'), 'the checkpoint covers only the batch paths; other files wait for the autosave debounce');
check(store.readFile(p1.id, 'main', 'notes.tex').toString('utf8').includes('A sharper note.'), 'batch_write edits entries apply');

// batch_write all-or-nothing: a stale anchor in one file writes neither
({ body } = await call('batch_write', {
  project: p1.id,
  files: [
    { path: 'abstract.tex', content: 'Clobbered?\n' },
    { path: 'notes.tex', edits: [{ quote: 'not in this file at all', replacement: 'X' }] },
  ],
  message: 'Should not land',
}));
check(body.error === 'stale_anchor' && body.file === 'notes.tex', 'batch_write reports the stale file');
check(store.readFile(p1.id, 'main', 'abstract.tex').toString('utf8') === 'The abstract.\n', 'a stale anchor writes NOTHING (earlier files untouched)');

// batch_write: a duplicate path is refused up front — both entries would
// resolve against the same pre-write snapshot and the later write would
// silently discard the earlier entry's edits while reporting ok
res = await call('batch_write', {
  project: p1.id,
  files: [
    { path: 'notes.tex', edits: [{ quote: 'A sharper note.', replacement: 'Edit A applied.' }] },
    { path: 'notes.tex', content: 'Edit B applied.\n' },
  ],
  message: 'Duplicate entries must not land',
});
check(res.isError === true && /more than once/.test(res.body), 'duplicate paths in one batch are refused');
check(store.readFile(p1.id, 'main', 'notes.tex').toString('utf8').includes('A sharper note.'), 'a duplicate-path batch writes nothing');

// compile: a refused agent compile must NOT release the slot held by the
// compile that is actually running (that would let a later call take both
// shared slots and starve the human's compile button)
const { agentCompileGate } = await import('../src/ratelimit.ts');
const gateKey = `u:${user.id}`;
check(agentCompileGate.tryAcquire(gateKey) === true, 'test acquires the 1-slot agent compile gate');
res = await call('compile', { project: p1.id });
check(res.isError === true && /already running/.test(res.body), 'a second agent compile is refused while one runs');
check(agentCompileGate.tryAcquire(gateKey) === false, "the refusal did NOT release the running compile's slot");
agentCompileGate.release(gateKey);
check(agentCompileGate.tryAcquire(gateKey) === true && (agentCompileGate.release(gateKey), true), 'the slot frees normally once released by its holder');

// edit_file / write_file take an optional intent; the default titles name the file
// (the anonymous sweep of other dirty files may land newest, so look the commit up by title)
const titled = async (message) => {
  const c = (await gitops.log(p1.id, 'main')).find((x) => x.message === message);
  return c && c.author === 'Claude' ? (await gitops.commitDiff(p1.id, c.hash)).stat : '';
};
await call('write_file', { project: p1.id, path: 'intent.tex', content: 'Intent test.\n', message: 'Add the intent file' });
await gitops.autoCommit(p1.id, 'main');
check((await titled('Add the intent file')).includes('intent.tex'), 'write_file commits under the stated message');
({ body } = await call('edit_file', { project: p1.id, path: 'intent.tex', edits: [{ quote: 'Intent test.', replacement: 'Intent test, edited.' }], message: 'Sharpen the intent line' }));
check(body.applied === 1, 'edit_file with a message applies');
await gitops.autoCommit(p1.id, 'main');
check((await titled('Sharpen the intent line')).includes('intent.tex'), 'edit_file commits under the stated message');
({ body } = await call('edit_file', { project: p1.id, path: 'intent.tex', edits: [{ quote: 'Intent test, edited.', replacement: 'Intent test, edited twice.' }] }));
await gitops.autoCommit(p1.id, 'main');
check((await titled('Edit intent.tex')).includes('intent.tex'), 'without a message the commit is titled by the file');

// commit tool
await call('write_file', { project: p1.id, path: 'extra.tex', content: 'More.\n' });
({ body } = await call('commit', { project: p1.id, message: 'Add extra material' }));
check(body.committed === true && typeof body.hash === 'string', 'commit commits pending changes');
check((await gitops.log(p1.id, 'main'))[0].author === 'Claude', 'manual commit is authored Claude');
({ body } = await call('commit', { project: p1.id, message: 'Nothing to do' }));
check(body.committed === false, 'clean tree → committed:false');

// ---- Phase 2 wrappers ----

// references_add: DOI → BibTeX appended to references.bib beside the root
// file, attributed to Claude; the entry is compile-safe (&amp; decoded and
// escaped); a second add of the same key reports duplicate and writes nothing
({ body } = await call('references_add', { project: p1.id, query: '10.1145/mock.12345' }));
check(body.key === 'doe2020' && body.bibFile === 'references.bib' && body.duplicate === false, `references_add returns {key, bibFile} (got ${JSON.stringify(body)})`);
check(body.branch === 'main' && typeof body.head === 'string', 'references_add echoes {branch, head}');
check(typeof body.fileVersion === 'number' && body.fileVersion === body.contentVersion, 'references_add carries the bib file\'s fileVersion');
let bibText = store.readFile(p1.id, 'main', 'references.bib').toString('utf8');
check(bibText.includes('@article{doe2020') && bibText.includes('@article{knuth1984'), 'the entry was appended to the existing references.bib');
check(bibText.includes('\\&') && !bibText.includes('&amp;'), 'the appended entry is LaTeX-escaped');
({ body } = await call('references_add', { project: p1.id, query: 'https://doi.org/10.1145/mock.12345' }));
check(body.key === 'doe2020' && body.duplicate === true, 'a known key reports duplicate');
check(store.readFile(p1.id, 'main', 'references.bib').toString('utf8') === bibText, 'a duplicate add writes nothing');
res = await call('references_add', { project: p1.id, query: 'Attention is all you need' });
check(res.isError === true && /No reference found/.test(res.body), 'a title (not a DOI/arXiv id) is refused with user-fixable prose');
res = await call('references_add', { project: p1.id, query: '10.1145/mock.12345' });
check(res.isError === true && /lookup budget/.test(res.body), `the refLimiter refuses the 4th lookup with relay-able prose (got ${JSON.stringify(res.body)})`);
res = await call('references_add', { project: p1.id, query: '10.1145/mock.12345', bibFile: '.git/refs.bib' });
check(res.isError === true && /Invalid file path/.test(res.body), 'hidden bib paths are refused before any lookup');
// with the budget exhausted, these refusals prove the guards run before the
// limiter takes a token (a limiter-first order would answer "lookup budget")
res = await call('references_add', { project: p1.id, query: '10.1145/mock.12345', bibFile: 'main.tex' });
check(res.isError === true && /must be a \.bib file/.test(res.body), `a non-.bib target is refused (got ${JSON.stringify(res.body)})`);
res = await call('references_add', { project: p1.id, query: '10.1145/mock.12345', branch: 'no-such-branch' });
check(res.isError === true && /Branch not found/.test(res.body), `an unknown branch is reported as such, not as an upstream outage (got ${JSON.stringify(res.body)})`);
await new Promise((r) => setTimeout(r, 2100)); // refLimiter refill (0.5/s)
res = await call('references_add', { project: p1.id, query: '10.1145/missing.1' });
check(res.isError === true && /Reference lookup failed.*404/.test(res.body), `an upstream failure is relayed with its status (got ${JSON.stringify(res.body)})`);
({ body } = await call('commit', { project: p1.id, message: 'Land reference' }));
const refCommits = (await gitops.log(p1.id, 'main')).filter((c) => c.message === 'Add reference doe2020');
check(refCommits.length === 1 && refCommits[0].author === 'Claude', 'the reference landed as an attributed Claude commit');

// list_citations: the index the model must consult before writing \cite
({ body } = await call('list_citations', { project: p1.id }));
check(Array.isArray(body.citations), 'list_citations returns a citations array');
const doe = body.citations.find((c) => c.key === 'doe2020');
check(doe && doe.file === 'references.bib' && doe.year === '2020' && /Doe/.test(doe.author) && /Mock Paper/.test(doe.title), `list_citations carries {key,title,author,year,file} (got ${JSON.stringify(doe)})`);
check(body.citations.some((c) => c.key === 'knuth1984'), 'list_citations includes the seed entry');
check(body.citations.every((c) => Object.keys(c).sort().join() === 'author,file,key,title,year'), 'list_citations rows carry exactly the spec fields');
check(body.branch === 'main' && typeof body.head === 'string', 'list_citations echoes {branch, head}');

// list_labels: sees a label written moments ago through the flushed index
await call('write_file', { project: p1.id, path: 'intro.tex', content: '\\section{Introduction}\\label{sec:intro}\nSee \\ref{sec:intro}.\n' });
({ body } = await call('list_labels', { project: p1.id }));
check(body.labels.some((l) => l.label === 'sec:intro' && l.file === 'intro.tex'), `list_labels returns [{label,file}] (got ${JSON.stringify(body.labels)})`);
check(typeof body.head === 'string', 'list_labels echoes {branch, head}');

// wordcount: whole-document count over the root file's include graph
await call('edit_file', { project: p1.id, path: 'main.tex', edits: [{ quote: '\\begin{document}', replacement: '\\begin{document}\n\\input{intro}' }] });
({ body } = await call('wordcount', { project: p1.id }));
check(body.rootFile === 'main.tex' && typeof body.total === 'number' && body.total > 0, `wordcount returns {rootFile,total,files} (got ${JSON.stringify(body)})`);
check(typeof body.files['main.tex'] === 'number' && typeof body.files['intro.tex'] === 'number', 'wordcount follows \\input into intro.tex');
check(body.total === Object.values(body.files).reduce((a, b) => a + b, 0), 'total is the sum of the per-file counts');
// switching the root file (PATCH /api/projects/:id writes meta without
// touching branch content) must not serve the previous root's count
const wcMeta = await store.readMeta(p1.id);
wcMeta.rootFile = 'intro.tex';
await store.writeMeta(wcMeta);
({ body } = await call('wordcount', { project: p1.id }));
check(body.rootFile === 'intro.tex' && !('main.tex' in body.files) && typeof body.files['intro.tex'] === 'number', `wordcount follows a root-file switch with no content change (got ${JSON.stringify(body)})`);
wcMeta.rootFile = 'main.tex';
await store.writeMeta(wcMeta);
({ body } = await call('wordcount', { project: p1.id }));
check(body.rootFile === 'main.tex' && typeof body.files['main.tex'] === 'number', 'switching back restores the main.tex graph');

// create_project: unscoped token creates (blank and from a template); the
// new project is owned by the token's user and reachable through the tools
({ body } = await call('create_project', { name: 'Fresh paper' }));
check(typeof body.id === 'string' && body.name === 'Fresh paper' && body.rootFile === 'main.tex' && body.engine === 'pdf', `create_project returns the new project (got ${JSON.stringify(body)})`);
check(body.branch === 'main' && typeof body.head === 'string' && body.head.length >= 4, 'create_project echoes {branch, head} of the initial commit');
const fresh = body.id;
({ body } = await call('list_projects'));
check(body.some((p) => p.id === fresh), 'the created project shows up in list_projects');
check((await store.readMeta(fresh)).ownerId === user.id, 'the created project is owned by the token user');
({ body } = await call('create_project', { name: 'Slides', template: 'beamer' }));
check(typeof body.id === 'string', 'create_project accepts a template');
({ body } = await call('project_structure', { project: body.id }));
check(body.files.some((f) => f.path.endsWith('.tex')), 'the template seeded .tex files');
res = await call('create_project', { name: 'Nope', template: 'no-such-template' });
check(res.isError === true && /Unknown template/.test(res.body) && /article/.test(res.body), `an unknown template is refused and the available ids are named (got ${JSON.stringify(res.body)})`);

// get_pdf_url: nothing typeset yet → told to compile; with a PDF on disk →
// a signed absolute link that serves with no cookie, page count from the
// engine log, typesetAt, and the viewer's structuredContent
res = await call('get_pdf_url', { project: p1.id });
check(res.isError === true && /compile first/.test(res.body), `get_pdf_url with no output says to compile first (got ${JSON.stringify(res.body)})`);
const outDir = path.join(store.branchDir(p1.id, 'main'), '.aldine-out');
fs.mkdirSync(outDir, { recursive: true });
const fakePdf = Buffer.from('%PDF-1.7\n% fixture\n%%EOF\n');
fs.writeFileSync(path.join(outDir, 'main.pdf'), fakePdf);
fs.writeFileSync(path.join(outDir, 'main.log'), 'This is pdfTeX\nOutput written on main.pdf (1 page, 100 bytes).\nOutput written on main.pdf (3 pages, 12345 bytes).\nTranscript written on main.log.\n');
const pdfRes = await client.callTool({ name: 'get_pdf_url', arguments: { project: p1.id } });
check(!pdfRes.isError, `get_pdf_url succeeds with output on disk (got ${pdfRes.content[0].text})`);
const pdfBody = JSON.parse(pdfRes.content[0].text);
check(JSON.stringify(pdfRes.structuredContent) === JSON.stringify(pdfBody), 'structuredContent mirrors the text result for the viewer');
check(pdfBody.pdfUrl.startsWith(`http://127.0.0.1:${port}/api/projects/${p1.id}/output?`) && /[?&]sig=/.test(pdfBody.pdfUrl) && /[?&]exp=\d+/.test(pdfBody.pdfUrl), `pdfUrl is absolute and signed (got ${pdfBody.pdfUrl})`);
check(pdfBody.pdfFile === 'main.pdf' && pdfBody.pages === 3 && pdfBody.pdfStale === false && typeof pdfBody.typesetAt === 'string' && !Number.isNaN(Date.parse(pdfBody.typesetAt)), `get_pdf_url carries pdfFile, pages (last "Output written" wins), pdfStale, typesetAt (got ${JSON.stringify(pdfBody)})`);
check(pdfBody.deepLink === `http://127.0.0.1:${port}/p/${p1.id}` && pdfBody.project === p1.id && pdfBody.projectName === 'Agent paper' && pdfBody.branch === 'main' && typeof pdfBody.head === 'string', 'get_pdf_url echoes deepLink, project, projectName, {branch, head}');
const fetched = await fetch(pdfBody.pdfUrl);
check(fetched.status === 200 && fetched.headers.get('content-type').startsWith('application/pdf') && fetched.headers.get('access-control-allow-origin') === '*', `the signed link serves the PDF with no cookie (got ${fetched.status})`);
check(Buffer.compare(Buffer.from(await fetched.arrayBuffer()), fakePdf) === 0, 'the served bytes are the PDF on disk');
const unsignedPdf = await fetch(pdfBody.pdfUrl.replace(/&exp=.*$/, ''));
check(unsignedPdf.status === 401, `the same link without its signature needs a session (got ${unsignedPdf.status})`);
res = await call('get_pdf_url', { project: p1.id, branch: 'no-such-branch' });
check(res.isError === true, 'get_pdf_url on a missing branch is an error, not a crash');

// compile over the mock compiler: the result hands out the
// SIGNED absolute link, never the cookie-auth /output path, with pages from
// the engine log and structuredContent for the viewer; a later run that
// writes no PDF keeps the previous link and flags it stale; parsed errors
// are capped at MAX_RESULT_ERRORS with errorsTotal carrying the real count.
const compileDef = listedBuilt.find((t) => t.name === 'compile');
check(compileDef._meta?.ui?.resourceUri === PDF_VIEWER_URI, 'compile is declared with the viewer resource for the host');
const mockPdf = '%PDF-1.7\n% compiled by the mock\n%%EOF\n';
compilerQueue.push({ ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: null, log: 'This is pdfTeX\nOutput written on main.pdf (2 pages, 4321 bytes).\nTranscript written on main.log.\n', errors: [], durationMs: 5, pdfBytes: mockPdf });
let cRes;
const compileLog = await captureLog(async () => { cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } }); });
check(!cRes.isError, `compile succeeds over the mock compiler (got ${cRes.content[0].text})`);
check(compileLog.some((l) => l === `[metric] agent_compile user=${user.id} project=${p1.id} ok=true ms=5`), `an agent compile logs its success-metric line (got ${JSON.stringify(compileLog)})`);
let cBody = JSON.parse(cRes.content[0].text);
check(JSON.stringify(cRes.structuredContent) === JSON.stringify(cBody), 'compile: structuredContent mirrors the text result');
check(cBody.ok === true && cBody.errors.length === 0 && cBody.errorsTotal === 0 && cBody.timedOut === false && typeof cBody.durationMs === 'number', `compile echoes ok/errors/errorsTotal/timedOut/durationMs (got ${JSON.stringify(cBody)})`);
check(typeof cBody.pdfUrl === 'string' && cBody.pdfUrl.startsWith(`http://127.0.0.1:${port}/api/projects/${p1.id}/output?`), `compile pdfUrl is absolute and targets /output (got ${cBody.pdfUrl})`);
const cq = Object.fromEntries(new URL(cBody.pdfUrl).searchParams);
check(cq.branch === 'main' && cq.path === '.aldine-out/main.pdf' && /^\d+$/.test(cq.exp) && /^[A-Za-z0-9_-]{43}$/.test(cq.sig) && /^\d+$/.test(cq.t), `compile pdfUrl is signed (branch, path, exp, sig, cache-buster) (got ${JSON.stringify(cq)})`);
check(Number(cq.exp) - Math.floor(Date.now() / 1000) <= 900 && Number(cq.exp) - Math.floor(Date.now() / 1000) > 800, 'compile pdfUrl expires in ~15 minutes');
check(cBody.pdfFile === 'main.pdf' && cBody.pages === 2 && cBody.pdfStale === false && typeof cBody.typesetAt === 'string', `compile carries pdfFile, pages from the log, pdfStale:false, typesetAt (got ${JSON.stringify(cBody)})`);
check(cBody.deepLink === `http://127.0.0.1:${port}/p/${p1.id}` && cBody.projectName === 'Agent paper' && typeof cBody.contentVersion === 'number', 'compile carries deepLink, projectName, contentVersion');
const cFetched = await fetch(cBody.pdfUrl);
check(cFetched.status === 200 && (await cFetched.text()) === mockPdf, `the compile result's signed link serves this run's PDF with no cookie (got ${cFetched.status})`);
check(compilerRequests.at(-1)?.rootFile === 'main.tex', 'the compiler was asked for the project root file');

// The same document compiled again: latexmk finds nothing to redo (ok, the
// PDF on disk, not rewritten). That is a success with this run's PDF under
// the same link, never a stale "previous" one.
compilerQueue.push({ ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: false, synctex: null, log: 'This is pdfTeX\nOutput written on main.pdf (2 pages, 4321 bytes).\nTranscript written on main.log.\n', errors: [], durationMs: 1, pdfBytes: mockPdf });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
cBody = JSON.parse(cRes.content[0].text);
check(cBody.ok === true && cBody.pdfStale === false && typeof cBody.pdfUrl === 'string', `an up-to-date recompile is ok with a link and NOT stale (got ${JSON.stringify({ ok: cBody.ok, pdfStale: cBody.pdfStale, pdfUrl: cBody.pdfUrl })})`);
check(new URL(cBody.pdfUrl).searchParams.get('t') === cq.t, 'an up-to-date recompile keeps the first run\'s cache-buster (same file, same SyncTeX)');
check(cBody.pages === 2 && cBody.pdfFile === 'main.pdf' && typeof cBody.typesetAt === 'string', `an up-to-date recompile carries pages and typesetAt (got ${JSON.stringify({ pages: cBody.pages, typesetAt: cBody.typesetAt })})`);

// A failed run: no PDF from this run → the previous link, flagged stale, the
// parsed errors with file/line for the viewer's deep links, pages unknown.
const manyErrors = Array.from({ length: 60 }, (_, i) => ({ type: 'error', file: './main.tex', line: i + 1, message: `Undefined control sequence ${i}` }));
compilerQueue.push({ ok: false, exitCode: 12, pdf: null, pdfFresh: false, log: '! Undefined control sequence.\nl.3 \\thisisnotacommand\nNo pages of output.\n', errors: manyErrors, durationMs: 4 });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
check(!cRes.isError, 'a failed typeset is a normal result, not a tool error');
cBody = JSON.parse(cRes.content[0].text);
check(cBody.ok === false && cBody.pdfStale === true && typeof cBody.pdfUrl === 'string' && /[?&]sig=/.test(cBody.pdfUrl), `failed run keeps the previous PDF link and flags pdfStale (got ${JSON.stringify({ ok: cBody.ok, pdfStale: cBody.pdfStale, pdfUrl: cBody.pdfUrl })})`);
check(cBody.errors.length === 50 && cBody.errorsTotal === 60, `errors are capped at 50 with errorsTotal 60 (got ${cBody.errors.length}/${cBody.errorsTotal})`);
check(cBody.errors[0].file === './main.tex' && cBody.errors[0].line === 1 && cBody.errors[0].type === 'error', 'each error carries {type,file,line,message} for the viewer deep links');
check(/No pages of output/.test(cBody.logTail), 'the log tail reaches the model');
check(JSON.stringify(cRes.structuredContent) === JSON.stringify(cBody), 'failed run: structuredContent still mirrors the text');

// A compiler that cannot see the project (its DATA_DIR is not the server's)
// answers "root file not found" before TeX runs: that is a tool error the
// model relays, never a failed compile it would "fix" by recreating main.tex.
compilerQueue.push({ ok: false, error: 'root file not found: main.tex' });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
check(cRes.isError === true && /cannot see this project/.test(cRes.content[0].text) && /do not edit/.test(cRes.content[0].text), `a compiler-side setup error is an isError result telling the model to relay (got ${JSON.stringify(cRes.content[0].text)})`);
check(!/main\.tex is missing/.test(cRes.content[0].text) && /root file not found/.test(cRes.content[0].text), 'the compiler\'s own words are quoted so the operator can match them');

// The same compiler answer for a branch that simply lacks the project-wide
// root file (a branch older than a rename) is a document problem the model
// may act on, not a DATA_DIR fault it is told to leave alone.
await gitops.createBranch(p1.id, 'noroot');
store.deleteFile(p1.id, 'noroot', 'main.tex');
compilerQueue.push({ ok: false, error: 'root file not found: main.tex' });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id, branch: 'noroot' } });
check(cRes.isError === true && /"main\.tex" does not exist on noroot/.test(cRes.content[0].text) && !/cannot see this project/.test(cRes.content[0].text), `a root file absent from the compiled branch is named as such, not as a compiler setup fault (got ${JSON.stringify(cRes.content[0].text)})`);
check(/create it there, or ask the user/.test(cRes.content[0].text), 'the model is told the actions that fix it');

// The log parser leaves `file` empty when the engine dies before opening an
// input (a missing package at line 5): the row falls back to the root file,
// and a missing .sty becomes a hint to relay, not a document error.
compilerQueue.push({ ok: false, exitCode: 12, pdf: null, pdfFresh: false, log: '! LaTeX Error: File `biblatex.sty\' not found.\n', errors: [{ type: 'error', line: 5, message: "LaTeX Error: File `biblatex.sty' not found." }, { type: 'error', file: 'main.tex', line: 5, message: 'Emergency stop.' }], durationMs: 4 });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
cBody = JSON.parse(cRes.content[0].text);
check(cBody.errors.every((e) => e.file === 'main.tex'), `every error row names a file, the root file when the parser had none (got ${JSON.stringify(cBody.errors.map((e) => e.file))})`);
check(/biblatex/.test(cBody.hint) && /relay/.test(cBody.hint), `a missing package surfaces as a relay hint (got ${JSON.stringify(cBody.hint)})`);
const { withRootFile, missingPackages, compilerSetupError } = await import('../src/mcp/tools.ts');
check(withRootFile([{ type: 'error', line: 1, message: 'x' }, { type: 'error', file: 'ch1.tex', line: 2, message: 'y' }], 'main.tex').map((e) => e.file).join() === 'main.tex,ch1.tex', 'withRootFile fills only empty files');
check(missingPackages([{ type: 'error', line: 1, message: "LaTeX Error: File `natbib.sty' not found." }, { type: 'error', line: 2, message: 'Undefined control sequence' }]).join() === 'natbib', 'missingPackages names the .sty');
check(compilerSetupError('root file not found: main.tex') && compilerSetupError('ENOENT: no such file') && !compilerSetupError(undefined) && !compilerSetupError('latexmk exited 12'), 'compilerSetupError matches compiler-side refusals only');

// Box reports never reach the result and cannot crowd out the one real error:
// a long document logs dozens of Overfull lines before the first "!".
const boxes = Array.from({ length: 55 }, (_, i) => ({ type: 'typesetting', line: i + 1, message: `Overfull \\hbox (${i}pt too wide) in paragraph at lines ${i + 1}--${i + 2}` }));
const oneError = { type: 'error', file: './main.tex', line: 70, message: 'Undefined control sequence' };
const twoWarnings = [{ type: 'warning', line: 2, message: 'LaTeX Warning: Citation `nothing\' undefined' }, { type: 'warning', line: null, message: 'LaTeX Warning: There were undefined references.' }];
compilerQueue.push({ ok: false, exitCode: 12, pdf: null, pdfFresh: false, log: '! Undefined control sequence.\nl.70 \\thisisnotacommand\nNo pages of output.\n', errors: [twoWarnings[0], ...boxes, oneError, twoWarnings[1]], durationMs: 4 });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
cBody = JSON.parse(cRes.content[0].text);
check(cBody.errors.length === 3 && cBody.errorsTotal === 3, `Overfull/Underfull rows are dropped from errors and errorsTotal (got ${cBody.errors.length}/${cBody.errorsTotal})`);
check(cBody.errors[0].type === 'error' && cBody.errors[0].line === 70, `the real error is ranked first, ahead of earlier warnings (got ${JSON.stringify(cBody.errors.map((e) => e.type))})`);
check(cBody.errors[1].line === 2 && cBody.errors[2].line === null, 'warnings keep their log order after the errors');

// pdfTeX under -halt-on-error deletes the PDF of a run that fails after the
// first page shipped out: the "previous" file is gone, so the result must
// not link to it — and get_pdf_url has nothing to hand out until a compile.
compilerQueue.push({ ok: false, exitCode: 12, pdf: null, pdfFresh: false, deletePdf: '.aldine-out/main.pdf', log: '! Undefined control sequence.\nl.30 \\thisisnotacommand\n==> Fatal error occurred, no output PDF file produced!\n', errors: [{ type: 'error', file: './main.tex', line: 30, message: 'Undefined control sequence' }], durationMs: 4 });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
cBody = JSON.parse(cRes.content[0].text);
check(cBody.ok === false && cBody.pdfStale === true && cBody.pdfUrl === null && cBody.pdfFile === null && cBody.typesetAt === null && cBody.pages === null, `a failed run whose engine removed the PDF: pdfStale with no link to the missing file (got ${JSON.stringify({ ok: cBody.ok, pdfStale: cBody.pdfStale, pdfUrl: cBody.pdfUrl, pages: cBody.pages })})`);
res = await call('get_pdf_url', { project: p1.id });
check(res.isError === true && /compile first/.test(res.body), `get_pdf_url after the engine removed the PDF says to compile first (got ${JSON.stringify(res.body)})`);
compilerQueue.push({ ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: null, log: 'Output written on main.pdf (2 pages, 4321 bytes).\n', errors: [], durationMs: 5, pdfBytes: mockPdf });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
cBody = JSON.parse(cRes.content[0].text);
check(cBody.ok === true && cBody.pdfStale === false && typeof cBody.pdfUrl === 'string', 'a later success hands out a link again');

// stop-on-first-error: the failed run overwrote the PDF with a truncated one,
// so the "previous PDF" no longer exists on disk — no link, still flagged.
const p1Meta = await store.readMeta(p1.id);
p1Meta.stopOnFirstError = true;
await store.writeMeta(p1Meta);
await new Promise((r) => setTimeout(r, 20));
const truncatingRun = { ok: false, exitCode: 12, pdf: '.aldine-out/main.pdf', pdfFresh: true, log: '! Undefined control sequence.\nl.30 \\thisisnotacommand\nOutput written on main.pdf (1 page, 999 bytes).\n', errors: [{ type: 'error', file: './main.tex', line: 30, message: 'Undefined control sequence' }], durationMs: 4, pdfBytes: '%PDF-1.7\n% truncated at the first error\n%%EOF\n' };
compilerQueue.push({ ...truncatingRun });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
cBody = JSON.parse(cRes.content[0].text);
check(compilerRequests.at(-1)?.haltOnError === true, 'the compiler was asked to halt on the first error');
check(cBody.ok === false && cBody.pdfStale === true && cBody.pdfUrl === null && cBody.pdfFile === null && cBody.typesetAt === null, `halt-on-error failure that overwrote the PDF: pdfStale with no link to the truncated file (got ${JSON.stringify({ ok: cBody.ok, pdfStale: cBody.pdfStale, pdfUrl: cBody.pdfUrl })})`);
// The torso is on disk with a log that says the run stopped: get_pdf_url
// must not present it as the branch's PDF.
res = await call('get_pdf_url', { project: p1.id });
check(res.isError === true && /stopped on an error/.test(res.body) && /compile/.test(res.body), `get_pdf_url refuses the truncated file of a halted run (got ${JSON.stringify(res.body)})`);
// After a restart compile.ts remembers no previous link; the same halted run
// still must not fall back to the torso it just wrote.
forgetPdfUrls(p1.id);
compilerQueue.push({ ...truncatingRun });
cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
cBody = JSON.parse(cRes.content[0].text);
check(cBody.ok === false && cBody.pdfStale === true && cBody.pdfUrl === null && cBody.typesetAt === null, `halt-on-error truncation right after a restart: still no link (got ${JSON.stringify({ ok: cBody.ok, pdfStale: cBody.pdfStale, pdfUrl: cBody.pdfUrl })})`);
p1Meta.stopOnFirstError = false;
await store.writeMeta(p1Meta);

// project-scoped token: cross-project access refused, project param optional,
// and no project creation (the scope is the token's blast radius)
const { token: scopedTok } = await auth.createAccessToken(user.id, 'Scoped', [p1.id], null);
const scoped = await connect(scopedTok);
let sres = await scoped.callTool({ name: 'project_structure', arguments: { project: p2.id } });
check(sres.isError === true, 'scoped token crossing projects is refused');
sres = await scoped.callTool({ name: 'project_structure', arguments: {} });
const sbody = JSON.parse(sres.content[0].text);
check(sres.isError !== true && sbody.files.some((f) => f.path === 'main.tex'), 'single-project scope makes the project param optional');
sres = await scoped.callTool({ name: 'create_project', arguments: { name: 'Escape attempt' } });
check(sres.isError === true && /scoped/.test(sres.content[0].text), `a project-scoped token cannot create projects (got ${JSON.stringify(sres.content[0].text)})`);
const countAfter = (await store.listProjects()).filter((m) => m.name === 'Escape attempt').length;
check(countAfter === 0, 'the refused create_project created nothing');
sres = await scoped.callTool({ name: 'list_citations', arguments: {} });
check(sres.isError !== true && JSON.parse(sres.content[0].text).citations.some((c) => c.key === 'doe2020'), 'read wrappers honor the single-project scope default');
await scoped.close();

// ---- per-file conflict detection (dogfood session 1, friction #1) ----
// A fresh project so the p1 state above (direct store writes, pending
// autosaves) cannot leak into the version arithmetic.
const p3 = await store.createProject('Per-file versions', undefined, user.id);
({ body } = await call('read_file', { project: p3.id, path: 'main.tex' }));
const mainBase = body.contentVersion;
const mainFv = body.fileVersion;
check(typeof mainFv === 'number' && mainFv <= mainBase, 'read_file returns fileVersion <= contentVersion');
({ body } = await call('write_file', { project: p3.id, path: 'other.tex', content: 'Other file.\n' }));
check(body.ok === true && body.contentVersion > mainBase, 'a write_file to other.tex raises contentVersion');
({ body } = await call('read_file', { project: p3.id, path: 'main.tex' }));
check(body.contentVersion > mainBase && body.fileVersion === mainFv, 'the other.tex write leaves main.tex fileVersion alone');
({ body } = await call('edit_file', {
  project: p3.id, path: 'main.tex',
  edits: [{ quote: 'Start writing here\\ldots', replacement: 'First agent edit.' }],
  base_version: mainBase,
}));
check(body.applied === 1, `edit A after B changed → no conflict (got ${JSON.stringify(body.error ?? body.applied)})`);
check(body.fileVersion === body.contentVersion, 'edit result fileVersion === contentVersion for the file just written');
const afterEdit = body.contentVersion;
({ body } = await call('edit_file', {
  project: p3.id, path: 'main.tex',
  edits: [{ quote: 'First agent edit.', replacement: 'Second agent edit.' }],
  base_version: mainBase,
}));
check(body.error === 'version_conflict' && body.currentVersion > mainBase && body.fileVersion > mainBase, 'edit A after A changed → version_conflict with currentVersion and fileVersion above the base');
{
  const disk = store.readFile(p3.id, 'main', 'main.tex').toString('utf8');
  check(disk.includes('First agent edit.') && !disk.includes('Second agent edit.'), 'the conflicting edit left disk unchanged');
}
({ body } = await call('write_file', { project: p3.id, path: 'other.tex', content: 'x\n', base_version: afterEdit + 50 }));
check(body.error === 'version_conflict' && body.currentVersion === afterEdit, 'write_file with base_version newer than the branch → version_conflict');

// batch_write: one stale entry refuses the whole batch
({ body } = await call('read_file', { project: p3.id, path: 'other.tex' }));
const otherBase = body.contentVersion;
({ body } = await call('write_file', { project: p3.id, path: 'other.tex', content: 'Other file, revised.\n' }));
check(body.ok === true, 'setup: other.tex changed after its read');
({ body } = await call('batch_write', {
  project: p3.id,
  files: [
    { path: 'new.tex', content: 'A new file.\n' },
    { path: 'other.tex', edits: [{ quote: 'Other file, revised.', replacement: 'Other file, batched.' }], base_version: otherBase },
  ],
  message: 'Stale batch',
}));
check(body.error === 'version_conflict' && body.file === 'other.tex' && typeof body.currentVersion === 'number' && typeof body.fileVersion === 'number', 'batch_write: a stale entry refuses the whole batch naming the file');
check(!store.fileExists(p3.id, 'main', 'new.tex'), 'the refused batch created nothing');
({ body } = await call('read_file', { project: p3.id, path: 'other.tex' }));
const otherNow = body.contentVersion;
({ body } = await call('batch_write', {
  project: p3.id,
  files: [
    { path: 'new.tex', content: 'A new file.\n', base_version: otherNow },
    { path: 'other.tex', edits: [{ quote: 'Other file, revised.', replacement: 'Other file, batched.' }], base_version: otherNow },
  ],
  message: 'Batched change',
}));
check(body.ok === true && typeof body.commit === 'string', 'batch_write with current per-entry base_versions writes both files and returns a commit');
check(store.fileExists(p3.id, 'main', 'new.tex') && store.readFile(p3.id, 'main', 'other.tex').toString('utf8').includes('batched'), 'both batch entries reached disk');

// a git revert counts as a change to every path
({ body } = await call('commit', { project: p3.id, message: 'Land the agent edits' }));
const revertHash = body.committed ? body.hash : (await gitops.log(p3.id, 'main'))[0].hash;
({ body } = await call('read_file', { project: p3.id, path: 'main.tex' }));
const preRevert = body.contentVersion;
let rres;
const revertLog = await captureLog(async () => {
  rres = await app.inject({ method: 'POST', url: `/api/projects/${p3.id}/revert`, headers: { authorization: `Bearer ${token}` }, payload: { branch: 'main', hashes: [revertHash] } });
});
check(rres.statusCode === 200 && rres.json().ok === true, `setup: revert via REST (got ${rres.statusCode} ${rres.body})`);
check(revertLog.some((l) => l === `[metric] agent_revert user=${user.id} project=${p3.id} commits=1`), `reverting a Claude commit logs its success-metric line (got ${JSON.stringify(revertLog)})`);
({ body } = await call('edit_file', {
  project: p3.id, path: 'main.tex',
  edits: [{ quote: '\\documentclass{article}', replacement: '\\documentclass[11pt]{article}' }],
  base_version: preRevert,
}));
check(body.error === 'version_conflict' && body.fileVersion > preRevert, 'after a git revert edit_file with the pre-revert base → version_conflict');
({ body } = await call('write_file', { project: p3.id, path: 'never-existed.tex', content: 'x\n', base_version: preRevert }));
check(body.error === 'version_conflict', 'after the revert a never-existing path conflicts with the pre-revert base too');
({ body } = await call('read_file', { project: p3.id, path: 'main.tex' }));
({ body } = await call('edit_file', {
  project: p3.id, path: 'main.tex',
  edits: [{ quote: '\\documentclass{article}', replacement: '\\documentclass[11pt]{article}' }],
  base_version: body.contentVersion,
}));
check(body.applied === 1, 'a re-read after the revert makes the edit apply');

// a branch deleted and recreated under the same name starts a fresh version
// log: a base_version read before the delete must not pass against the new tree
rres = await app.inject({ method: 'POST', url: `/api/projects/${p3.id}/branches`, headers: { authorization: `Bearer ${token}` }, payload: { name: 'feature', from: 'main' } });
check(rres.statusCode === 200, `setup: create branch feature (got ${rres.statusCode} ${rres.body})`);
({ body } = await call('read_file', { project: p3.id, path: 'main.tex', branch: 'feature' }));
const featureBase = body.contentVersion;
rres = await app.inject({ method: 'DELETE', url: `/api/projects/${p3.id}/branches?name=feature`, headers: { authorization: `Bearer ${token}` } });
check(rres.statusCode === 200, `setup: delete branch feature (got ${rres.statusCode} ${rres.body})`);
rres = await app.inject({ method: 'POST', url: `/api/projects/${p3.id}/branches`, headers: { authorization: `Bearer ${token}` }, payload: { name: 'feature', from: 'main' } });
check(rres.statusCode === 200, `setup: recreate branch feature (got ${rres.statusCode} ${rres.body})`);
({ body } = await call('write_file', { project: p3.id, path: 'main.tex', branch: 'feature', content: 'Based on a branch that no longer exists.\n', base_version: featureBase }));
check(body.error === 'version_conflict' && body.fileVersion > featureBase, `a pre-delete base_version is refused on the recreated branch (got ${JSON.stringify(body)})`);
({ body } = await call('read_file', { project: p3.id, path: 'main.tex', branch: 'feature' }));
({ body } = await call('write_file', { project: p3.id, path: 'main.tex', branch: 'feature', content: 'Based on a fresh read.\n', base_version: body.contentVersion }));
check(body.ok === true, 'a fresh read of the recreated branch writes');

// Path spelling: "./main.tex" is main.tex. The open-doc lookup, the
// attribution ledger, the git pathspec and the version log all key on the
// spelling the tool hands them, so a raw "./" would splice the disk copy
// under the live doc (the next keystroke overwrites the edit) and register
// an attribution no git status path matches (no Claude commit).
{
  const collab = await import('../src/collab.ts');
  const p4 = await store.createProject('Spelling', undefined, user.id);
  store.writeFile(p4.id, 'main', 'main.tex', 'Hello world line one.\n');
  await gitops.commitAll(p4.id, 'main', 'seed');
  ({ body } = await call('read_file', { project: p4.id, path: './main.tex' }));
  check(body.content === 'Hello world line one.\n' && body.fileVersion === (await call('read_file', { project: p4.id, path: 'main.tex' })).body.fileVersion, 'read_file accepts ./main.tex as main.tex');
  res = await call('read_file', { project: p4.id, path: '../main.tex' });
  check(res.isError === true && /Invalid file path/.test(res.body), 'a path with .. is still refused');
  // a person has main.tex open in the editor
  const conn = await collab.hocuspocus.openDirectConnection(collab.docName(p4.id, 'main', 'main.tex'), {});
  check(collab.openDocContent(p4.id, 'main', 'main.tex') === 'Hello world line one.\n', 'setup: the doc is open under the canonical name');
  ({ body } = await call('edit_file', { project: p4.id, path: './main.tex', edits: [{ quote: 'Hello world', replacement: 'Goodbye world' }] }));
  check(body.applied === 1, `edit_file ./main.tex applies (got ${JSON.stringify(body)})`);
  check(collab.openDocContent(p4.id, 'main', 'main.tex') === 'Goodbye world line one.\n', 'the edit went through the open doc (CRDT path), not around it');
  await gitops.autoCommit(p4.id, 'main');
  const spelled = (await gitops.log(p4.id, 'main')).find((c) => c.author === 'Claude');
  check(spelled !== undefined && spelled.message === 'Edit main.tex', `the attribution matched the git path: a Claude commit named after the canonical path (got ${JSON.stringify((await gitops.log(p4.id, 'main')).map((c) => `${c.author}: ${c.message}`))})`);
  check((await gitops.commitDiff(p4.id, spelled.hash)).patch.includes('+Goodbye world line one.'), 'the Claude commit carries the edit');
  await conn.transact((doc) => { doc.getText('content').insert(0, 'X'); });
  collab.flushBranchDocs(p4.id, 'main');
  check(store.readFile(p4.id, 'main', 'main.tex').toString('utf8') === 'XGoodbye world line one.\n', 'a keystroke after the edit keeps the edit on disk');
  await conn.disconnect();
  // batch_write: two spellings of one file are one path
  res = await call('batch_write', {
    project: p4.id,
    files: [
      { path: './main.tex', edits: [{ quote: 'Goodbye world', replacement: 'Hello again' }] },
      { path: 'main.tex', content: 'Clobbered\n' },
    ],
    message: 'Two spellings',
  });
  check(res.isError === true && /more than once/.test(res.body), 'batch_write refuses ./main.tex and main.tex as one path listed twice');
  // write_file under another spelling of the open file reseeds that doc
  const conn2 = await collab.hocuspocus.openDirectConnection(collab.docName(p4.id, 'main', 'main.tex'), {});
  ({ body } = await call('write_file', { project: p4.id, path: './/main.tex', content: 'Whole rewrite.\n' }));
  check(body.ok === true && collab.openDocContent(p4.id, 'main', 'main.tex') === 'Whole rewrite.\n', 'write_file .//main.tex reaches the open main.tex doc');
  await conn2.disconnect();
  // Letter case is the one difference importPath keeps. On a case-insensitive
  // host "Main.tex" writes the same bytes as the open "main.tex" while the
  // open-doc lookup and the git status pathspec miss it; the fold to the
  // listed spelling applies on every host, so these assertions are not
  // guarded — only the ambiguity refusal needs a case-sensitive filesystem.
  // disconnect() resolves before Hocuspocus's post-store unload runs; a doc
  // opened in that window is destroyed under the new connection
  for (let i = 0; i < 50 && collab.openDocContent(p4.id, 'main', 'main.tex') !== null; i++) await new Promise((r) => setTimeout(r, 20));
  const conn3 = await collab.hocuspocus.openDirectConnection(collab.docName(p4.id, 'main', 'main.tex'), {});
  check(collab.openDocContent(p4.id, 'main', 'main.tex') === 'Whole rewrite.\n', 'setup: main.tex is open again under the listed spelling');
  ({ body } = await call('read_file', { project: p4.id, path: 'MAIN.TEX' }));
  check(body.content === 'Whole rewrite.\n', `read_file MAIN.TEX reads main.tex (got ${JSON.stringify(body)})`);
  ({ body } = await call('edit_file', { project: p4.id, path: 'Main.tex', edits: [{ quote: 'Whole rewrite', replacement: 'Cased rewrite' }] }));
  check(body.applied === 1, `edit_file Main.tex applies (got ${JSON.stringify(body)})`);
  check(collab.openDocContent(p4.id, 'main', 'main.tex') === 'Cased rewrite.\n', 'the edit under a case variant went through the open main.tex doc');
  await gitops.autoCommit(p4.id, 'main');
  const cased = (await gitops.log(p4.id, 'main'))[0];
  check(cased.author === 'Claude' && cased.message === 'Edit main.tex', `edit_file Main.tex commits as Claude under the listed spelling (got ${JSON.stringify(`${cased.author}: ${cased.message}`)})`);
  check((await gitops.commitDiff(p4.id, cased.hash)).patch.includes('+Cased rewrite.'), 'that Claude commit carries the edit');
  await conn3.disconnect();
  // a whole-file write under a case variant is refused rather than folded:
  // folding would silently replace main.tex under a name the caller never
  // listed, keeping the spelling would create a case-only sibling (a
  // checkout collision on a Mac). The refusal names the listed spelling.
  res = await call('write_file', { project: p4.id, path: 'MAIN.tex', content: 'Upper write.\n' });
  check(res.isError === true && /"MAIN\.tex" would replace "main\.tex"/.test(res.body) && /listed spelling/.test(res.body), `write_file MAIN.tex is refused and names main.tex (got ${JSON.stringify(res.body)})`);
  check(store.readFile(p4.id, 'main', 'main.tex').toString('utf8') === 'Cased rewrite.\n', 'main.tex is untouched by the refused write');
  check(!store.listFiles(p4.id, 'main').some((e) => e.path === 'MAIN.tex'), 'no MAIN.tex sibling was created');
  ({ body } = await call('write_file', { project: p4.id, path: './main.tex', content: 'Upper write.\n' }));
  check(body.ok === true && body.path === 'main.tex' && store.readFile(p4.id, 'main', 'main.tex').toString('utf8') === 'Upper write.\n', `the listed spelling replaces main.tex and the result carries the resolved path (got ${JSON.stringify(body)})`);
  // a new name keeps its case, at any depth; a directory segment still folds
  ({ body } = await call('write_file', { project: p4.id, path: 'Sections/Intro.tex', content: 'Intro section.\n' }));
  check(body.ok === true && body.path === 'Sections/Intro.tex' && store.listFiles(p4.id, 'main').some((e) => e.path === 'Sections/Intro.tex'), 'a new path keeps the spelling it was given');
  ({ body } = await call('read_file', { project: p4.id, path: 'sections/intro.tex' }));
  check(body.content === 'Intro section.\n', 'a directory segment folds too');
  ({ body } = await call('write_file', { project: p4.id, path: 'sections/Method.tex', content: 'Method.\n' }));
  check(body.ok === true && body.path === 'Sections/Method.tex', `a whole-file write folds its directory segments onto the listed spelling (got ${JSON.stringify(body.path)})`);
  ({ body } = await call('edit_file', { project: p4.id, path: 'sections/intro.tex', edits: [{ quote: 'Intro section', replacement: 'Introduction' }] }));
  check(body.applied === 1 && body.path === 'Sections/Intro.tex', `edit_file keeps folding a case variant and reports the resolved path (got ${JSON.stringify(body.path)})`);
  // batch_write: two new entries differing only by case are one file on a
  // Mac and a checkout collision on Linux — refused up front, nothing written
  res = await call('batch_write', { project: p4.id, files: [{ path: 'New.tex', content: 'a\n' }, { path: 'new.tex', content: 'b\n' }], message: 'Case twins' });
  check(res.isError === true && /"New\.tex" and "new\.tex" more than once/.test(res.body) && /different case/.test(res.body), `batch_write refuses New.tex + new.tex (got ${JSON.stringify(res.body)})`);
  check(!store.listFiles(p4.id, 'main').some((e) => /^new\.tex$/i.test(e.path)), 'the refused batch wrote nothing');
  res = await call('batch_write', { project: p4.id, files: [{ path: 'Sec/a.tex', content: 'a\n' }, { path: 'sec/b.tex', content: 'b\n' }], message: 'One new directory' });
  check(res.isError === false && JSON.stringify(res.body.paths) === JSON.stringify(['Sec/a.tex', 'Sec/b.tex']), `a later entry folds its new directory onto the earlier entry's spelling (got ${JSON.stringify(res.body.paths ?? res.body)})`);
  check(store.listFiles(p4.id, 'main').filter((e) => /^sec\//i.test(e.path)).every((e) => e.path.startsWith('Sec/')), 'one directory on disk, not Sec/ and sec/');
  res = await call('batch_write', { project: p4.id, files: [{ path: 'Sec/A.tex', content: 'x\n' }], message: 'Case twin of a listed file' });
  check(res.isError === true && /"Sec\/A\.tex" would replace "Sec\/a\.tex"/.test(res.body), `a batch content entry under a case variant of a listed file is refused (got ${JSON.stringify(res.body)})`);
  // A path segment starting with "-" would reach git as an option
  // ("--amend" rewrites the previous person's commit under Claude's name):
  // refused at the tool boundary, and harmless at the primitive even so.
  res = await call('write_file', { project: p4.id, path: '--amend', content: 'x\n' });
  check(res.isError === true && /cannot start with "-"/.test(res.body), `write_file refuses a path starting with "-" (got ${JSON.stringify(res.body)})`);
  res = await call('edit_file', { project: p4.id, path: 'Sections/-a.tex', edits: [{ quote: 'irrelevant quote', replacement: '' }] });
  check(res.isError === true && /cannot start with "-"/.test(res.body), 'edit_file refuses a "-" segment at any depth');
  {
    await gitops.autoCommit(p4.id, 'main');
    const before = await gitops.log(p4.id, 'main');
    store.writeFile(p4.id, 'main', '--amend', 'planted\n');
    const dash = await gitops.commitPaths(p4.id, 'main', ['--amend'], 'Agent intent', 'Claude');
    const after = await gitops.log(p4.id, 'main');
    check(dash.committed === true && after.length === before.length + 1 && after[1].hash === before[0].hash, `a "--amend" pathspec at the primitive adds a commit and leaves the previous one in place (got ${after.length} vs ${before.length})`);
    check((await gitops.commitDiff(p4.id, after[0].hash)).stat.includes('--amend'), 'the planted file is what got committed');
    store.deleteFile(p4.id, 'main', '--amend');
    await gitops.autoCommit(p4.id, 'main');
  }
  // Control characters in message: a NUL fails git's spawn and, re-queued
  // verbatim, would block every later autosave on the branch; ESC/C1 would
  // reach terminals. Cleaned at the boundary; the sweep after it still lands.
  ({ body } = await call('write_file', { project: p4.id, path: 'main.tex', content: 'Cleaned message.\n', message: 'Tighten\u0000 the abstract\u001b[31m\r\u0085now' }));
  check(body.ok === true, 'a message with control characters is accepted');
  store.writeFile(p4.id, 'main', 'human.tex', 'typed by a person\n');
  collab.scheduleCommit(p4.id, 'main');
  await gitops.autoCommit(p4.id, 'main');
  const cleanedLog = await gitops.log(p4.id, 'main');
  const cleaned = cleanedLog.find((c) => c.author === 'Claude' && /Tighten/.test(c.message));
  check(cleaned !== undefined && cleaned.message === 'Tighten the abstract[31m now', `the commit subject is the message minus control characters, CR as a space (got ${JSON.stringify(cleaned?.message)})`);
  check(cleanedLog[0].message === 'aldine: autosave' && (await gitops.commitDiff(p4.id, cleanedLog[0].hash)).stat.includes('human.tex'), 'the anonymous sweep after it still commits the person\'s file');
  // The log parser splits on delimiters a subject cannot carry: a message
  // shaped like simple-git's record separator cannot move itself into the
  // author field the History panel and the session review key on.
  await gitops.commitAll(p4.id, 'main', 'Tighten abstract \xf2  \xf2  \xf2 Alice \xf2 alice@example.com', 'Claude');
  store.writeFile(p4.id, 'main', 'human.tex', 'typed again\n');
  await gitops.commitAll(p4.id, 'main', 'Tighten abstract \xf2  \xf2  \xf2 Alice \xf2 alice@example.com', 'Claude');
  const spoof = (await gitops.log(p4.id, 'main'))[0];
  check(spoof.author === 'Claude' && spoof.message === 'Tighten abstract \xf2  \xf2  \xf2 Alice \xf2 alice@example.com', `a record-separator-shaped subject stays in the subject (got ${JSON.stringify(spoof)})`);
  const caseSensitiveFs = !fs.existsSync(path.join(store.branchDir(p4.id, 'main'), 'MAIN.TEX'));
  if (caseSensitiveFs) {
    store.writeFile(p4.id, 'main', 'Ambig.tex', 'a\n');
    store.writeFile(p4.id, 'main', 'ambig.tex', 'b\n');
    res = await call('read_file', { project: p4.id, path: 'AMBIG.tex' });
    check(res.isError === true && /Ambiguous file path/.test(res.body), `a spelling matching two case-only siblings is refused, not guessed (got ${res.body})`);
    ({ body } = await call('read_file', { project: p4.id, path: 'ambig.tex' }));
    check(body.content === 'b\n', 'an exact spelling among case-only siblings still resolves');
  }
}

// A file name that is a valid git glob or pathspec magic is legal on disk
// and must commit literally. `--` only ends option parsing: without literal
// pathspecs `git add -- '*.tex'` staged EVERY dirty .tex file into the Claude
// commit (a collaborator's uncommitted edits under Claude, undone by "Revert
// these changes"), an all-negative ':!x' matched the whole tree, and
// ':(icase)MAIN.TEX' matched main.tex instead of itself (the attributed
// commit then found nothing staged and the edit was swept anonymously).
{
  const p5 = await store.createProject('Pathspec', undefined, user.id);
  store.writeFile(p5.id, 'main', 'main.tex', 'human line one\n');
  store.writeFile(p5.id, 'main', 'sub/other.tex', 'other line one\n');
  await gitops.commitAll(p5.id, 'main', 'seed', 'Alice');
  for (const [rel, message] of [['*.tex', 'Glob name'], [':!zzz.tex', 'Negative magic'], [':(icase)MAIN.TEX', 'Icase magic'], ['sub/*', 'Glob in a directory']]) {
    // the person's uncommitted edits, in the debounce window
    store.writeFile(p5.id, 'main', 'main.tex', `human line one\nhuman line two, pending during ${message}\n`);
    store.writeFile(p5.id, 'main', 'sub/other.tex', `other line one\nother line two, pending during ${message}\n`);
    ({ body } = await call('write_file', { project: p5.id, path: rel, content: `agent wrote ${rel}\n`, message }));
    check(body.ok === true && body.path === rel, `write_file accepts ${JSON.stringify(rel)} (got ${JSON.stringify(body)})`);
    check(store.readFile(p5.id, 'main', rel).toString('utf8') === `agent wrote ${rel}\n`, `${JSON.stringify(rel)} is a file of that literal name`);
    await gitops.autoCommit(p5.id, 'main');
    const titled = (await gitops.log(p5.id, 'main')).find((c) => c.message === message);
    check(titled !== undefined && titled.author === 'Claude', `${JSON.stringify(rel)} commits under Claude with its intent (got ${JSON.stringify((await gitops.log(p5.id, 'main')).slice(0, 3).map((c) => `${c.author}: ${c.message}`))})`);
    const { stat, patch } = await gitops.commitDiff(p5.id, titled.hash);
    check(stat.includes(rel) && !patch.includes('human line two') && !patch.includes('other line two'), `the Claude commit for ${JSON.stringify(rel)} holds only that file, none of the person's pending edits (stat: ${stat.trim().replace(/\n/g, ' | ')})`);
    check(stat.trim().split('\n').filter((l) => l.includes('|')).length === 1, `exactly one file in the ${JSON.stringify(rel)} commit`);
  }
  const claudes = (await gitops.log(p5.id, 'main')).filter((c) => c.author === 'Claude');
  check(claudes.length === 4, `four literal writes, four Claude commits (got ${claudes.length})`);
}

// REST on the same project: the file-version header and the per-file 409
rres = await app.inject({ method: 'GET', url: `/api/projects/${p3.id}/file?branch=main&path=main.tex`, headers: { authorization: `Bearer ${token}` } });
const restV = Number(rres.headers['x-aldine-content-version']);
const restFv = Number(rres.headers['x-aldine-file-version']);
check(rres.statusCode === 200 && Number.isFinite(restFv) && restFv <= restV, 'GET /file carries x-aldine-file-version <= x-aldine-content-version');
rres = await app.inject({ method: 'PUT', url: `/api/projects/${p3.id}/file`, headers: { authorization: `Bearer ${token}` }, payload: { branch: 'main', path: 'sibling.tex', content: 'sibling\n' } });
check(rres.statusCode === 200, 'PUT of a sibling lands');
rres = await app.inject({ method: 'PUT', url: `/api/projects/${p3.id}/file`, headers: { authorization: `Bearer ${token}` }, payload: { branch: 'main', path: 'figs/-a.tex', content: 'x\n' } });
check(rres.statusCode === 400 && /cannot start with "-"/.test(rres.json().error), `PUT /file refuses a "-" segment (got ${rres.statusCode})`);
rres = await app.inject({ method: 'POST', url: `/api/projects/${p3.id}/file/rename`, headers: { authorization: `Bearer ${token}` }, payload: { branch: 'main', from: 'sibling.tex', to: '--all' } });
check(rres.statusCode === 400 && /cannot start with "-"/.test(rres.json().error), `rename refuses a "-" target (got ${rres.statusCode})`);
rres = await app.inject({ method: 'PUT', url: `/api/projects/${p3.id}/file`, headers: { authorization: `Bearer ${token}` }, payload: { branch: 'main', path: 'main.tex', content: 'rewritten over REST\n', baseVersion: restV } });
check(rres.statusCode === 200, `PUT main.tex with the baseVersion from before the sibling write → 200 (got ${rres.statusCode})`);

await client.close();
await app.close();
upstream.close();
mockCompiler.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP tools: ALL PASSED');
process.exit(0);
