/**
 * Reference lookup → BibTeX the default engine can typeset. doi.org hands
 * back Crossref's blob as is: a 🦜 in a title broke pdflatex at
 * \printbibliography with an error pointing at main.tex, `month = June` is
 * an undefined macro to biber, and its key style differed from the
 * synthesized arXiv/OpenAlex entries. A 404 is the resolver's "not
 * registered", not an outage.
 */
import http from 'node:http';
import { check, eq } from './assert.mjs';

const CROSSREF = '@article{Bender_2021, title={On the Dangers of Stochastic Parrots 🦜: Can Language Models Be Too Big? α ≤ β}, volume={1}, ISSN={1234-5678}, url={http://dx.doi.org/10.1145/3442188.3445922}, DOI={10.1145/3442188.3445922}, journal={Proceedings of FAccT &amp; more}, publisher={ACM}, author={Bender, Emily M. and Gebru, Timnit}, year={2021}, month=June, pages={610–623} }';
const upstream = http.createServer((req, res) => {
  const send = (code, body, type = 'application/x-bibtex') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  if (req.url === `/${encodeURIComponent('10.1145/3442188.3445922')}`) return send(200, CROSSREF);
  if (req.url === `/${encodeURIComponent('10.1145/outage.1')}`) return send(503, 'upstream down', 'text/plain');
  if (req.url.startsWith('/api/query?id_list=1706.03762')) {
    return send(200, '<?xml version="1.0"?>\n<feed><title>arXiv Query</title><entry><title>Attention Is All\n  You Need</title><published>2017-06-12T00:00:00Z</published><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author></entry></feed>', 'application/atom+xml');
  }
  if (req.url.startsWith('/api/query?id_list=2001.00001')) {
    return send(200, '<?xml version="1.0"?>\n<feed><title>arXiv Query</title><entry><title>Estimating α-stable distributions &amp; more</title><published>2020-01-01T00:00:00Z</published><author><name>Ana Lévy</name></author></entry></feed>', 'application/atom+xml');
  }
  if (req.url.startsWith('/api/query?id_list=2101.00001')) {
    return send(200, '<?xml version="1.0"?>\n<feed><title>arXiv Query</title><entry><title>Measurement of $\\alpha$-stable $t\\bar{t}$ production at $x_1$ &amp; beyond</title><published>2021-01-01T00:00:00Z</published><author><name>Chen Wu</name></author></entry></feed>', 'application/atom+xml');
  }
  if (req.url.startsWith('/api/query?')) return send(200, '<?xml version="1.0"?>\n<feed><title>arXiv Query</title></feed>', 'application/atom+xml');
  if (req.url.startsWith('/works/W333')) return send(200, JSON.stringify({ id: 'https://openalex.org/W333', doi: null, title: 'Bounds with x ≤ y', publication_year: 2018, authorships: [{ author: { display_name: 'Bob Jones' } }] }), 'application/json');
  if (req.url.startsWith('/works/W444')) return send(200, JSON.stringify({ id: 'https://openalex.org/W444', doi: null, title: 'The $\\Lambda$CDM model costs $5', publication_year: 2020, authorships: [{ author: { display_name: 'Dana Kim' } }] }), 'application/json');
  if (req.url.startsWith('/works/W222')) return send(200, JSON.stringify({ id: 'https://openalex.org/W222', doi: null, title: 'A DOI-less Paper', publication_year: 2019, authorships: [{ author: { display_name: 'Alice Smith' } }], primary_location: { source: { display_name: 'Mock Proc.' } } }), 'application/json');
  send(404, 'not found', 'text/plain');
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;
process.env.DOI_API_BASE = base;
process.env.ARXIV_API_BASE = base;
process.env.OPENALEX_API_BASE = base;

const { fetchBibEntry } = await import('../src/references.ts');

// ---- a doi.org entry: pdflatex-safe, biber-safe month, one key rule and layout ----
const doi = await fetchBibEntry('10.1145/3442188.3445922');
check(doi !== null, 'the known DOI resolves');
check(!/[\u{10000}-\u{10FFFF}]/u.test(doi), `no astral-plane character survives (got ${JSON.stringify(doi)})`);
check(doi.includes('Stochastic Parrots: Can Language'), 'the emoji is dropped without leaving a stray space before the colon');
check(doi.includes('$\\alpha$ $\\leq$ $\\beta$'), `Greek letters and relation symbols become their macros (got ${JSON.stringify(doi)})`);
check(doi.includes('FAccT \\& more'), 'the &amp; is decoded and escaped');
check(/^  month\s+= jun,$/m.test(doi), `month = June becomes the biber macro jun (got ${JSON.stringify(doi.match(/month.*$/m)?.[0])})`);
check(doi.startsWith('@article{bender2021,\n'), `the key follows the one rule surname+year (got ${JSON.stringify(doi.split('\n')[0])})`);
const lines = doi.split('\n');
eq(lines.slice(1, 4).map((l) => l.split('=')[0].trim()), ['title', 'author', 'year'], 'title, author, year lead');
check(lines.slice(1, -1).every((l) => /^  [a-z]+ += /.test(l) && l.endsWith(',')) && lines.at(-1) === '}', `one field per line, lowercase names, aligned (got ${JSON.stringify(lines)})`);
check(new Set(lines.slice(1, -1).map((l) => l.indexOf('='))).size === 1, 'the = signs are aligned');
for (const f of ['volume', 'issn', 'url', 'doi', 'journal', 'publisher', 'pages']) check(new RegExp(`^  ${f} += \\{`, 'm').test(doi), `Crossref's ${f} field is kept`);
check(doi.includes('{610–623}'), 'the en dash inputenc knows stays');

// ---- a synthesized arXiv entry shares the layout and key rule ----
const arxiv = await fetchBibEntry('arXiv:1706.03762');
check(arxiv.startsWith('@article{vaswani2017,\n'), `arXiv key: surname+year (got ${JSON.stringify(arxiv.split('\n')[0])})`);
check(/^  title\s+= \{Attention Is All You Need\},$/m.test(arxiv) && /^  author\s+= \{Vaswani, Ashish and Shazeer, Noam\},$/m.test(arxiv), `arXiv fields are laid out like the doi.org ones (got ${JSON.stringify(arxiv)})`);
check(/^  archiveprefix += \{arXiv\},$/m.test(arxiv) && /^  eprint += \{1706\.03762\},$/m.test(arxiv), 'eprint and archiveprefix are kept');

// ---- synthesized entries: the macros a symbol becomes keep their $ (an escaped \$\alpha\$ is "Missing $ inserted" at the bibliography) ----
const greek = await fetchBibEntry('arXiv:2001.00001');
check(/^  title\s+= \{Estimating \$\\alpha\$-stable distributions \\& more\},$/m.test(greek), `an arXiv title keeps $\\alpha$ unescaped and escapes the & (got ${JSON.stringify(greek)})`);
check(!greek.includes('\\$'), 'no dollar sign is escaped in the arXiv entry');
const rel = await fetchBibEntry('openalex:W333');
check(/^  title\s+= \{Bounds with x \$\\leq\$ y\},$/m.test(rel), `an OpenAlex title keeps $\\leq$ unescaped (got ${JSON.stringify(rel)})`);
// the TeX math arXiv titles are typed with stays as typed, an odd stray $ is still escaped
const math = await fetchBibEntry('arXiv:2101.00001');
check(/^  title\s+= \{Measurement of \$\\alpha\$-stable \$t\\bar\{t\}\$ production at \$x_1\$ \\& beyond\},$/m.test(math), `an arXiv title's $…$ math keeps its macros and subscripts while the & is escaped (got ${JSON.stringify(math)})`);
check(!math.includes('\\$'), 'no dollar sign is escaped in a title typed with TeX math');
const stray = await fetchBibEntry('openalex:W444');
check(/^  title\s+= \{The \\\$\\Lambda\\\$CDM model costs \\\$5\},$/m.test(stray), `an odd count of $ is a stray, every one escaped (got ${JSON.stringify(stray)})`);

// ---- OpenAlex without a DOI: synthesized, same rule ----
const oa = await fetchBibEntry('openalex:W222');
check(oa.startsWith('@article{smith2019,\n') && /^  journaltitle += \{Mock Proc\.\},$/m.test(oa), `OpenAlex synthesis keeps key rule and layout (got ${JSON.stringify(oa)})`);

// ---- unknown ids are "not found", outages throw with their status ----
eq(await fetchBibEntry('10.9999/does-not-exist'), null, 'a DOI doi.org does not know resolves to nothing');
eq(await fetchBibEntry('openalex:W9999999999999'), null, 'an unknown OpenAlex id resolves to nothing');
eq(await fetchBibEntry('arXiv:9912.99999'), null, 'an unknown arXiv id resolves to nothing');
let thrown = null;
try { await fetchBibEntry('10.1145/outage.1'); } catch (err) { thrown = err; }
check(thrown instanceof Error && /DOI lookup failed \(HTTP 503\)/.test(thrown.message), `a 5xx is an upstream failure with its status (got ${thrown && thrown.message})`);

upstream.close();
console.log('references tests passed');
