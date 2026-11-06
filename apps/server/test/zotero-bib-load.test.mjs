/**
 * A Zotero import writes zotero.bib; a paper that does not load it leaves
 * every citation from it undefined (cite-1).
 *  - planBibLoad: whether the sources load the .bib, and the one edit that
 *    makes them, for biblatex and BibTeX, comments and \input preambles
 *  - GET/POST /zotero/bib-load: the state, and the edit made on disk for a
 *    closed file (line endings kept) and through the live doc for an open
 *    one, merging with typing; a second POST adds nothing
 *  - a Zotero sync and a reference lookup keep what was typed in an open
 *    doc but not yet saved
 *
 * Real routes and collab on a throwaway datastore, auth off, a mock Zotero
 * API and DOI resolver; env is set before any src import. The autosave debounce is pushed
 * past the test's lifetime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-zotero-bib-load-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'REMOTE_PROVIDERS']) delete process.env[k];

let version = 5;
const zoteroMock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.pathname === '/keys/current') return json({ userID: 7, username: 'ada' });
  if (url.pathname.endsWith('/items/top')) {
    const since = req.headers['if-modified-since-version'];
    if (since && Number(since) >= version) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain', 'Last-Modified-Version': String(version), 'Total-Results': '1' });
    return res.end('@book{zot1, title={From Zotero}, year={2001}}\n');
  }
  if (url.pathname.startsWith('/10.')) {
    res.writeHead(200, { 'content-type': 'application/x-bibtex' });
    return res.end('@article{doe2020, title={Looked Up}, author={Doe, Jane}, year={2020}}');
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => zoteroMock.listen(0, '127.0.0.1', r));
process.env.ZOTERO_API_BASE = `http://127.0.0.1:${zoteroMock.address().port}`;
process.env.DOI_API_BASE = process.env.ZOTERO_API_BASE;

const { planBibLoad, maskComments } = await import('../src/bibload.ts');

// ---- the planner on its own ----
const src = (p, text, editable = true) => ({ path: p, text, editable });
const plan = (files, root = 'main.tex', bib = 'zotero.bib') => planBibLoad(files, root, bib);
const applied = (files, root = 'main.tex', bib = 'zotero.bib') => {
  const p = plan(files, root, bib);
  check(!p.loaded && p.fix, `an edit is planned for ${files.map((f) => f.path).join(', ')}`);
  const f = files.find((s) => s.path === p.fix.file);
  return { file: p.fix.file, kind: p.fix.kind, command: p.fix.command, text: f.text.slice(0, p.fix.at) + p.fix.insert + f.text.slice(p.fix.at) };
};

eq(maskComments('a % b\n\\% c % d\n\\\\% e'), 'a    \n\\% c    \n\\\\   ', 'comments blank to spaces, an escaped % stays');

const BIBLATEX = '\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{references.bib}\n\n\\begin{document}\nHi \\cite{zot1}.\n\\printbibliography\n\\end{document}\n';
eq(applied([src('main.tex', BIBLATEX)]), {
  file: 'main.tex', kind: 'addbibresource', command: '\\addbibresource{zotero.bib}',
  text: BIBLATEX.replace('\\addbibresource{references.bib}\n', '\\addbibresource{references.bib}\n\\addbibresource{zotero.bib}\n'),
}, 'biblatex: one more \\addbibresource after the last one');
eq(plan([src('main.tex', BIBLATEX.replace('references.bib', 'zotero.bib'))]), { loaded: true }, 'a document that loads it needs nothing');
eq(plan([src('main.tex', BIBLATEX.replace('{references.bib}', '{./zotero.bib}'))]), { loaded: true }, 'nor one that spells the path with ./');
eq(plan([src('main.tex', BIBLATEX.replace('\\addbibresource{references.bib}', '% \\addbibresource{zotero.bib}\n\\addbibresource{references.bib}'))]).loaded, false,
  'a commented-out line loads nothing');

const PACKAGE_ONLY = '\\documentclass{article}\n  \\usepackage[\n    style=alphabetic,\n  ]{biblatex}\n\\begin{document}\n\\end{document}\n';
eq(applied([src('main.tex', PACKAGE_ONLY)]).text, PACKAGE_ONLY.replace(']{biblatex}\n', ']{biblatex}\n  \\addbibresource{zotero.bib}\n'),
  'biblatex with no resource yet: after the \\usepackage, options over several lines, at its indent');

const NATBIB = '\\documentclass{article}\n\\usepackage{natbib}\n\\begin{document}\nHi \\citep{zot1}.\n\\bibliographystyle{plainnat}\n\\bibliography{references, more }\n\\end{document}\n';
eq(applied([src('main.tex', NATBIB)]), {
  file: 'main.tex', kind: 'bibliography', command: '\\bibliography{references,more,zotero}',
  text: NATBIB.replace('{references, more }', '{references, more,zotero }'),
}, 'BibTeX: one more name in the \\bibliography list');
eq(applied([src('main.tex', NATBIB.replace('{references, more }', '{}'))]).text, NATBIB.replace('{references, more }', '{zotero}'), 'an empty list takes the name alone');
eq(plan([src('main.tex', NATBIB.replace('more ', 'zotero'))]), { loaded: true }, 'a list that names it loads it');

const STYLE_ONLY = '\\documentclass{article}\n\\begin{document}\nHi \\cite{zot1}.\n\\bibliographystyle{plain}\n\\end{document}\n';
eq(applied([src('main.tex', STYLE_ONLY)]), {
  file: 'main.tex', kind: 'new-bibliography', command: '\\bibliography{zotero}',
  text: STYLE_ONLY.replace('\\end{document}', '\\bibliography{zotero}\n\\end{document}'),
}, 'BibTeX with a style and no database: \\bibliography before \\end{document}');
const BARE = '\\documentclass{article}\n\\begin{document}\nHi \\cite{zot1}.\n\\end{document}\n';
eq(plan([src('main.tex', BARE)]), { loaded: false, fix: null }, 'no bibliography set up: no edit is clearly right');
eq(plan([src('main.tex', STYLE_ONLY.replace('\\end{document}', '\\begin{thebibliography}{9}\\end{thebibliography}\n\\end{document}'))]).fix, null,
  'nor beside a hand-written thebibliography');

const PREAMBLE = '\\usepackage{biblatex}\n\\addbibresource{refs.bib} % ours\n';
const WITH_INPUT = '\\documentclass{article}\n\\input{preamble}\n\\begin{document}\n\\end{document}\n';
eq(applied([src('main.tex', WITH_INPUT), src('preamble.tex', PREAMBLE)]), {
  file: 'preamble.tex', kind: 'addbibresource', command: '\\addbibresource{zotero.bib}',
  text: '\\usepackage{biblatex}\n\\addbibresource{refs.bib} % ours\n\\addbibresource{zotero.bib}\n',
}, 'the line goes beside the \\addbibresource an \\input preamble holds');
eq(plan([src('main.tex', WITH_INPUT), src('preamble.tex', PREAMBLE, false)]), { loaded: false, fix: null }, 'never into a file that is not UTF-8');

const SUB = applied([src('paper/main.tex', BIBLATEX)], 'paper/main.tex', 'paper/zotero.bib');
eq([SUB.file, SUB.command], ['paper/main.tex', '\\addbibresource{zotero.bib}'], 'a root in a folder names the .bib from its own folder');
eq(plan([src('paper/main.tex', BIBLATEX.replace('references.bib', 'zotero.bib'))], 'paper/main.tex', 'zotero.bib').loaded, false,
  'and zotero.bib there is not the one at the project root');

// ---- the routes ----
const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const p = await store.createProject('Bib load');
const id = p.id;
const dir = store.branchDir(id, 'main');
const disk = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const call = (method, tail, payload) => app.inject({ method, url: `/api/projects/${id}${tail}`, ...(payload ? { payload } : {}) });

eq((await call('GET', '/zotero/bib-load?branch=main')).statusCode, 400, 'no link, nothing to load');
const link = await call('POST', '/zotero/link', { apiKey: 'k', libraryPrefix: 'users/7' });
eq(link.statusCode, 200, `the library links (${link.body.slice(0, 200)})`);

let state = (await call('GET', '/zotero/bib-load?branch=main')).json();
eq(state, {
  loaded: false, bibFile: 'zotero.bib', rootFile: 'main.tex',
  fix: { file: 'main.tex', kind: 'addbibresource', entry: 'zotero.bib', command: '\\addbibresource{zotero.bib}' },
  lines: { biblatex: '\\addbibresource{zotero.bib}', bibtex: '\\bibliography{zotero}' },
}, 'the default paper loads references.bib only');
eq((await call('GET', '/zotero/bib-load?branch=nope')).statusCode, 404, 'a branch that does not exist');

// closed file, CRLF: written on disk in its own line endings
const before = disk('main.tex');
fs.writeFileSync(path.join(dir, 'main.tex'), before.replace(/\n/g, '\r\n'));
let res = await call('POST', '/zotero/bib-load', { branch: 'main' });
eq(res.statusCode, 200, 'the line is added');
eq([res.json().added, res.json().loaded], [{ file: 'main.tex', kind: 'addbibresource', entry: 'zotero.bib', command: '\\addbibresource{zotero.bib}' }, true], 'and reported');
eq(disk('main.tex'), before.replace('\\addbibresource{references.bib}\n', '\\addbibresource{references.bib}\n\\addbibresource{zotero.bib}\n').replace(/\n/g, '\r\n'),
  'after the existing \\addbibresource, every line still CRLF');
res = await call('POST', '/zotero/bib-load', { branch: 'main' });
eq([res.json().added, res.json().loaded], [null, true], 'a second click adds nothing');
eq((disk('main.tex').match(/zotero\.bib/g) || []).length, 1, 'the line is there once');

// open doc: the edit goes through it and keeps what is being typed
fs.writeFileSync(path.join(dir, 'main.tex'), before);
const conn = await collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', 'main.tex'), {});
const ytext = conn.document.getText('content');
eq(ytext.toString(), before, 'the doc opened on the disk copy');
ytext.insert(ytext.toString().indexOf('Start writing'), 'Typed, not saved yet. ');
res = await call('POST', '/zotero/bib-load', { branch: 'main' });
eq(res.json().added?.file, 'main.tex', 'the open document gets the line');
const live = ytext.toString();
check(live.includes('\\addbibresource{references.bib}\n\\addbibresource{zotero.bib}\n'), 'in the live doc');
check(live.includes('Typed, not saved yet. Start writing'), 'beside the typing, which stays');
eq(disk('main.tex'), live, 'and on disk');

// a sync with unsaved typing in an open doc
ytext.insert(ytext.toString().indexOf('Start writing'), 'More typing. ');
version = 6;
res = await call('POST', '/zotero/sync', { branch: 'main' });
eq([res.statusCode, res.json().synced], [200, true], 'the library syncs');
check(ytext.toString().includes('More typing. Start writing'), 'typing not yet saved survives the sync');
ytext.insert(ytext.toString().indexOf('Start writing'), 'Still more. ');
res = await call('POST', '/references/add', { branch: 'main', query: '10.1234/looked.up' });
eq([res.statusCode, res.json().key], [200, 'doe2020'], 'a reference is looked up');
check(ytext.toString().includes('Still more. Start writing'), 'and the typing survives that too');

await conn.disconnect();
await app.close();
zoteroMock.close();
console.log('zotero-bib-load: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
