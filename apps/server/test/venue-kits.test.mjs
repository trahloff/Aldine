/**
 * Venue kits fetched from a publisher, against a local HTTP server. No test
 * here reaches the network, and no publisher file is stored in the repo: every
 * fixture archive is built in-test.
 *
 * What is asserted:
 *  - a good kit is unpacked, filtered to the files the registry names, and the
 *    kit's own document becomes main.tex
 *  - archive junk, absolute names and `..` escapes never reach a project
 *  - 404, timeout, oversize (declared and streamed), a non-zip content type, a
 *    corrupt archive and a kit missing a named file all fall back to the
 *    skeleton plus README-venue.md instead of failing project creation
 *  - a redirect off the entry's host is refused; a same-host one is followed
 *  - a fresh cache serves without a request; a stale one still serves when the
 *    fetch fails
 *  - a registry entry that is not https, or points off its own host, is dropped
 *  - publisher text in a failure message cannot break out of the LaTeX comment
 *    it is written into, and the fallback skeleton compiles without the kit
 *  - a kit past the project seed limits, or one naming a path that is both a
 *    file and a directory, is a skeleton rather than a failed creation
 *  - a cache written for a different kit URL or take list is a miss
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { buildZip } from './zip.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-venue-kits-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'secrets');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.VENUES_FILE = path.join(tmp, 'venues.json');
// The fixture server cannot present a certificate; this is the same test-only
// gate routes.ts uses for its disown hook.
process.env.ALDINE_TEST_HOOKS = '1';
process.env.VENUE_KIT_TIMEOUT_MS = '1500';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

// ---- fixture archives ----

const STY = '\\ProvidesPackage{venue}\n';
const TEX = '\\documentclass{article}\n\\usepackage{venue}\n\\begin{document}\nHello\n\\end{document}\n';
const BIB = '@article{knuth1984,author={Knuth, Donald E.},title={Literate Programming},year={1984}}\n';
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);

const GOOD_ZIP = buildZip({
  'kit-1.0/': '',
  'kit-1.0/venue.sty': STY,
  'kit-1.0/sample.tex': TEX,
  'kit-1.0/sample.bib': BIB,
  'kit-1.0/figs/plot.pdf': PDF,
  'kit-1.0/manual.pdf': PDF,           // not in `take`
  'kit-1.0/.DS_Store': 'junk',
  '__MACOSX/kit-1.0/._venue.sty': 'junk',
  '../evil.sty': 'escape',
  '/etc/passwd': 'absolute',
});
const NESTED_ZIP = buildZip({
  'pack/main.cls': '\\ProvidesClass{pack}\n',
  'pack/doc.tex': TEX,
  'pack/bst/first.bst': 'first',
  'pack/bst/second.bst': 'second',
});
const NO_FILES_ZIP = buildZip({ 'kit-1.0/readme.txt': 'nothing useful here' });
const BIG = Buffer.alloc(1024 * 1024);
// A second archive for the same venue id, so a registry that changes its kit
// URL can be told apart from the cache written for the old one.
const OK2_ZIP = buildZip({
  'kit-2.0/venue.sty': '\\ProvidesPackage{venue}[2027]\n',
  'kit-2.0/sample.tex': TEX,
  'kit-2.0/sample.bib': BIB,
});
// The entry name reaches the reader's error message verbatim, and that message
// is written into main.tex as a comment: a newline in it would end the comment
// and run the rest as LaTeX. bzip2 is a method the reader refuses by name.
const INJECT_NAME = 'a.sty\n\\immediate\\write18{id > /tmp/pwned}\n\\input{/etc/passwd}\n%';
const INJECT_ZIP = buildZip({ [INJECT_NAME]: { data: STY, method: 12 } });
// `x.sty` is both a file and a directory: createProject writes the seed into a
// fresh repo, so this is an EEXIST halfway through, not a bad tile.
const COLLIDE_ZIP = buildZip({ 'x.sty': STY, 'x.sty/y.sty': STY });
// Past the 1000-file seed limit every other path into createProject respects.
const MANY_ZIP = buildZip(Object.fromEntries([
  ['venue.sty', STY],
  ...Array.from({ length: 1200 }, (_, i) => [`f${i}.tex`, 'x']),
]));

// ---- fixture server ----

const hits = {};
let flakyFails = false;

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  hits[url.pathname] = (hits[url.pathname] || 0) + 1;
  const zip = (buf, type = 'application/zip') => {
    res.writeHead(200, { 'content-type': type, 'content-length': String(buf.length) });
    res.end(buf);
  };
  switch (url.pathname) {
    case '/ok.zip': return zip(GOOD_ZIP);
    case '/ok2.zip': return zip(OK2_ZIP);
    case '/inject.zip': return zip(INJECT_ZIP);
    case '/collide.zip': return zip(COLLIDE_ZIP);
    case '/many.zip': return zip(MANY_ZIP);
    case '/nested.zip': return zip(NESTED_ZIP, 'application/x-zip-compressed');
    case '/paramtype.zip': return zip(GOOD_ZIP, 'application/zip;charset=UTF-8');
    case '/missing.zip': return zip(NO_FILES_ZIP);
    case '/corrupt.zip': return zip(Buffer.from('this is not a zip at all'));
    case '/wrongtype.zip': return zip(GOOD_ZIP, 'text/html');
    case '/notfound.zip': res.writeHead(404); return res.end('no');
    case '/slow.zip': return;  // never answers: the fetch must time out
    case '/big-declared.zip':
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(30 * 1024 * 1024) });
      return res.end(BIG);
    case '/big-stream.zip': {
      res.writeHead(200, { 'content-type': 'application/zip', 'transfer-encoding': 'chunked' });
      let n = 0;
      const pump = () => {
        while (n < 26) { n++; if (!res.write(BIG)) return res.once('drain', pump); }
        res.end();
      };
      return pump();
    }
    case '/hop.zip': res.writeHead(302, { location: '/ok.zip' }); return res.end();
    case '/relative-hop.zip': res.writeHead(301, { location: `http://127.0.0.1:${port}/ok.zip` }); return res.end();
    case '/loop.zip': res.writeHead(302, { location: '/loop.zip' }); return res.end();
    case '/offhost.zip': res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/ok.zip` }); return res.end();
    case '/flaky.zip':
      if (flakyFails) { res.writeHead(500); return res.end('down'); }
      return zip(GOOD_ZIP);
    case '/bare.tex':
      res.writeHead(200, { 'content-type': 'text/x-tex' });
      return res.end(TEX);
    case '/bare-2020.sty':
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(STY);
    case '/bare-notype.tex':
      // A proxy that strips the content-type off an error page: the bytes are
      // not a LaTeX file, and nothing says so.
      res.writeHead(200);
      return res.end('<html>maintenance</html>');
    default: res.writeHead(404); return res.end('?');
  }
}

const server = http.createServer(handler);
const other = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const port = server.address().port;
const otherPort = other.address().port;
const origin = `http://127.0.0.1:${port}`;

// ---- registry ----

const base = {
  category: 'Conferences',
  description: 'A venue used only by this test.',
  homepage: 'https://example.org/authors',
  termsUrl: 'https://example.org/terms',
  documentClass: 'article',
  preamble: ['\\usepackage{venue}'],
  bibStyle: 'plain',
};
const archive = (id, file, take = ['venue.sty', 'sample.tex', 'sample.bib', '**/figs/*.pdf'], extra = {}) => ({
  ...base, id, name: id.toUpperCase(),
  kit: { url: `${origin}/${file}`, host: `127.0.0.1:${port}`, take },
  main: 'sample.tex',
  ...extra,
});

/** An entry whose kit is expected to fail: no `main`, so the preamble carries it. */
const failing = (id, file, take = ['venue.sty'], extra = {}) => ({
  ...base, id, name: id.toUpperCase(),
  kit: { url: `${origin}/${file}`, host: `127.0.0.1:${port}`, take },
  ...extra,
});

