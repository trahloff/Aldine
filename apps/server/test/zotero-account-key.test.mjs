/**
 * The Zotero key is the account's (cite-8), the export follows the paper's
 * bibliography (BibTeX or biblatex fields), a sync on open skips a fresh
 * library, and Add & cite writes to the .bib the paper reads (cite-9).
 *  - PUT/GET/DELETE /api/zotero/key: saved per account, never sent back
 *  - collections and link run on the saved key; collection paths
 *  - format=bibtex for a natbib paper, a full re-export when it changes
 *  - olderThan: a fresh link is not synced again
 *  - references/add: the loaded .bib, not the Zotero one; dedupe across files
 *
 * Real routes on a throwaway datastore, auth off (the one implicit user), a
 * mock Zotero API and DOI resolver; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-zotero-key-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'REMOTE_PROVIDERS']) delete process.env[k];

const KEY = 'secret-zotero-key-123';
const formats = [];
const zoteroMock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.pathname.startsWith('/10.')) {
    res.writeHead(200, { 'content-type': 'application/x-bibtex' });
    const doi = decodeURIComponent(url.pathname.slice(1));
    const who = doi.split('/').pop();
    return res.end(`@article{${who}2020, title={Looked Up}, author={${who[0].toUpperCase()}${who.slice(1)}, Jane}, year={2020}, doi={${doi}}}`);
  }
  if (req.headers['zotero-api-key'] !== KEY) return json({ error: 'bad key' }, 403);
  if (url.pathname === '/keys/current') return json({ userID: 7, username: 'ada' });
  if (url.pathname === '/users/7/groups') return json([]);
  if (url.pathname === '/users/7/collections') {
    return json([
      { key: 'A', data: { name: 'Thesis', parentCollection: false } },
      { key: 'B', data: { name: 'Drafts', parentCollection: 'A' } },
      { key: 'C', data: { name: 'Drafts', parentCollection: false } },
    ]);
  }
  if (url.pathname.endsWith('/items/top')) {
    const format = url.searchParams.get('format');
    if (url.searchParams.get('limit') !== '1') formats.push(format);
    if (req.headers['if-modified-since-version'] && Number(req.headers['if-modified-since-version']) >= 9) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain', 'Last-Modified-Version': '9', 'Total-Results': '1' });
    return res.end(format === 'bibtex'
      ? '@article{zot1, title={From Zotero}, journal={Mind}, year={2001}}\n'
      : '@article{zot1, title={From Zotero}, journaltitle={Mind}, date={2001}}\n');
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => zoteroMock.listen(0, '127.0.0.1', r));
process.env.ZOTERO_API_BASE = `http://127.0.0.1:${zoteroMock.address().port}`;
process.env.DOI_API_BASE = process.env.ZOTERO_API_BASE;

const { collectionPath } = await import('../src/zotero.ts');
const { bibFormatOf, loadedBibFiles } = await import('../src/bibload.ts');

// ---- pure parts ----
const cols = [{ key: 'A', name: 'Thesis', parent: false }, { key: 'B', name: 'Drafts', parent: 'A' }, { key: 'L', name: 'Loop', parent: 'L' }];
eq(collectionPath(cols, 'B'), 'Thesis / Drafts', 'a subcollection under its parent');
eq(collectionPath(cols, 'L'), 'Loop', 'a parent loop ends the path');
eq(collectionPath(cols, 'zz'), undefined, 'an unknown key has none');
const src = (p, text) => ({ path: p, text, editable: true });
eq(bibFormatOf([src('main.tex', '\\usepackage{natbib}\n\\bibliographystyle{plainnat}\n\\bibliography{refs}')]), 'bibtex', 'natbib with \\bibliography is BibTeX');
eq(bibFormatOf([src('main.tex', '\\usepackage[style=apa]{biblatex}\n\\addbibresource{refs.bib}')]), 'biblatex', 'biblatex');
eq(bibFormatOf([src('main.tex', '% \\bibliography{refs}\n\\begin{document}')]), 'biblatex', 'a commented line counts for nothing; neither means biblatex');
eq(loadedBibFiles([src('paper/main.tex', '\\bibliography{refs,../shared/x,sub/more}'), src('paper/sub/a.tex', '\\addbibresource{local.bib}')], 'paper/main.tex', new Set(['paper/sub/local.bib'])),
  ['paper/refs.bib', 'shared/x.bib', 'paper/sub/more.bib', 'paper/sub/local.bib'], 'names resolve from the root, or from the naming file where only that exists');

// ---- the routes ----
const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();
const send = (method, url, payload) => app.inject({ method, url, ...(payload ? { payload } : {}) });

eq((await send('GET', '/api/zotero/key')).json(), { saved: false }, 'no key saved yet');
eq((await send('PUT', '/api/zotero/key', { apiKey: 'wrong' })).statusCode, 400, 'a key Zotero refuses is not saved');
eq((await send('GET', '/api/zotero/key')).json(), { saved: false }, 'still none');
let res = await send('PUT', '/api/zotero/key', { apiKey: KEY });
eq([res.statusCode, res.json().username, res.json().groups], [200, 'ada', []], 'the key is checked and saved');
check(!res.body.includes(KEY), 'the answer does not carry the key');
res = await send('GET', '/api/zotero/key');
eq(res.json(), { saved: true, userID: 7, username: 'ada' }, 'it is reported as saved');
check(!res.body.includes(KEY), 'and never sent back');

res = await send('POST', '/api/zotero/collections', { libraryPrefix: 'users/7' });
eq(res.json().map((c) => c.path), ['Thesis', 'Thesis / Drafts', 'Drafts'], 'collections on the saved key, each with its path');

// a natbib paper: BibTeX fields
const p = await store.createProject('Key paper');
const dir = store.branchDir(p.id, 'main');
const disk = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const NATBIB = '\\documentclass{article}\n\\usepackage{natbib}\n\\begin{document}\nHi.\n\\bibliographystyle{plainnat}\n\\bibliography{refs,zotero}\n\\end{document}\n';
fs.writeFileSync(path.join(dir, 'main.tex'), NATBIB);
fs.writeFileSync(path.join(dir, 'refs.bib'), '@article{old, title={Older}, doi={10.1234/dup}}\n');
res = await send('POST', `/api/projects/${p.id}/zotero/link`, { libraryPrefix: 'users/7', collectionKey: 'B' });
eq([res.statusCode, res.json().format], [200, 'bibtex'], `linked on the saved key, exported as BibTeX (${res.body.slice(0, 160)})`);
check(disk('zotero.bib').includes('journal={Mind}') && !disk('zotero.bib').includes('journaltitle'), 'the .bib has the fields BibTeX styles read');
let meta = (await send('GET', `/api/projects/${p.id}`)).json();
eq(meta.zotero.collectionName, 'Thesis / Drafts', 'the link names the collection with its path');
check(!JSON.stringify(meta).includes(KEY), 'the project does not show the key either');

// a sync on open: fresh, so skipped; a paper that moved to biblatex is exported again in full
formats.length = 0;
res = await send('POST', `/api/projects/${p.id}/zotero/sync`, { branch: 'main', olderThan: 3600 });
eq([res.json().synced, res.json().fresh], [false, true], 'a library synced a moment ago is not synced on open');
eq(formats, [], 'Zotero was not asked');
fs.writeFileSync(path.join(dir, 'main.tex'), NATBIB.replace('\\usepackage{natbib}', '\\usepackage{biblatex}\n\\addbibresource{zotero.bib}').replace('\\bibliographystyle{plainnat}\n\\bibliography{refs,zotero}\n', ''));
eq((await send('GET', `/api/projects/${p.id}/zotero/bib-load?branch=main`)).json().format, 'biblatex', 'the panel learns the paper now reads biblatex');
res = await send('POST', `/api/projects/${p.id}/zotero/sync`, { branch: 'main', olderThan: 3600 });
eq([res.json().synced, res.json().format], [true, 'biblatex'], 'a new bibliography setup is exported again, though fresh');
check(disk('zotero.bib').includes('journaltitle={Mind}'), 'with biblatex fields');
res = await send('POST', `/api/projects/${p.id}/zotero/sync`, { branch: 'main' });
eq(res.json().unchanged, true, 'after that, the cursor works again');

// a stale link syncs on open
meta = await store.readMeta(p.id);
await store.writeMeta({ ...meta, zotero: { ...meta.zotero, lastSyncedAt: new Date(Date.now() - 2 * 3600_000).toISOString() } });
res = await send('POST', `/api/projects/${p.id}/zotero/sync`, { branch: 'main', olderThan: 3600 });
eq([res.json().fresh, res.json().unchanged], [undefined, true], 'an hour-old link asks Zotero');
eq((await send('POST', `/api/projects/${p.id}/zotero/sync`, { branch: 'main', olderThan: 3600 })).json().fresh, true, 'and counts as fresh after asking');

// Add & cite: the .bib the paper reads, never the Zotero file; one paper once
fs.writeFileSync(path.join(dir, 'main.tex'), NATBIB);
res = await send('POST', `/api/projects/${p.id}/references/add`, { branch: 'main', query: '10.1234/new' });
eq([res.statusCode, res.json().bibFile, res.json().duplicate, res.json().loaded], [200, 'refs.bib', false, true], 'the entry goes to the .bib \\bibliography names first');
check(disk('refs.bib').includes(res.json().key) && !disk('zotero.bib').includes(res.json().key), 'and not into zotero.bib');
check(!disk('references.bib').includes(res.json().key), 'nor into the references.bib the paper does not read');
fs.writeFileSync(path.join(dir, 'main.tex'), NATBIB.replace('{refs,zotero}', '{zotero,refs}'));
fs.writeFileSync(path.join(dir, 'zotero.bib'), disk('zotero.bib') + '@article{zotdup, title={In Zotero}, doi={10.1234/inzotero}}\n');
res = await send('POST', `/api/projects/${p.id}/references/add`, { branch: 'main', query: '10.1234/inzotero' });
eq([res.json().key, res.json().bibFile, res.json().duplicate], ['zotdup', 'zotero.bib', true], 'a paper already in the Zotero file is cited from there');
res = await send('POST', `/api/projects/${p.id}/references/add`, { branch: 'main', query: '10.1234/dup' });
eq([res.json().key, res.json().bibFile, res.json().duplicate], ['old', 'refs.bib', true], 'one already in refs.bib under an older key keeps that key');
fs.writeFileSync(path.join(dir, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n');
res = await send('POST', `/api/projects/${p.id}/references/add`, { branch: 'main', query: '10.1234/third' });
eq([res.json().bibFile, res.json().loaded, res.json().loadLine], ['references.bib', false, '\\addbibresource{references.bib}'], 'a paper that loads no .bib: references.bib, and the line it needs');

eq((await send('DELETE', '/api/zotero/key')).statusCode, 200, 'the key is forgotten');
eq((await send('GET', '/api/zotero/key')).json(), { saved: false }, 'nothing saved any more');
const q = await store.createProject('No key');
eq((await send('POST', `/api/projects/${q.id}/zotero/link`, { libraryPrefix: 'users/7' })).statusCode, 400, 'without a saved key a new link needs one pasted');
res = await send('POST', '/api/zotero/collections', { libraryPrefix: 'users/7', projectId: p.id });
eq(res.statusCode, 200, 'the owner of a linked project lists its collections on the key its link holds');

await app.close();
zoteroMock.close();
console.log('zotero-account-key: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
