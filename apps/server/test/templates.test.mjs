/**
 * Template loader and venue catalog:
 *  - every byte of a template survives the loader (a logo is not UTF-8)
 *  - template.json and LICENSE are gallery bookkeeping, not seed files
 *  - venue entries carry a category, a license and a class, from the compiler
 *  - a sample document wins over the generated skeleton, unless it needs files
 *    we do not ship
 *  - the generated skeleton puts the title block where the class wants it
 *  - a compiler with no catalog leaves the folder templates alone
 *  - creating a project from a venue id works like a folder template
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-templates-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

// Every byte value, including NUL and everything above 0x7F: UTF-8 decoding
// replaces the invalid sequences here with U+FFFD and the file is destroyed.
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

const tplDir = process.env.TEMPLATES_DIR;
fs.mkdirSync(path.join(tplDir, 'demo', 'figs'), { recursive: true });
fs.writeFileSync(path.join(tplDir, 'demo', 'template.json'), JSON.stringify({
  id: 'demo', name: 'Demo', description: 'A demo template.', order: 1,
  license: 'MIT', licenseUrl: 'https://opensource.org/license/mit',
  source: { url: 'https://example.org/demo', version: '1.0' },
}));
fs.writeFileSync(path.join(tplDir, 'demo', 'main.tex'), '\\documentclass{article}\n\\begin{document}Hi\\end{document}\n');
fs.writeFileSync(path.join(tplDir, 'demo', 'LICENSE'), 'MIT License\n');
fs.writeFileSync(path.join(tplDir, 'demo', 'logo.png'), BINARY);
fs.writeFileSync(path.join(tplDir, 'demo', 'figs', 'plot.pdf'), BINARY);
fs.mkdirSync(path.join(tplDir, 'slides'), { recursive: true });
fs.writeFileSync(path.join(tplDir, 'slides', 'template.json'), JSON.stringify({ name: 'Slides', category: 'Slides', order: 2 }));
fs.writeFileSync(path.join(tplDir, 'slides', 'main.tex'), '\\documentclass{beamer}\n');

const { listTemplates, listAllTemplates, templateFiles } = await import('../src/templates.ts');
const catalog = await import('../src/catalog.ts');

// ---- binary safety ----
const files = templateFiles('demo');
check(Buffer.isBuffer(files['logo.png']), 'template files are Buffers, not decoded strings');
check(files['logo.png'].equals(BINARY), 'a binary file survives the loader byte for byte');
check(files['figs/plot.pdf'].equals(BINARY), 'a binary file in a subdirectory survives too');
eq(Object.keys(files).sort(), ['figs/plot.pdf', 'logo.png', 'main.tex'], 'template.json and LICENSE are not seeded into projects');

await throws(async () => templateFiles('../secrets'), 'bad template id', 'a traversing id is refused');
await throws(async () => templateFiles('demo/figs'), 'bad template id', 'a nested id is refused');
await throws(async () => templateFiles('nope'), 'unknown template', 'an unknown template is refused');

// ---- folder metadata ----
const folders = listTemplates();
// 'blank' is a built-in tile, not a folder, and leads the grid (#8).
eq(folders.map((t) => t.id), ['blank', 'demo', 'slides'], 'the blank tile leads the folder templates');
const demo = folders.find((t) => t.id === 'demo');
eq(demo.category, 'General', 'a template.json without a category lands in General');
eq(demo.license, 'MIT', 'the license reaches the gallery');
eq(folders.find((t) => t.id === 'slides').category, 'Slides', 'a declared category is kept');

// ---- venue catalog ----
const CATALOG = {
  ok: true,
  classes: [
    { id: 'elsarticle', cls: 'elsarticle', kind: 'class', pkg: 'elsarticle', license: 'lppl1.3c', version: '3.4', source: 'https://ctan.org/pkg/elsarticle', sample: null },
    { id: 'amsart', cls: 'amsart', kind: 'class', pkg: 'amscls', license: 'lppl1.3c', sample: { file: 'sample.tex', content: '% the class ships this\n\\documentclass{amsart}\n' } },
    { id: 'neurips', cls: 'neurips_2024', kind: 'style', pkg: 'neurips', license: null, sample: null },
    { id: 'not-a-venue', cls: 'whatever', kind: 'class', sample: null },
  ],
};
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; return { ok: true, json: async () => CATALOG }; };
catalog.resetVenueCache();

const venues = await catalog.venueTemplates();
eq(venues.map((t) => t.id).sort(), ['venue:amsart', 'venue:elsarticle', 'venue:neurips'], 'only allowlisted venues become templates');
const els = venues.find((t) => t.id === 'venue:elsarticle');
eq(els.category, 'Journals', 'elsarticle is a journal');
eq(els.license, 'LPPL 1.3c', 'the TeX Live license id is shown the way people write it');
eq(els.licenseUrl, 'https://www.latex-project.org/lppl/lppl-1-3c.txt', 'the license links to its text');
eq(els.documentClass, 'elsarticle', 'the tile knows which class it starts from');
eq(venues.find((t) => t.id === 'venue:neurips').category, 'Conferences', 'NeurIPS is a conference');

await catalog.venueTemplates();
eq(fetchCalls, 1, 'the catalog is fetched once and cached');

// A TTL rollover must not drop the venue half of the gallery: the refetch runs
// past the wait, and the listing answers with the last catalog the compiler
// gave rather than an empty list.
const realNow = Date.now;
globalThis.fetch = () => new Promise(() => {});
Date.now = () => realNow() + 11 * 60_000;
const stale = await catalog.venueTemplates(catalog.CATALOG_WAIT_MS);
Date.now = realNow;
eq(stale.map((t) => t.id).sort(), ['venue:amsart', 'venue:elsarticle', 'venue:neurips'], 'an expired cache still answers while the refetch is in flight');

// A fetch that resetVenueCache() abandoned settles later; it must not write its
// failure over the cache a caller has filled since.
catalog.resetVenueCache();
let failOrphan;
globalThis.fetch = () => new Promise((_, reject) => { failOrphan = reject; });
const orphan = catalog.venueTemplates();
catalog.resetVenueCache();
fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; return { ok: true, json: async () => CATALOG }; };
eq((await catalog.venueTemplates()).length, 3, 'the reset re-asks the compiler');
failOrphan(new Error('abandoned'));
await orphan;
eq((await catalog.venueTemplates()).map((t) => t.id).sort(), ['venue:amsart', 'venue:elsarticle', 'venue:neurips'], 'an abandoned fetch does not clobber the cache that replaced it');
eq(fetchCalls, 1, 'nor does it drop the in-flight dedup');

const all = await listAllTemplates();
eq(all.filter((t) => !t.id.startsWith('venue:')).map((t) => t.id), ['blank', 'demo', 'slides'], 'folder templates stay first');
check(all.length === 6, 'the gallery is the blank tile, the folder templates and the venues');

// ---- seed files per venue ----
const skeleton = await catalog.venueTemplateFiles('venue:elsarticle');
check(Buffer.isBuffer(skeleton['main.tex']), 'venue seeds are Buffers too');
const tex = skeleton['main.tex'].toString('utf8');
check(tex.includes('\\documentclass[preprint,review,12pt]{elsarticle}'), 'the skeleton names the class');
check(tex.includes('\\begin{frontmatter}'), 'elsarticle gets its frontmatter block');
check(tex.includes('\\bibliographystyle{elsarticle-num}'), 'the skeleton uses the class\u2019s usual bib style');
check(tex.includes('\\begin{abstract}') && tex.includes('\\section{Introduction}'), 'the skeleton has an abstract and a section');
check(skeleton['references.bib'].toString('utf8').includes('@article'), 'a bibliography file comes with it');

const sampled = await catalog.venueTemplateFiles('venue:amsart');
eq(sampled['main.tex'].toString('utf8'), '% the class ships this\n\\documentclass{amsart}\n', 'the class\u2019s own sample wins over the skeleton');

const styled = (await catalog.venueTemplateFiles('venue:neurips'))['main.tex'].toString('utf8');
check(styled.includes('\\documentclass{article}') && styled.includes('\\usepackage{neurips_2024}'), 'a style-file venue loads the style on top of article');

await throws(async () => catalog.venueTemplateFiles('venue:nope'), 'unknown template', 'an unknown venue is refused');

// ---- samples that need files we do not ship, and hostile keys ----
const doc = (body) => `\\begin{document}\n${body}\n\\end{document}\n`;
const SAMPLES = {
  ok: true,
  classes: [
    { id: 'llncs', cls: 'llncs', kind: 'class', sample: { file: 's.tex', content: doc('\\input{samplebody-conf}') } },
    { id: 'mnras', cls: 'mnras', kind: 'class', sample: { file: 's.tex', content: doc('\\bibliography{example}') } },
    { id: 'jfm', cls: 'jfm', kind: 'class', sample: { file: 's.tex', content: doc('% \\includegraphics{teaser}\n\\bibliography{references}') } },
    { id: 'revtex', cls: 'revtex4-2', kind: 'class' },
    { id: 'amsart', cls: 'amsart', kind: 'class' },
    // Keys that resolve through Object.prototype on a bare index read.
    { id: 'constructor', cls: 'Object', kind: 'class', license: 'toString' },
  ],
};
globalThis.fetch = async () => ({ ok: true, json: async () => SAMPLES });
catalog.resetVenueCache();

const generated = (id) => catalog.venueTemplateFiles(`venue:${id}`).then((f) => f['main.tex'].toString('utf8'));
check((await generated('llncs')).includes('generated by Aldine'), 'a sample that \\inputs a sibling falls back to the skeleton');
check((await generated('mnras')).includes('\\bibliography{references}'), 'a sample naming another .bib falls back to the skeleton');
check((await generated('jfm')).includes('% \\includegraphics{teaser}'), 'a commented-out \\includegraphics does not disqualify a sample');

// The title block shape is fatal, not cosmetic: REVTeX has no \author in the
// preamble, and the AMS classes want the abstract before \maketitle.
const revtex = await generated('revtex');
check(revtex.indexOf('\\begin{document}') < revtex.indexOf('\\author{'), 'the REVTeX title block sits inside the document');
check(revtex.indexOf('\\begin{abstract}') < revtex.indexOf('\\maketitle'), 'REVTeX gets its abstract before \\maketitle');
const amsart = await generated('amsart');
check(amsart.indexOf('\\title{') < amsart.indexOf('\\begin{document}'), 'the AMS title block stays in the preamble');
check(amsart.indexOf('\\begin{abstract}') < amsart.indexOf('\\maketitle'), 'the AMS abstract comes before \\maketitle');

const hostile = await catalog.venueTemplates();
check(!hostile.some((t) => t.id === 'venue:constructor'), 'an id that names an Object.prototype key is not a template');
await throws(async () => catalog.venueTemplateFiles('venue:constructor'), 'unknown template', 'nor can a project be created from one');

// The compiler filters the same samples out at the source, so the two sides
// cannot drift into shipping a sample nobody accepts (or nobody rejects).
const { selfContained } = createRequire(import.meta.url)('../../compiler/catalog.js');
check(!selfContained(doc('\\input{samplebody-conf}')), 'the compiler rejects a sample that \\inputs a sibling');
check(!selfContained(doc('\\includegraphics{teaser.pdf}')), 'the compiler rejects a sample that needs a figure');
check(!selfContained(doc('\\addbibresource{sample-base.bib}')), 'the compiler rejects a sample naming another .bib');
check(selfContained(doc('% \\includegraphics{teaser}\n\\bibliography{references}')), 'the compiler keeps a self-contained sample');

// ---- a compiler that is reachable but silent ----
globalThis.fetch = () => new Promise((_, reject) => {
  const t = setTimeout(() => reject(new Error('silent compiler')), 30_000);
  t.unref?.();
});
catalog.resetVenueCache();
const startedAt = Date.now();
const withoutCatalog = await listAllTemplates();
check(Date.now() - startedAt < 4_000, 'a silent compiler does not hold the template listing open');
eq(withoutCatalog.map((t) => t.id), ['blank', 'demo', 'slides'], 'the folder templates answer while the catalog is still in flight');

// ---- a compiler without a catalog ----
globalThis.fetch = async () => { throw new Error('connection refused'); };
catalog.resetVenueCache();
eq(await catalog.venueTemplates(), [], 'no catalog is an empty list, not an error');
eq((await listAllTemplates()).map((t) => t.id), ['blank', 'demo', 'slides'], 'the folder templates carry the gallery on their own');

// ---- creating a project from either kind ----
globalThis.fetch = async () => ({ ok: true, json: async () => CATALOG });
catalog.resetVenueCache();

const { default: Fastify } = await import('fastify');
const { initDb, closeDb } = await import('../src/db/index.ts');
const { registerRoutes } = await import('../src/routes.ts');
await initDb();
const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const create = async (template) => {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: template, template } });
  check(res.statusCode === 200, `creating from ${template} answers 200, got ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id;
};
const projectFile = (id, rel) => fs.readFileSync(path.join(process.env.DATA_DIR, 'projects', id, rel));

const fromFolder = await create('demo');
check(projectFile(fromFolder, 'logo.png').equals(BINARY), 'the logo reaches the new project unmangled');
check(!fs.existsSync(path.join(process.env.DATA_DIR, 'projects', fromFolder, 'LICENSE')), 'the template LICENSE is not copied into the paper');

const fromVenue = await create('venue:elsarticle');
check(projectFile(fromVenue, 'main.tex').toString('utf8').includes('{elsarticle}'), 'a venue project starts from that class');

const bad = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x', template: 'venue:nope' } });
eq(bad.statusCode, 400, 'an unknown venue id is a 400, not a crash');

const listed = JSON.parse((await app.inject({ method: 'GET', url: '/api/templates' })).body);
check(listed.some((t) => t.id === 'venue:elsarticle' && t.category === 'Journals'), 'GET /api/templates merges the catalog in');

await app.close();
await closeDb();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('templates: all checks passed');