const VENUES = [
  archive('good', 'ok.zip'),
  failing('inject', 'inject.zip'),
  failing('collide', 'collide.zip', ['x.sty', '*.sty']),
  failing('toomany', 'many.zip', ['venue.sty', '*.tex']),
  // The venue's own class and style, which a failed kit does not deliver.
  failing('venuecls', 'notfound.zip', ['venuecls.cls'], {
    documentClass: 'venuecls', preamble: ['\\usepackage{venuesty}'], bibStyle: 'venuebst',
  }),
  failing('clsbib', 'notfound.zip', ['venuecls2.cls'], {
    documentClass: 'venuecls2', preamble: ['\\usepackage{venuesty2}'], classSetsBibStyle: true,
  }),
  // A style-file venue with class options: the options are stock article's and
  // survive the fallback. Its own-class twin's options do not.
  failing('styopts', 'notfound.zip', ['venue.sty'], { classOptions: '10pt,twocolumn,letterpaper' }),
  failing('clsopts', 'notfound.zip', ['venuecls3.cls'], {
    documentClass: 'venuecls3', classOptions: 'sigconf,anonymous',
  }),
  // `constructor` is an Object.prototype key: a `main` the kit does not carry
  // must be a miss, not the Object constructor written into main.tex.
  { ...base, id: 'protomain', name: 'PROTOMAIN', main: 'constructor',
    kit: { url: `${origin}/ok.zip`, host: `127.0.0.1:${port}`, take: ['venue.sty', '*'] } },
  { ...base, id: 'notype', name: 'NOTYPE',
    kit: { urls: [`${origin}/bare-notype.tex`], host: `127.0.0.1:${port}` } },
  archive('paramtype', 'paramtype.zip'),
  archive('notfound', 'notfound.zip'),
  archive('slow', 'slow.zip'),
  archive('bigdeclared', 'big-declared.zip'),
  archive('bigstream', 'big-stream.zip'),
  archive('wrongtype', 'wrongtype.zip'),
  archive('corrupt', 'corrupt.zip'),
  archive('missing', 'missing.zip'),
  archive('hop', 'hop.zip'),
  archive('relhop', 'relative-hop.zip'),
  archive('loop', 'loop.zip'),
  archive('offhost', 'offhost.zip'),
  archive('flaky', 'flaky.zip'),
  {
    ...base, id: 'nested', name: 'NESTED',
    kit: { url: `${origin}/nested.zip`, host: `127.0.0.1:${port}`, take: ['main.cls', 'doc.tex', '*.bst'], flatten: true },
    documentClass: 'main', main: 'doc.tex',
  },
  {
    ...base, id: 'bare', name: 'BARE',
    kit: {
      urls: [`${origin}/bare.tex`, `${origin}/bare-2020.sty`],
      host: `127.0.0.1:${port}`,
      rename: { 'bare-2020.sty': 'venue.sty' },
    },
    main: 'bare.tex',
  },
  // Dropped at load time, every one of them.
  { ...base, id: 'plain-http', name: 'HTTP', kit: { url: 'http://example.org/kit.zip', host: 'example.org', take: ['a.sty'] }, main: 'a.tex' },
  { ...base, id: 'offallow', name: 'OFF', kit: { url: 'https://elsewhere.example/kit.zip', host: 'example.org', take: ['a.sty'] }, main: 'a.tex' },
  { ...base, id: 'notake', name: 'NOTAKE', kit: { url: 'https://example.org/kit.zip', host: 'example.org' }, main: 'a.tex' },
  { ...base, id: 'globonly', name: 'GLOB', kit: { url: 'https://example.org/kit.zip', host: 'example.org', take: ['*.sty'] }, main: 'a.tex' },
  { ...base, id: 'no-main-no-preamble', name: 'EMPTY', preamble: [], kit: { url: 'https://example.org/k.zip', host: 'example.org', take: ['a.sty'] } },
  { ...base, id: 'good', name: 'DUPLICATE', kit: { url: `${origin}/ok.zip`, host: `127.0.0.1:${port}`, take: ['venue.sty'] }, main: 'venue.sty' },
  { ...base, id: 'escape', name: 'ESCAPE', kit: { url: 'https://example.org/k.zip', host: 'example.org', take: ['a.sty'], rename: { 'a.sty': '../a.sty' } }, main: 'a.tex' },
];
fs.writeFileSync(process.env.VENUES_FILE, JSON.stringify({ venues: VENUES }, null, 2));

