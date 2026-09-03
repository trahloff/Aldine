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
const p1 = await store.createProject('Agent paper', {}, user.id);
const p2 = await store.createProject('Other paper', {}, user.id);
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
let cRes = await client.callTool({ name: 'compile', arguments: { project: p1.id } });
check(!cRes.isError, `compile succeeds over the mock compiler (got ${cRes.content[0].text})`);
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

await client.close();
await app.close();
upstream.close();
mockCompiler.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP tools: ALL PASSED');
process.exit(0);
