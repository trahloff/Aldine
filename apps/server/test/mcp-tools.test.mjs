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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-mcp-tools-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_MCP_BURST = '500';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_MCP_TOKEN;
delete process.env.ALDINE_PROTECTED_PROJECTS;
delete process.env.ALDINE_PUBLIC_URL;
delete process.env.ALDINE_COMPILE_PER_MIN;

const { resolveEdits, spliceEdits, nearestCandidates, logTail, LOG_TAIL_BYTES, MIN_QUOTE_LEN } =
  await import('../src/mcp/tools.ts');

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
const { registerMcp } = await import('../src/mcp/server.ts');
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
  'batch_write', 'commit', 'compile', 'create_project', 'edit_file', 'list_citations', 'list_labels',
  'list_projects', 'ping', 'project_structure', 'read_file', 'references_add', 'wordcount', 'write_file',
];
check(JSON.stringify(names) === JSON.stringify(expected), `tool surface is exactly the 13 spec tools + ping (got ${names.join(',')})`);
for (const t of listed) {
  const ro = ['list_projects', 'project_structure', 'read_file', 'ping', 'list_citations', 'list_labels', 'wordcount'].includes(t.name);
  check((t.annotations?.readOnlyHint === true) === ro, `${t.name} readOnlyHint ${ro ? 'present' : 'absent'}`);
}
// descriptions are the model's API docs: the etiquette the spec requires
// must be stated where the model reads it
const desc = Object.fromEntries(listed.map((t) => [t.name, t.description]));
check(/re-read/.test(desc.edit_file) && /2 retries/.test(desc.edit_file), 'edit_file teaches the stale_anchor retry etiquette (re-read, ≤2 retries)');
check(/prefer edit_file/i.test(desc.write_file), 'write_file steers to edit_file for existing files');
check(/3 times/.test(desc.compile) && /attempt 2 of 3/.test(desc.compile), 'compile states the 3-attempt fix-loop cap with narration');
check(/relay/.test(desc.compile), 'compile tells the model to relay quota/unreachable errors instead of retrying');
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
fs.rmSync(tmp, { recursive: true, force: true });
console.log('MCP tools: ALL PASSED');
process.exit(0);