const kits = await import('../src/venuekits.ts');

// ---- registry validation ----

const loaded = kits.venueKits().map((e) => e.id);
eq(loaded.sort(), [
  'bare', 'bigdeclared', 'bigstream', 'clsbib', 'clsopts', 'collide', 'corrupt', 'flaky', 'good',
  'hop', 'inject', 'loop', 'missing', 'nested', 'notfound', 'notype', 'offhost',
  'paramtype', 'protomain', 'relhop', 'slow', 'styopts', 'toomany', 'venuecls', 'wrongtype',
].sort(), 'only entries that pass validation are loaded');

const problem = (over) => kits.entryProblem({ ...archive('x', 'ok.zip'), ...over });
check(/not https/.test(problem({ kit: { url: 'http://example.org/k.zip', host: 'example.org', take: ['a.sty'] } })), 'a non-loopback http URL is refused');
check(/is not on/.test(problem({ kit: { url: 'https://elsewhere.example/k.zip', host: 'example.org', take: ['a.sty'] } })), 'a URL off the entry\u2019s own host is refused');
check(/take list/.test(problem({ kit: { url: 'https://example.org/k.zip', host: 'example.org' } })), 'an archive kit without a take list is refused');
check(/category/.test(problem({ category: 'Nonsense' })), 'an unknown category is refused');
check(/homepage/.test(problem({ homepage: 'ftp://example.org' })), 'a homepage that is not https is refused');
check(/main file or a preamble/.test(problem({ main: undefined, preamble: [] })), 'an entry with neither a main nor a preamble is refused');
check(/not in the take list/.test(problem({ main: 'elsewhere.tex' })), 'a main the take list cannot produce is refused');
check(/rename target/.test(problem({ kit: { url: `${origin}/ok.zip`, host: `127.0.0.1:${port}`, take: ['sample.tex'], rename: { 'sample.tex': '../a.sty' } } })), 'a rename that escapes the project is refused');
check(kits.entryProblem(archive('x', 'ok.zip')) === null, 'a well-formed entry has no problem');

// ---- the good path ----

const seed = async (id) => kits.venueKitSeed(kits.venueKit(id));

const good = await seed('good');
check(good.venueKit.ok, 'a kit that downloads and unpacks is a success');
eq(Object.keys(good.files).sort(), ['figs/plot.pdf', 'main.tex', 'sample.bib', 'venue.sty'], 'only the files the entry names reach the project');
eq(good.files['main.tex'].toString('utf8'), TEX, 'the kit\u2019s own document becomes main.tex');
check(good.files['figs/plot.pdf'].equals(PDF), 'a binary file survives byte for byte');
check(!('README-venue.md' in good.files), 'a successful kit needs no README');
eq(hits['/ok.zip'], 1, 'the kit was downloaded once');

const cached = await seed('good');
eq(hits['/ok.zip'], 1, 'a fresh cache answers without a second request');
eq(Object.keys(cached.files).sort(), ['figs/plot.pdf', 'main.tex', 'sample.bib', 'venue.sty'], 'the cache round-trips every file');
check(cached.files['figs/plot.pdf'].equals(PDF), 'the cache round-trips bytes, not text');

check((await seed('paramtype')).venueKit.ok, 'content-type parameters (application/zip;charset=UTF-8) are not part of the type');

const nested = await seed('nested');
check(nested.venueKit.ok, 'a nested archive unpacks');
eq(Object.keys(nested.files).sort(), ['first.bst', 'main.cls', 'main.tex', 'second.bst'], 'flatten drops the directories the kit nests files in');

const bare = await seed('bare');
check(bare.venueKit.ok, 'a venue that publishes bare files instead of an archive works');
eq(Object.keys(bare.files).sort(), ['main.tex', 'venue.sty'], 'a bare file is renamed the way the entry says');
eq(bare.files['venue.sty'].toString('utf8'), STY, 'the renamed style file has the right content');

// ---- failures: the project is still created ----

const failed = async (id, part, msg) => {
  const r = await seed(id);
  check(!r.venueKit.ok, `${msg}: expected a failure, got a success`);
  check(r.venueKit.reason.includes(part), `${msg}: reason "${r.venueKit.reason}" should mention "${part}"`);
  eq(Object.keys(r.files).sort(), ['README-venue.md', 'main.tex', 'references.bib'], `${msg}: the project is the skeleton plus the README`);
  check(r.files['main.tex'].toString('utf8').includes('\\documentclass'), `${msg}: the skeleton is a document`);
  check(r.files['README-venue.md'].toString('utf8').includes(r.venueKit.url), `${msg}: the README names the kit URL`);
  return r;
};

const gone = await failed('notfound', 'HTTP 404', 'a kit that is not there');
await failed('slow', 'seconds', 'a server that never answers');
await failed('bigdeclared', 'limit', 'a kit that declares more than the size cap');
await failed('bigstream', 'limit', 'a kit that streams past the size cap without declaring a length');
await failed('wrongtype', 'not a zip', 'a kit served as something other than an archive');
await failed('corrupt', 'could not be read', 'an archive that is not a zip');
await failed('missing', 'venue.sty', 'an archive without the files the entry names');
await failed('offhost', 'which is not', 'a redirect off the entry\u2019s own host');
await failed('loop', 'redirects', 'a redirect loop');

const readme = (await seed('notfound')).files['README-venue.md'].toString('utf8');
check(readme.includes('https://example.org/authors'), 'the README links the author guide');
check(readme.includes('https://example.org/terms'), 'the README links the venue\u2019s terms');
check(!/—/.test(readme), 'no em-dashes in what the user reads');

check((await seed('hop')).venueKit.ok, 'a redirect that stays on the entry\u2019s host is followed');
check((await seed('relhop')).venueKit.ok, 'an absolute same-host redirect is followed too');
await failed('notype', 'no content type', 'a bare file served without a content type');

// ---- publisher text never becomes LaTeX ----

// The reason quotes the archive's own entry name, which the publisher chooses.
const inject = await failed('inject', 'could not be read', 'an archive whose entry name carries LaTeX');
check(!/[\r\n]/.test(inject.venueKit.reason), 'the failure reason is one line, whatever the archive named its entries');
const injectTex = inject.files['main.tex'].toString('utf8');
const live = (tex) => tex.split('\n').filter((l) => !l.startsWith('%')).join('\n');
check(!live(injectTex).includes('write18'), 'nothing the publisher wrote runs as LaTeX in main.tex');
check(!live(injectTex).includes('/etc/passwd'), 'nor does an \\input the archive name asked for');
check(live(injectTex).trimStart().startsWith('\\documentclass'), 'the document still starts at \\documentclass');
const injectReadme = inject.files['README-venue.md'].toString('utf8');
check(injectReadme.split('\n').filter((l) => l.includes('write18')).length === 1, 'the README keeps the publisher text on the one line that quotes it');

// ---- a kit that is not a project seed ----

// The archive caps are not the seed caps: every other path into createProject
// is held to 1000 files, and a name that is both a file and a directory fails
// the write halfway through.
await failed('collide', 'file and a directory', 'a kit naming one path as both a file and a directory');
await failed('toomany', 'the limit is 1000', 'a kit with more files than a project seed allows');

// The byte budget, which no fixture archive should have to carry.
eq(kits.kitSeedProblem({ 'a.sty': Buffer.alloc(33 * 1024 * 1024) }), 'it is 33 MB unpacked; the limit is 32 MB',
  'a kit past the 32 MB seed budget is refused before createProject sees it');
eq(kits.kitSeedProblem({ 'a.sty': Buffer.from('x') }), null, 'an ordinary kit passes');
eq(kits.kitSeedProblem({ '.gitignore': Buffer.from('x') }), null, 'the project\u2019s own .gitignore only clashes as a directory');
check(kits.kitSeedProblem({ '.gitignore/x': Buffer.from('x') }) !== null, 'a kit that makes .gitignore a directory is refused');
// NAME_MAX: a publisher entry one byte past it is ENAMETOOLONG inside
// createProject, which owes the caller a skeleton rather than a 500.
eq(kits.kitSeedProblem({ [`${'a'.repeat(256)}.sty`]: Buffer.from('x') }), 'it has a name longer than 255 bytes',
  'a kit whose file name the filesystem cannot write is refused before createProject sees it');
eq(kits.kitSeedProblem({ [`${'a'.repeat(251)}.sty`]: Buffer.from('x') }), null, 'a name the filesystem can write passes');

// ---- the fallback skeleton stands on its own ----

const noKit = await failed('venuecls', 'HTTP 404', 'a venue whose class the project does not have');
const noKitTex = noKit.files['main.tex'].toString('utf8');
check(live(noKitTex).includes('\\documentclass{article}'), 'without the kit the skeleton starts from article, which every image has');
check(!live(noKitTex).includes('venuecls'), 'the venue class it does not have is not named in live LaTeX');
check(!live(noKitTex).includes('venuesty'), 'nor is the style the kit was going to bring');
check(noKitTex.includes('% \\documentclass{venuecls}'), 'the real class is kept as a comment to swap in');
check(noKitTex.includes('% \\usepackage{venuesty}'), 'so is the preamble the venue wants');
check(live(noKitTex).includes('\\bibliographystyle{plain}'), 'the bib style is one BibTeX has, not the kit\u2019s own .bst');
check(!live(noKitTex).includes('venuebst'), 'the venue\u2019s .bst is not named without the kit');
// A style-file venue already stands on article: only its \usepackage waits.
const goneTex = gone.files['main.tex'].toString('utf8');
eq(goneTex.match(/^\\documentclass/gm).length, 1, 'the fallback names one live document class');
check(goneTex.includes('% \\usepackage{venue}'), 'the style the kit was going to bring is a comment, not a missing package');

// The commented preamble must sit BELOW the live \documentclass: uncommenting
// a \usepackage above it is a fatal error, and the comment says to uncomment.
{
  const live = goneTex.indexOf('\n\\documentclass');
  const waiting = goneTex.indexOf('% \\usepackage');
  check(live >= 0 && waiting > live, 'the commented preamble follows the live documentclass');
}
check(!live(goneTex).includes('\\usepackage{venue}'), 'and it is not loaded before it exists');
const clsBib = await failed('clsbib', 'HTTP 404', 'a venue whose class sets its own bib style');
const clsBibTex = clsBib.files['main.tex'].toString('utf8');
check(live(clsBibTex).includes('\\bibliographystyle{plain}'), 'a class that would set the bib style is not there either, so the skeleton sets one');

// A style-file venue's class options are article's own (10pt, twocolumn,
// letterpaper): dropping them silently gives a one-column default page and
// leaves no record of the shape the venue asked for.
const styOpts = await failed('styopts', 'HTTP 404', 'a style-file venue with class options');
const styOptsTex = styOpts.files['main.tex'].toString('utf8');
check(live(styOptsTex).includes('\\documentclass[10pt,twocolumn,letterpaper]{article}'),
  'a style-file venue keeps its class options without the kit');
eq(styOptsTex.match(/^\\documentclass/gm).length, 1, 'and still names one live document class');
// The own-class branch cannot: `sigconf` means nothing to article.
const clsOpts = await failed('clsopts', 'HTTP 404', 'an own-class venue with class options');
const clsOptsTex = clsOpts.files['main.tex'].toString('utf8');
check(live(clsOptsTex).includes('\\documentclass{article}'), 'an own-class venue falls back to plain article');
check(!live(clsOptsTex).includes('sigconf'), 'its class options are not handed to article, which does not know them');
check(clsOptsTex.includes('% \\documentclass[sigconf,anonymous]{venuecls3}'), 'they wait in the comment with the class');

// ---- a main the kit does not carry ----

// 'constructor' answers `in` on any object literal: the miss must be a miss.
const proto = await seed('protomain');
check(proto.venueKit.ok, 'a kit whose named main is absent is still a good kit');
check(proto.files['main.tex'].toString('utf8').includes('generated by Aldine from the official kit'),
  'the generated skeleton stands in for the document the kit does not carry');
check(Buffer.isBuffer(proto.files['main.tex']), 'main.tex is bytes, not something off Object.prototype');
eq(Object.keys(kits.selectKitFiles({ 'kit/constructor': Buffer.from('c'), 'kit/toString': Buffer.from('t') },
  { host: 'x', take: ['constructor', 'toString'] })).sort(), ['constructor', 'toString'],
  'a kit file named after an Object.prototype key is placed, not silently dropped');

// ---- the cache outlives the publisher ----

flakyFails = false;
check((await seed('flaky')).venueKit.ok, 'the flaky kit caches while it is up');
const stamp = path.join(process.env.CACHE_DIR, 'venue-kits', 'flaky', 'kit.json');
const meta = JSON.parse(fs.readFileSync(stamp, 'utf8'));
meta.fetchedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
fs.writeFileSync(stamp, JSON.stringify(meta));
flakyFails = true;
const stale = await seed('flaky');
check(stale.venueKit.ok, 'a cached kit is used when the fetch fails, whatever its age');
eq(Object.keys(stale.files).sort(), ['figs/plot.pdf', 'main.tex', 'sample.bib', 'venue.sty'], 'the stale cache seeds the whole kit');
check(hits['/flaky.zip'] >= 2, 'the stale cache was only used after the refetch failed');

// ---- a registry change outranks the cache ----

// The cached kit is the old URL's files; the skeleton would still name the new
// preamble, so a project seeded from the cache could not typeset.
const registryFile = process.env.VENUES_FILE;
const bumped = VENUES.map((v) => (v.id === 'good' ? { ...v, kit: { ...v.kit, url: `${origin}/ok2.zip` } } : v));
fs.writeFileSync(registryFile, JSON.stringify({ venues: bumped }, null, 2));
eq(kits.venueKit('good').kit.url, `${origin}/ok2.zip`, 'the registry reloads when the file changes');
const rolled = await seed('good');
check(rolled.venueKit.ok, 'the new kit downloads');
eq(hits['/ok2.zip'], 1, 'a cache written for the old kit URL is a miss, not seven days of last year\u2019s files');
check(rolled.files['venue.sty'].toString('utf8').includes('2027'), 'the project gets the files the registry names now');

// ---- selection is not a path oracle ----

const hostile = { 'kit/a.sty': Buffer.from('a'), '../b.sty': Buffer.from('b'), 'kit/.git/config': Buffer.from('c') };
eq(Object.keys(kits.selectKitFiles(hostile, { host: 'x', take: ['a.sty', '*.sty', 'config*'] })), ['a.sty'],
  'a `..` entry and a .git entry are never selected, however wide the globs');
let refused = null;
try { kits.selectKitFiles(hostile, { host: 'x', take: ['a.sty', 'b.sty'] }); } catch (err) { refused = err.message; }
check(refused && refused.includes('b.sty'), 'an entry the archive does not have is a failure, not a half-seeded project');

// ---- the gallery ----

const tiles = kits.venueKitTemplates();
const tile = tiles.find((t) => t.id === 'venue:good');
eq(tile.category, 'Conferences', 'the tile keeps its category');
eq(tile.kit.host, `127.0.0.1:${port}`, 'the tile says which host the kit comes from');
eq(tile.license, 'Publisher terms', 'the tile does not claim a licence Aldine cannot assert');
eq(tile.licenseUrl, 'https://example.org/terms', 'the tile links the venue\u2019s terms');
check(tiles.every((t) => t.id.startsWith('venue:')), 'fetched venues share the venue id space with the installed classes');

server.close();
other.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('venue kits: all checks passed');
