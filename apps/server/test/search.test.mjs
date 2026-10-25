/**
 * Search and replace across a project (#112): the pure scan core (query
 * semantics, offsets, previews, caps), replacement expansion, the rebase of
 * matches over concurrent edits, the pick of the one match a click means,
 * commit messages, the worker's time budget, and the two routes on the real
 * route table — live documents read and changed in place, edits landing
 * while the worker runs, one commit per action under the person's name,
 * CRLF and mixed line endings, manual-commit projects, showcase projects,
 * symlinks and access.
 *
 * Env must be set before any src import: AUTH_ENABLED and the data roots are
 * read at module load, and a placeholder protected project makes the
 * showcase guard register. The worker budget is shrunk only around the
 * checks that need it (SEARCH_LIMITS is read at call time): every search
 * runs in a worker, and a slow CI runner can spend 300 ms just starting one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { check, eq } from './assert.mjs';

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-search-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_SEARCH_BURST = '1000';
process.env.RL_REPLACE_BURST = '1000';
process.env.ALDINE_PROTECTED_PROJECTS = 'placeholder';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const scan = await import('../src/search-scan.ts');
const search = await import('../src/search.ts');
const { searchGate } = await import('../src/ratelimit.ts');
const { SEARCH_LIMITS } = search;

const limits = { maxMatches: 2000, maxScanUnits: 8 * 1024 * 1024, maxMatchUnits: 1000, maxResultUnits: 4 * 1024 * 1024 };
const opts = (o = {}) => ({ caseSensitive: false, wholeWord: false, regex: false, ...o });
const find = (text, q, o = {}, replace) => scan.scanFiles([{ path: 'a.tex', text }], scan.buildPattern(q, opts(o)), limits, replace);
const froms = (r) => (r.files[0]?.matches ?? []).map((m) => m.from);
/** What the panel sends for a row: its text, its preview, its place among the file's matches of the same text, and how many of those share its preview. */
const targetOf = (matches, i) => {
  const m = matches[i];
  const same = matches.filter((x) => x.text === m.text);
  const alike = same.filter((x) => JSON.stringify(x.preview) === JSON.stringify(m.preview)).length;
  return { text: m.text, preview: m.preview, ordinal: same.indexOf(m), count: same.length, alike };
};
const pickIn = (text, q, target, o = {}) => scan.pickMatch(text, scan.buildPattern(q, opts(o)), target, limits);
const picked = (r) => ('match' in r ? r.match.from : 'stale');
const changedLines = (patch) => patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).sort();

// ---- query semantics ----
eq(froms(find('Widget widget WIDGET', 'widget')), [0, 7, 14], 'case-insensitive by default');
eq(froms(find('Widget widget WIDGET', 'widget', { caseSensitive: true })), [7], 'match case');
eq(froms(find('Müller Müllers xMüller Müller.', 'Müller', { wholeWord: true })), [0, 23], 'whole word holds at non-ASCII letters (ASCII \\b would split "Müller")');
eq(froms(find('a\\cite{x} \\citep{y} \\cite', '\\cite', { wholeWord: true })), [1, 20], 'a literal \\cite matches in a\\cite{ and at the end, not in \\citep');
eq(froms(find('a.b axb', 'a.b')), [0], 'literal mode escapes regex syntax');
eq(froms(find('colour color', 'colou?r', { regex: true })), [0, 7], 'regex mode');
eq(froms(find('cat catalog', 'cat|dog', { regex: true, wholeWord: true })), [0], 'whole word wraps the whole alternation');
const latex = 'see \\cite{smith} and \\label{fig:a} \\citep{x}';
eq(froms(find(latex, '\\\\cite\\{', { regex: true, wholeWord: true })), [4], 'whole word in regex mode needs no boundary at an edge that is not a word character');
eq(froms(find(latex, '\\\\(cite|label)\\{', { regex: true, wholeWord: true })), [4, 21], 'the same for a group, as literal mode does');
eq(froms(find(latex, 'cite', { regex: true, wholeWord: true })), [5], 'and a word edge still needs one: cite is not found inside \\citep');

// ---- empty matches, multi-line matches, offsets ----
let r = find('abc\ndef\n', '^', { regex: true });
check(r.total === 0 && r.files.length === 0, '^ reports nothing and the scan ends');
r = find('xyz😀', 'a*', { regex: true });
check(r.total === 0, 'a* reports nothing and steps over a surrogate pair');
r = find('a\nab\ncd', 'b\\nc', { regex: true });
let m = r.files[0].matches[0];
check(m.line === 2 && m.column === 2 && m.text === 'b\nc', `a match across lines takes its start's line and column (got ${m.line}:${m.column})`);
eq(m.preview, { text: 'ab', start: 1, end: 2 }, 'its preview is the first line, the highlight clipped at the line end');
r = find('😀 widget', 'widget');
m = r.files[0].matches[0];
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');
ytext.insert(0, '😀 widget');
ytext.delete(m.from, m.to - m.from);
check(m.from === 3 && ytext.toString() === '😀 ', `offsets are UTF-16 units, the same as Y.Text's (from ${m.from})`);
r = find('one\r\ntwo widget\r\n', 'widget');
m = r.files[0].matches[0];
check(m.line === 2 && m.column === 5, 'CRLF lines count once');
eq(m.preview, { text: 'two widget', start: 4, end: 10 }, 'the preview drops the \\r');

// ---- previews ----
m = find(`${'x'.repeat(100)}widget${'y'.repeat(100)}`, 'widget').files[0].matches[0];
eq(m.preview, { text: `…${'x'.repeat(40)}widget${'y'.repeat(74)}…`, start: 41, end: 47 }, 'a long line keeps 40 units before the match, 120 in all, and marks both cuts');
m = find(`${'a'.repeat(20)}😀${'b'.repeat(39)}widget`, 'widget').files[0].matches[0];
check(m.preview.text.isWellFormed() && m.preview.text === `…${'b'.repeat(39)}widget` && m.preview.start === 40, `the front cut does not split a surrogate pair (got ${JSON.stringify(m.preview)})`);
m = find(`widget${'c'.repeat(113)}😀${'d'.repeat(10)}`, 'widget').files[0].matches[0];
check(m.preview.text.isWellFormed() && m.preview.text === `widget${'c'.repeat(113)}…`, `the back cut does not split a surrogate pair (got ${JSON.stringify(m.preview.text)})`);

// ---- caps ----
r = find('x '.repeat(2000), 'x');
check(r.total === 2000 && r.truncated === null, 'exactly 2,000 matches is not truncated');
r = find('x '.repeat(2001), 'x');
check(r.total === 2000 && r.truncated === 'matches', '2,001 matches stop at 2,000 with truncated: matches');
r = find('y'.repeat(1001), 'y+', { regex: true });
check(r.total === 0 && r.longMatches === 1, 'a match longer than 1,000 units is counted, not reported');
r = scan.scanFiles([{ path: 'a', text: 'x'.repeat(10) }, { path: 'b', text: 'x'.repeat(10) }], scan.buildPattern('x', opts()), { ...limits, maxScanUnits: 15 });
check(r.truncated === 'bytes' && r.files.length === 1, 'the scan stops before the file that passes the text budget');

// ---- replacement expansion ----
const exec = (re, s) => re.exec(s);
const at = exec(/(\w+)@(\w+)/, 'ada@lab');
eq(scan.expandReplacement('$2:$1', at), 'lab:ada', '$1 and $2');
eq(scan.expandReplacement('<$&> $$', at), '<ada@lab> $', '$& and $$');
eq(scan.expandReplacement('$9', at), '$9', '$9 without group 9 stays literal');
eq(scan.expandReplacement('$10', at), 'ada0', '$10 with one-digit groups only is $1 then a 0, as in JS');
eq(scan.expandReplacement('$`|$\'', at), '$`|$\'', '$` and $\' stay literal');
eq(scan.expandReplacement('$<user>!', exec(/(?<user>\w+)@/, 'ada@lab')), 'ada!', '$<name>');
eq(scan.expandReplacement('$<user>', at), '$<user>', '$<name> without named groups stays literal');
eq('ada@lab'.replace(/(\w+)@(\w+)/, '$2:$1 $& $$ $9 $10'), scan.expandReplacement('$2:$1 $& $$ $9 $10', at), 'the same result as String.prototype.replace');
r = find('flavour', 'our', {}, { template: '$1or', regex: false });
eq(r.files[0].matches[0].replacement, '$1or', 'literal mode inserts the replacement verbatim');
r = find('flavour savour', '(\\w+)our', { regex: true }, { template: '$1or', regex: true });
eq(r.files[0].matches.map((x) => x.replacement), ['flavor', 'savor'], 'regex mode expands per match');

// ---- rebase over concurrent edits ----
const hit = { from: 3, to: 9, text: 'widget' };
eq(scan.rebaseMatches('aa widget', 'aa widget', [hit]), { kept: [hit], skipped: 0 }, 'identical texts change nothing');
eq(scan.rebaseMatches('aa widget', 'aaXX widget', [hit]).kept, [{ from: 5, to: 11, text: 'widget' }], 'an edit before a match shifts it');
eq(scan.rebaseMatches('aa widget.', 'aa widget. More', [hit]).kept, [hit], 'an edit after a match keeps it');
eq(scan.rebaseMatches('aa widget', 'aa widgets', [hit]), { kept: [], skipped: 1 }, 'an edit touching a match drops it');
eq(scan.rebaseMatches('aa widget', 'aa wiXdget', [hit]), { kept: [], skipped: 1 }, 'an edit inside a match drops it');
eq(scan.rebaseMatches('aa widget', 'Xa widget', [hit]).kept, [hit], 'an edit of the same length before a match keeps its offsets');

// ---- the one match a click means ----
let shown = find('x y x\n', 'x').files[0].matches;
eq(picked(pickIn('x y x\n', 'x', targetOf(shown, 1))), 4, 'unchanged text: the match clicked');
eq(picked(pickIn('NEW\nx y x\n', 'x', targetOf(shown, 1))), 8, 'an insert above: the same occurrence, though the first one now starts at its old offset');
shown = find('colour and colour\n', 'colour').files[0].matches;
eq(picked(pickIn('Intro.\ncolour and colour\n', 'colour', targetOf(shown, 1))), 18, 'an insert above two matches on one line: the second stays the second, not the nearer one');
const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
lines[2] = 'The colour of the sea.';
lines[39] = 'Another colour here.';
shown = find(lines.join('\n'), 'colour').files[0].matches;
const gone3 = [...lines];
gone3[2] = 'The sea.';
eq(picked(pickIn(gone3.join('\n'), 'colour', targetOf(shown, 0))), 'stale', 'the clicked line lost its match: stale, never the occurrence 37 lines further down');
const dup = 'colour\ncolour\ncolour\ncolour\n';
shown = find(dup, 'colour').files[0].matches;
eq(picked(pickIn(`Intro\n${dup}`, 'colour', targetOf(shown, 2))), 20, 'identical lines: an insert above keeps the third the third');
eq(picked(pickIn(`colour\n${dup}`, 'colour', targetOf(shown, 2))), 'stale', 'identical lines and one more of them: stale, since any of the five could be meant');
shown = find('the colour red\nthe colour red\n', 'colour').files[0].matches;
eq(picked(pickIn('the colour red\nthe colour blue\n', 'colour', targetOf(shown, 1))), 'stale', 'the clicked one of two identical lines was edited around its match: stale, never its untouched twin');
eq(picked(pickIn('colour\nthe colour red\nthe colour blue\n', 'colour', targetOf(shown, 1))), 'stale', 'the same with one more match elsewhere');
shown = find('a colour\nb colour\n', 'colour').files[0].matches;
eq(picked(pickIn('colour first\na colour\nb colour\n', 'colour', targetOf(shown, 1))), 24, 'one more match above a line that was unique: found by its preview');
const many = 'x '.repeat(2500);
shown = scan.scanFiles([{ path: 'a.tex', text: many }], scan.buildPattern('x', opts()), { ...limits, maxMatches: Infinity }).files[0].matches;
eq(picked(pickIn(many, 'x', targetOf(shown, 2400))), 4800, 'past the 2,000th match of a file: the match clicked, not the 2,000th');
r = scan.pickMatch('flavour savour', scan.buildPattern('(\\w+)our', opts({ regex: true })), targetOf(find('flavour savour', '(\\w+)our', { regex: true }).files[0].matches, 1), limits, { template: '$1or', regex: true });
check(r.match.from === 8 && r.match.replacement === 'savor', `the pick has its replacement expanded (got ${JSON.stringify(r)})`);

// ---- commit messages ----
eq(search.replaceCommitMessage('colour', 'color', ['chapters/one.tex']), 'Replace "colour" with "color" in chapters/one.tex', 'one file is named');
eq(search.replaceCommitMessage('colour', 'color', ['a', 'b', 'c']), 'Replace "colour" with "color" in 3 files', 'several files are counted');
eq(search.replaceCommitMessage('colou?r', 'color', ['a', 'b'], { regex: true }), 'Replace /colou?r/ with "color" in 2 files', 'a regex shows as /…/');
eq(search.replaceCommitMessage('colour', '', ['a', 'b', 'c']), 'Delete "colour" in 3 files', 'an empty replacement deletes');
eq(search.replaceCommitMessage('a'.repeat(50), 'b', ['x']), `Replace "${'a'.repeat(40)}…" with "b" in x`, 'a long query is cut at 40 characters');
eq(search.replaceCommitMessage('one\n  two', 'three\tfour', ['x']), 'Replace "one two" with "three four" in x', 'whitespace collapses');

// ---- routes ----
const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const collab = await import('../src/collab.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await registerRoutes(app);

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const eve = await auth.register('eve@example.com', 'password123', 'Eve');
const { token: eveTok } = await auth.createAccessToken(eve.id, 'Test', null, null);
// a session, as the panel sends: replace is not among the routes an access token may use
const asAda = { cookie: `aldine_session=${await auth.createSession(ada.id)}` };

const get = (id, query, headers = asAda) => app.inject({ method: 'GET', url: `/api/projects/${id}/search?${new URLSearchParams({ branch: 'main', ...query })}`, headers });
const replace = (id, body, headers = asAda) => app.inject({ method: 'POST', url: `/api/projects/${id}/replace`, headers, payload: { branch: 'main', ...body } });
const disk = (id, rel) => store.readFile(id, 'main', rel).toString('utf8');
const logOf = (id) => gitops.log(id, 'main');
/** Replace (one)'s match for row `i` of `rel` in a search's answer, as the panel builds it. */
const rowOf = (answer, rel, i) => ({ path: rel, ...targetOf(answer.files.find((f) => f.path === rel).matches, i) });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** Run `fn` once, while the next search worker is running: after the snapshot, before the apply. */
const whileScanning = (fn) => process.once('worker', fn);
/** Hold a worker's answer, and its exit after it, until `ready` has settled. */
const holdAnswer = (worker, ready) => {
  const emit = worker.emit.bind(worker);
  let queue = null;
  worker.emit = (ev, ...args) => {
    if (ev === 'message') queue ??= ready;
    if (!queue) return emit(ev, ...args);
    queue = queue.then(() => emit(ev, ...args));
    return true;
  };
};

// ---- GET search ----
const p = await store.createProject('Search', {
  'main.tex': '\\input{chapters/one}\nIntro widget.\n',
  'chapters/one.tex': 'widget Widget widgets\n',
}, ada.id);
store.writeFile(p.id, 'main', 'main.log', 'widget in the log\n');
store.writeFile(p.id, 'main', '.latexmkrc', '# widget\n');
store.writeFile(p.id, 'main', 'nul.tex', 'widget\0binary\n');
store.writeFile(p.id, 'main', 'huge.tex', `widget ${'z'.repeat(1.1 * 1024 * 1024)}`);
store.writeFile(p.id, 'main', 'huge2.tex', `widget ${'z'.repeat(1.1 * 1024 * 1024)}`);
// the store refuses to write compile output; the compiler does it beside the project files
fs.mkdirSync(path.join(store.branchDir(p.id, 'main'), '.aldine-out'), { recursive: true });
fs.writeFileSync(path.join(store.branchDir(p.id, 'main'), '.aldine-out', 'main.tex'), 'widget\n');
store.writeFile(p.id, 'main', 'figure.png', 'widget\n');
// invalid UTF-8 past the 8 KB the binary sniff looks at
store.writeFile(p.id, 'main', 'bad.tex', Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0xfc]), Buffer.from(' widget\n')]));
const conn = await collab.hocuspocus.openDirectConnection(collab.docName(p.id, 'main', 'main.tex'), {});
conn.document.transact(() => conn.document.getText('content').insert(0, 'NEW widget '));
check(!disk(p.id, 'main.tex').includes('NEW widget'), 'setup: the live text is ahead of disk');

let res = await get(p.id, { q: 'widget' });
eq(res.statusCode, 200, 'search answers 200');
let body = res.json();
eq(body.files.map((f) => f.path), ['chapters/one.tex', 'main.tex'], 'only searchable files with hits, in path order (not the log, a hidden file, a NUL, invalid UTF-8, output or a figure)');
const main = body.files.find((f) => f.path === 'main.tex');
check(main.open === true && main.matches.map((x) => x.from).join() === '4,38', `the open file is read from its live doc, at live offsets (got ${JSON.stringify(main)})`);
check(body.files.find((f) => f.path === 'chapters/one.tex').open === false, 'a never-opened file is read from disk');
eq(body.files.find((f) => f.path === 'chapters/one.tex').matches.length, 3, 'case-insensitive substring by default');
eq(body.total, 5, 'total counts the reported matches');
eq(body.skipped, { large: ['huge.tex', 'huge2.tex'], largeCount: 2, longMatches: 0 }, 'files over 1 MiB are named and counted, not searched');
check(body.truncated === null, 'nothing truncated');
SEARCH_LIMITS.largeNames = 1;
eq((await get(p.id, { q: 'widget' })).json().skipped, { large: ['huge.tex'], largeCount: 2, longMatches: 0 }, 'the count covers the files past the names listed');
SEARCH_LIMITS.largeNames = 20;
check(disk(p.id, 'main.tex').indexOf('NEW widget') === -1, 'searching does not flush the live doc');
res = await get(p.id, { q: 'widget', case: '1', word: '1' });
eq(res.json().total, 3, 'match case and whole word narrow it');
res = await get(p.id, { q: 'widgets?\\b', regex: '1' });
eq(res.json().total, 5, 'a regex search');

// access
eq((await get(p.id, { q: 'widget' }, { authorization: `Bearer ${eveTok}` })).statusCode, 403, 'a stranger is refused');
eq((await get(p.id, { q: 'widget' }, {})).statusCode, 401, 'no credentials is 401');
eq((await get(p.id, { q: '' })).json().error, 'Search for at least one character', 'an empty query is 400');
eq((await get('zzzzzzzzzz', { q: 'x' })).statusCode, 404, 'an unknown project is 404');

// invalid input never starts a worker: with Ada's search slot held, a worker would be a 429
const adaKey = `u:${ada.id}`;
check(searchGate.tryAcquire(adaKey), 'setup: hold the search gate');
res = await get(p.id, { q: '(', regex: '1' });
check(res.statusCode === 400 && /^Invalid regular expression: /.test(res.json().error) && !res.json().error.includes('/gimu'), `an invalid regex is 400 naming the reason (got ${res.statusCode} ${res.body})`);
res = await get(p.id, { q: 'a'.repeat(501), regex: '1' });
check(res.statusCode === 400 && res.json().error === 'Search text is too long (500 characters at most)', '501 characters are 400');
eq((await get(p.id, { q: 'a+', regex: '1' })).statusCode, 429, 'setup check: a valid regex would need the held slot');
eq((await get(p.id, { q: 'a' })).statusCode, 429, 'and so would a literal: it runs in a worker too');
searchGate.release(adaKey);

// the worker's budget
SEARCH_LIMITS.scanMs = 300;
store.writeFile(p.id, 'main', 'redos.tex', `${'a'.repeat(30)}!\n`);
let ticks = 0;
let ticker = setInterval(() => { ticks++; }, 10);
let t0 = Date.now();
res = await get(p.id, { q: '(a+)+$', regex: '1' });
let took = Date.now() - t0;
clearInterval(ticker);
check(res.statusCode === 422 && res.json().code === 'search_timeout' && /regular expression/.test(res.json().error), `a catastrophic regex is refused (got ${res.statusCode} ${res.body})`);
check(took < 1500, `within the budget (took ${took} ms)`);
check(ticks > 20, `the event loop kept running meanwhile (${ticks} ticks)`);
const [first, second] = await Promise.all([get(p.id, { q: '(a+)+$', regex: '1' }), get(p.id, { q: '(a+)+$', regex: '1' })]);
const codes = [first.statusCode, second.statusCode].sort();
check(codes[0] === 422 && codes[1] === 429, `one search per client at a time (got ${codes})`);
check([first, second].some((x) => x.json().error === 'A search is still running — wait for it to finish'), 'the second is told one is still running');
// V8 matches a case-insensitive literal in O(text × query): 'a'×499+'b' over 8 MiB of 'a' takes seconds
const lit = await store.createProject('Literal', { 'main.tex': 'x\n' }, ada.id);
for (let i = 0; i < 8; i++) store.writeFile(lit.id, 'main', `a${i}.tex`, 'a'.repeat(1024 * 1024 - 1));
ticks = 0;
ticker = setInterval(() => { ticks++; }, 10);
t0 = Date.now();
res = await get(lit.id, { q: `${'a'.repeat(499)}b` });
took = Date.now() - t0;
clearInterval(ticker);
check(res.statusCode === 422 && res.json().code === 'search_timeout' && res.json().error === 'This search takes too long to run — search for shorter text', `a slow literal search is refused too (got ${res.statusCode} ${res.body})`);
check(took < 1500 && ticks > 15, `within the budget, the event loop running meanwhile (took ${took} ms, ${ticks} ticks)`);
SEARCH_LIMITS.scanMs = 2000;
eq((await get(p.id, { q: 'widget', regex: '1' })).statusCode, 200, 'the slot is free again afterwards');

// a binary file costs its sniff against the 8 MiB budget, not nothing and not its length
const bin = await store.createProject('Binary', { 'zz.tex': 'needle\n' }, ada.id);
const nulLed = Buffer.concat([Buffer.from([0]), Buffer.alloc(16 * 1024, 0x61)]);
for (let i = 0; i < 5; i++) store.writeFile(bin.id, 'main', `b${i}.tex`, nulLed);
SEARCH_LIMITS.scanUnits = 64 * 1024;
body = (await get(bin.id, { q: 'needle' })).json();
check(body.total === 1 && body.truncated === null, `five 16 KB binary files cost five 8 KB sniffs, within a 64 KB budget (got ${JSON.stringify(body)})`);
for (let i = 5; i < 10; i++) store.writeFile(bin.id, 'main', `b${i}.tex`, nulLed);
body = (await get(bin.id, { q: 'needle' })).json();
check(body.total === 0 && body.truncated === 'bytes', `ten of them spend it, and the search says it stopped (got ${JSON.stringify(body)})`);
SEARCH_LIMITS.scanUnits = 8 * 1024 * 1024;

// a showcase project is searchable
collab.protectedProjects.add(p.id);
eq((await get(p.id, { q: 'widget' })).statusCode, 200, 'a protected project can be searched');
res = await replace(p.id, { q: 'widget', replace: 'gadget', paths: ['main.tex'] });
check(res.statusCode === 403 && /read-only showcase/.test(res.json().error), 'and not replaced in');
const encoded = `%${p.id.charCodeAt(0).toString(16)}${p.id.slice(1)}`;
res = await replace(encoded, { q: 'widget', replace: 'gadget', paths: ['chapters/one.tex'] });
check(res.statusCode === 403 && /read-only showcase/.test(res.json().error), `not with a percent-encoded id either (got ${res.statusCode} ${res.body})`);
check(disk(p.id, 'chapters/one.tex') === 'widget Widget widgets\n', 'nothing written');
collab.protectedProjects.delete(p.id);
await conn.disconnect();

// ---- Replace (one) ----
const q = await store.createProject('Replace one', { 'a.tex': 'x x x\n' }, ada.id);
let before = (await logOf(q.id)).length;
let row = rowOf((await get(q.id, { q: 'x' })).json(), 'a.tex', 1);
res = await replace(q.id, { q: 'x', replace: 'y', match: row });
body = res.json();
check(res.statusCode === 200 && body.replaced === 1 && body.skipped === 0 && /^[0-9a-f]{7}$/.test(body.commit) && body.pending === false, `one match replaced (got ${res.body})`);
eq(disk(q.id, 'a.tex'), 'x y x\n', 'the file changed at that match only');
let log = await logOf(q.id);
check(log.length === before + 1, `exactly one new commit (got ${log.length - before})`);
check(log[0].author === 'Ada' && log[0].message === 'Replace "x" with "y" in a.tex', `under the person's name and the replace (got ${log[0].author}: ${log[0].message})`);
before = log.length;
res = await replace(q.id, { q: 'x', replace: 'y', match: { ...row, text: 'z' } });
check(res.statusCode === 409 && res.json().code === 'stale_match', `stale text is 409 stale_match (got ${res.statusCode} ${res.body})`);
res = await replace(q.id, { q: 'x', replace: 'y', match: row });
check(res.statusCode === 409, `the row just replaced is stale: its line reads differently now (got ${res.statusCode} ${res.body})`);
check(disk(q.id, 'a.tex') === 'x y x\n' && (await logOf(q.id)).length === before, 'nothing written, nothing committed');
row = rowOf((await get(q.id, { q: 'x' })).json(), 'a.tex', 1);
store.writeFile(q.id, 'main', 'a.tex', 'NEW\nx y x\n');
res = await replace(q.id, { q: 'x', replace: 'y', match: row });
check(res.statusCode === 200 && res.json().replaced === 1, `a match moved by an insert above still lands (got ${res.body})`);
eq(disk(q.id, 'a.tex'), 'NEW\nx y y\n', 'on the occurrence clicked, not on the one that moved onto its old offset');
log = await logOf(q.id);
check(log[0].author === 'Ada' && log[1].message === 'aldine: autosave', 'the insert was checkpointed apart from the replace');
eq(changedLines((await gitops.commitDiff(q.id, log[0].hash)).patch), ['+x y y', '-x y x'], "the person's commit holds the replacement and nothing else");
res = await replace(q.id, { q: 'x', replace: 'y', match: { path: 'a.tex', text: 'x' } });
check(res.statusCode === 400 && /^match needs path, text, preview, ordinal, count and alike/.test(res.json().error), `a match without its preview and place is 400 (got ${res.body})`);
res = await replace(q.id, { q: 'x', replace: 'y', match: { ...row, ordinal: 2, count: 2 } });
eq(res.statusCode, 400, 'an ordinal past the count is 400');
res = await replace(q.id, { q: 'x', replace: 'y', match: { ...row, alike: 0 } });
eq(res.statusCode, 400, 'no match sharing its own preview is 400');

// a template expanded for the one match only, however many the file has
const ob = await store.createProject('One big', { 'big.tex': 'a'.repeat(1000 * 1000) }, ada.id);
row = rowOf((await get(ob.id, { q: 'a{1000}', regex: '1' })).json(), 'big.tex', 0);
res = await replace(ob.id, { q: 'a{1000}', regex: true, replace: '$&'.repeat(500), match: row });
check(res.statusCode === 200 && res.json().replaced === 1, `one 500 K replacement in a file of 1,000 such matches (got ${res.statusCode} ${res.body})`);
eq(disk(ob.id, 'big.tex').length, 1000 * 1000 - 1000 + 500 * 1000, 'grew by that one replacement');

// ---- Replace all over one open doc and one closed file ----
const s = await store.createProject('Replace all', {
  'doc.tex': 'colour colour\n',
  'closed.tex': 'colour\n',
  'other.tex': 'nothing here\n',
  'regex.tex': 'flavour savour\n',
  'many.tex': 'x '.repeat(2001),
  'big.tex': `${'a'.repeat(1000)}\n`.repeat(10),
}, ada.id);
const badBytes = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0xfc]), Buffer.from(' widget\n')]);
store.writeFile(s.id, 'main', 'bad.tex', badBytes);
const sconn = await collab.hocuspocus.openDirectConnection(collab.docName(s.id, 'main', 'doc.tex'), {});
let transactions = 0;
sconn.document.on('afterTransaction', () => { transactions++; });
before = (await logOf(s.id)).length;
res = await replace(s.id, { q: 'colour', replace: 'color', paths: ['doc.tex', 'closed.tex'] });
body = res.json();
check(res.statusCode === 200 && body.replaced === 3 && body.skipped === 0, `three matches replaced (got ${res.body})`);
eq(body.files, [{ path: 'closed.tex', replaced: 1, skipped: 0 }, { path: 'doc.tex', replaced: 2, skipped: 0 }], 'per file');
eq(transactions, 1, 'the open doc changed in one transaction');
eq(sconn.document.getText('content').toString(), 'color color\n', 'the live doc holds the replacement');
eq(disk(s.id, 'doc.tex'), 'color color\n', 'and so does its file');
eq(disk(s.id, 'closed.tex'), 'color\n', 'the closed file changed on disk');
log = await logOf(s.id);
check(log.length === before + 1 && log[0].author === 'Ada' && log[0].message === 'Replace "colour" with "color" in 2 files', `one commit by Ada (got ${JSON.stringify(log.slice(0, 2))})`);
const stat = (await gitops.commitDiff(s.id, log[0].hash)).stat;
const statFiles = stat.split('\n').filter((l) => l.includes('|')).map((l) => l.split('|')[0].trim()).sort();
eq(statFiles, ['closed.tex', 'doc.tex'], 'whose diff holds exactly those two files');
await sconn.disconnect();

res = await replace(s.id, { q: '(\\w+)our', regex: true, replace: '$1or', paths: ['regex.tex'] });
check(res.statusCode === 200 && res.json().replaced === 2, `a regex replace (got ${res.body})`);
eq(disk(s.id, 'regex.tex'), 'flavor savor\n', 'expands $1');
eq((await logOf(s.id))[0].message, 'Replace /(\\w+)our/ with "$1or" in regex.tex', 'titled with the pattern');
res = await replace(s.id, { q: 'x', replace: 'y', paths: ['.git/config'] });
check(res.statusCode === 403 && res.json().error === 'Invalid file path', '.git/config is 403');
eq((await replace(s.id, { q: 'x', replace: 'y', paths: ['../x.tex'] })).statusCode, 403, 'a path with .. is 403');
before = (await logOf(s.id)).length;
res = await replace(s.id, { q: 'savor', replace: 'taste', paths: ['missing.tex', 'regex.tex'] });
body = res.json();
check(res.statusCode === 200 && body.replaced === 1 && body.skipped === 1, `a missing path counts as skipped (got ${res.body})`);
res = await replace(s.id, { q: 'nomatch', replace: 'y', paths: ['other.tex'] });
body = res.json();
check(res.statusCode === 200 && body.replaced === 0 && body.commit === null, 'nothing to replace is 200 with no commit');
check((await logOf(s.id)).length === before + 1, 'only the replace that changed something committed');
res = await replace(s.id, { q: 'widget', replace: 'gadget', paths: ['bad.tex'] });
body = res.json();
check(res.statusCode === 200 && body.replaced === 0 && body.skipped === 1, `a file with invalid UTF-8 past its first 8 KB is skipped (got ${res.body})`);
check(store.readFile(s.id, 'main', 'bad.tex').equals(badBytes), 'and its bytes are left as they were');
before = (await logOf(s.id)).length;
res = await replace(s.id, { q: 'x', replace: 'y', paths: ['many.tex'] });
check(res.statusCode === 413 && res.json().error === 'More than 2,000 matches — narrow the search', `2,001 matches are 413 (got ${res.statusCode} ${res.body})`);
eq(disk(s.id, 'many.tex'), 'x '.repeat(2001), 'nothing written');
res = await replace(s.id, { q: 'a{1000}', regex: true, replace: '$&'.repeat(500), paths: ['big.tex'] });
check(res.statusCode === 413 && res.json().error === '"big.tex" would grow past 4 MB', `a file growing past 4 MiB is 413 (got ${res.statusCode} ${res.body})`);
eq(disk(s.id, 'big.tex'), `${'a'.repeat(1000)}\n`.repeat(10), 'nothing written');
check((await logOf(s.id)).length === before, 'and nothing committed');
eq((await replace(s.id, { q: 'x', replace: 'y'.repeat(1001), paths: ['many.tex'] })).statusCode, 400, 'a replacement over 1,000 characters is 400');
eq((await replace(s.id, { q: 'x', replace: 'y', paths: Array.from({ length: 201 }, (_, i) => `f${i}.tex`) })).statusCode, 400, 'more than 200 files is 400');
eq((await replace(s.id, { q: 'x', replace: 'y' })).statusCode, 400, 'neither match nor paths is 400');
eq((await replace(s.id, { q: 'colour', replace: 'color', paths: ['doc.tex'] }, { authorization: `Bearer ${eveTok}` })).statusCode, 403, 'a stranger cannot replace');

// ---- edits landing while the worker runs ----
// in the replaced document: the touched match is left alone, the rest land, the commit holds only them
const cp = await store.createProject('Concurrent', { 'live.tex': 'colour one\ncolour two\ncolour three\n' }, ada.id);
const cconn = await collab.hocuspocus.openDirectConnection(collab.docName(cp.id, 'main', 'live.tex'), {});
const ctext = cconn.document.getText('content');
whileScanning(() => cconn.document.transact(() => ctext.insert(ctext.toString().indexOf('colour two') + 6, 'INS')));
res = await replace(cp.id, { q: 'colou?r', regex: true, replace: 'color', paths: ['live.tex'] });
body = res.json();
check(res.statusCode === 200 && body.replaced === 2 && body.skipped === 1, `the match typed against is skipped (got ${res.body})`);
eq(ctext.toString(), 'color one\ncolourINS two\ncolor three\n', 'the live doc keeps the insert once, the other matches replaced');
eq(disk(cp.id, 'live.tex'), 'color one\ncolourINS two\ncolor three\n', 'and so does its file');
log = await logOf(cp.id);
check(log[0].author === 'Ada' && log[1].message === 'aldine: autosave', `the insert landed in an autosave of its own (got ${JSON.stringify(log.slice(0, 2))})`);
eq(changedLines((await gitops.commitDiff(cp.id, log[0].hash)).patch), ['+color one', '+color three', '-colour one', '-colour three'], "the person's commit holds the two replacements and nothing else");
await cconn.disconnect();

// in another open document while a closed file is rewritten: the refresh must not reset it
const tp = await store.createProject('Typing', { 'closed.tex': 'colour\n'.repeat(50), 'typed.tex': 'hello\n' }, ada.id);
const tconn = await collab.hocuspocus.openDirectConnection(collab.docName(tp.id, 'main', 'typed.tex'), {});
const ttext = tconn.document.getText('content');
whileScanning(() => tconn.document.transact(() => ttext.insert(ttext.length, 'TYPED')));
res = await replace(tp.id, { q: 'colou?r', regex: true, replace: 'color', paths: ['closed.tex'] });
check(res.statusCode === 200 && res.json().replaced === 50, `the closed file is replaced (got ${res.body})`);
eq(ttext.toString(), 'hello\nTYPED', 'typing that reached another open document during the scan is kept');
eq(disk(tp.id, 'typed.tex'), 'hello\nTYPED', 'and is on disk');
await tconn.disconnect();

// ---- line endings ----
// matches count in the LF text the editor holds; a file is written and committed in its own endings
const WIN = 'one colour\r\ntwo\r\nthe colour three\r\nfour\r\n';
const MIXED = 'colour a\r\nb\ncolour c\r\n';
const lf = (s) => s.replace(/\r\n/g, '\n');
const toColor = (s) => s.replaceAll('colour', 'color');
const wp = await store.createProject('Windows', { 'win.tex': WIN, 'open.tex': WIN, 'late.tex': WIN, 'mixed.tex': MIXED }, ada.id);
const openDoc = (rel) => collab.hocuspocus.openDirectConnection(collab.docName(wp.id, 'main', rel), {});
body = (await get(wp.id, { q: 'colour' })).json();
const win = body.files.find((f) => f.path === 'win.tex');
check(win.open === false, 'setup: win.tex is not open');
eq(win.matches.map((x) => [x.from, x.to, x.line, x.column]), [[4, 10, 1, 5], [19, 25, 3, 5]], 'a closed CRLF file is searched at the offsets the editor counts, not at its bytes');
check(win.matches.every((x) => lf(WIN).slice(x.from, x.to) === 'colour'), 'which select the match in the LF text');
eq(win.matches.map((x) => x.preview), [{ text: 'one colour', start: 4, end: 10 }, { text: 'the colour three', start: 4, end: 10 }], 'its previews hold no \\r');
eq(body.files.find((f) => f.path === 'mixed.tex').matches.map((x) => [x.from, x.line]), [[0, 1], [11, 3]], 'a file with mixed endings is searched in the same LF text');
eq((await get(wp.id, { q: '\\r', regex: '1' })).json().total, 0, 'no search finds a CR the editor never shows');

before = (await logOf(wp.id)).length;
res = await replace(wp.id, { q: 'colour', replace: 'color', match: rowOf(body, 'win.tex', 1) });
check(res.statusCode === 200 && res.json().replaced === 1, `Replace (one) in a closed CRLF file (got ${res.body})`);
eq(disk(wp.id, 'win.tex'), WIN.replace('the colour', 'the color'), 'the file keeps its CRLF endings');
log = await logOf(wp.id);
check(log.length === before + 1 && log[0].author === 'Ada', `one commit, by Ada (got ${JSON.stringify(log.slice(0, 2))})`);
eq(changedLines((await gitops.commitDiff(wp.id, log[0].hash)).patch), ['+the color three\r', '-the colour three\r'], 'whose diff is the one line replaced');

const wconn = await openDoc('open.tex');
const wtext = wconn.document.getText('content');
check(wtext.toString() === lf(WIN), 'setup: the open doc holds LF');
before = (await logOf(wp.id)).length;
res = await replace(wp.id, { q: 'colour', replace: 'color', paths: ['open.tex', 'win.tex', 'mixed.tex'] });
body = res.json();
check(res.statusCode === 200 && body.replaced === 5 && body.skipped === 0, `Replace all over an open CRLF doc, a closed CRLF file and a mixed one (got ${res.body})`);
eq(wtext.toString(), toColor(lf(WIN)), 'the live doc still holds LF');
eq(disk(wp.id, 'open.tex'), toColor(WIN), 'its file keeps CRLF');
eq(disk(wp.id, 'win.tex'), toColor(WIN), 'so does the closed one');
eq(disk(wp.id, 'mixed.tex'), toColor(lf(MIXED)), 'the mixed file is saved with LF, as the editor saves it at its first edit');
log = await logOf(wp.id);
check(log.length === before + 1 && log[0].message === 'Replace "colour" with "color" in 3 files', `one commit: no autosave flipping a file's endings before it (got ${JSON.stringify(log.slice(0, 2))})`);
eq(changedLines((await gitops.commitDiff(wp.id, log[0].hash)).patch), [
  '+color a', '+color c', '+one color\r', '+one color\r', '+the color three\r',
  '-colour a\r', '-colour c\r', '-one colour\r', '-one colour\r', '-the colour three\r',
], 'whose diff is the replaced lines alone');
const leftOver = await gitops.uncommittedPaths(wp.id, 'main');
check(!['open.tex', 'win.tex', 'mixed.tex'].some((f) => leftOver.includes(f)), `and nothing is left for the autosave to flip back (got ${JSON.stringify(leftOver)})`);
await wconn.disconnect();

// a CRLF file opened while the worker runs: the disk snapshot and the live doc compare as the same LF text
let lconnLate = null;
whileScanning((w) => holdAnswer(w, openDoc('late.tex').then((c) => { lconnLate = c; })));
res = await replace(wp.id, { q: 'colour', replace: 'color', paths: ['late.tex'] });
body = res.json();
check(lconnLate !== null, 'setup: the doc opened before the apply');
check(res.statusCode === 200 && body.replaced === 2 && body.skipped === 0, `no match is lost to the doc dropping the CRs (got ${res.body})`);
eq(lconnLate.document.getText('content').toString(), toColor(lf(WIN)), 'the replace went through the doc');
eq(disk(wp.id, 'late.tex'), toColor(WIN), 'and the file keeps CRLF');
log = await logOf(wp.id);
eq(changedLines((await gitops.commitDiff(wp.id, log[0].hash)).patch), ['+one color\r', '+the color three\r', '-one colour\r', '-the colour three\r'], 'its commit is the replaced lines alone');
res = await replace(wp.id, { q: 'four', replace: 'four\r\nfive', paths: ['late.tex'] });
check(res.statusCode === 200 && res.json().replaced === 1, `a replacement holding a CRLF (got ${res.body})`);
eq(lconnLate.document.getText('content').toString(), toColor(lf(WIN)).replace('four', 'four\nfive'), 'reaches the doc as LF');
eq(disk(wp.id, 'late.tex'), toColor(WIN).replace('four', 'four\r\nfive'), 'and the file as CRLF');
await lconnLate.disconnect();

// ---- files that are not plain text in the project ----
// an open Latin-1 file: its doc reads U+FFFD where the bytes are not UTF-8
const lp = await store.createProject('Latin', { 'main.tex': 'x\n' }, ada.id);
const latin = Buffer.from('caf\xe9 colour\n', 'latin1');
store.writeFile(lp.id, 'main', 'open.tex', latin);
store.writeFile(lp.id, 'main', 'closed.tex', latin);
store.writeFile(lp.id, 'main', 'fffd.tex', '\uFFFD colour\n');
const lconn = await collab.hocuspocus.openDirectConnection(collab.docName(lp.id, 'main', 'open.tex'), {});
const fconn = await collab.hocuspocus.openDirectConnection(collab.docName(lp.id, 'main', 'fffd.tex'), {});
check(lconn.document.getText('content').toString().includes('\uFFFD'), 'setup: the open doc holds U+FFFD');
eq((await get(lp.id, { q: 'colour' })).json().files.map((f) => f.path), ['fffd.tex'], 'neither the open nor the closed Latin-1 file is searched; a typed U+FFFD is text');
res = await replace(lp.id, { q: 'colour', replace: 'color', paths: ['open.tex', 'closed.tex', 'fffd.tex'] });
body = res.json();
check(res.statusCode === 200 && body.replaced === 1 && body.skipped === 2, `only the UTF-8 file is replaced (got ${res.body})`);
check(store.readFile(lp.id, 'main', 'open.tex').equals(latin) && store.readFile(lp.id, 'main', 'closed.tex').equals(latin), 'the Latin-1 bytes are left as they were, open or not');
eq(disk(lp.id, 'fffd.tex'), '\uFFFD color\n', 'the UTF-8 file changed');
await lconn.disconnect();
await fconn.disconnect();

// symlinks: never read, never written through
const sp = await store.createProject('Links', { 'chapter.tex': 'colour\n' }, ada.id);
const dir = store.branchDir(sp.id, 'main');
const secret = path.join(process.env.META_DIR, 'secret.txt');
fs.writeFileSync(secret, 'API_KEY=sk-live-123\n');
fs.symlinkSync(secret, path.join(dir, 'notes.tex'));
fs.symlinkSync('chapter.tex', path.join(dir, 'alias.tex'));
fs.symlinkSync('/dev/zero', path.join(dir, 'zero.tex'));
body = (await get(sp.id, { q: '[\\s\\S]{1,1000}', regex: '1' })).json();
eq(body.files.map((f) => f.path), ['chapter.tex'], 'a search reads no file through a link (outside the project, inside it, or a device)');
res = await replace(sp.id, { q: 'sk-live-123', replace: 'OVERWRITTEN', paths: ['notes.tex'] });
check(res.statusCode === 200 && res.json().replaced === 0 && res.json().skipped === 1, `a link is skipped by Replace all (got ${res.body})`);
eq(fs.readFileSync(secret, 'utf8'), 'API_KEY=sk-live-123\n', 'and what it points at is not written');
res = await replace(sp.id, { q: 'colour', replace: 'color', paths: ['alias.tex'] });
check(res.json().skipped === 1 && fs.readlinkSync(path.join(dir, 'alias.tex')) === 'chapter.tex' && disk(sp.id, 'chapter.tex') === 'colour\n', 'a link inside the project stays a link, its target unchanged');
res = await replace(sp.id, { q: 'colour', replace: 'color', match: { path: 'alias.tex', text: 'colour', preview: { text: 'colour', start: 0, end: 6 }, ordinal: 0, count: 1, alike: 1 } });
eq(res.statusCode, 409, 'Replace (one) through a link is stale');

// ---- the scan slots ----
// held only while a worker runs: four replaces waiting on a busy repo lock leave the server's slots free
const busy = await store.createProject('Busy', { 'a.tex': 'colour\n' }, ada.id);
let release;
const holding = new Promise((res2) => { release = res2; });
const held = gitops.withRepoLock(busy.id, () => holding);
const waiting = [1, 2, 3, 4].map((i) => search.replaceInProject(busy.id, 'main', { q: 'colour', replace: 'color', paths: ['a.tex'] }, 'Ada', `user${i}`));
await sleep(100);
const free = await search.searchProject(q.id, 'main', { q: 'x', caseSensitive: false, wholeWord: false, regex: true }, 'user5');
check(free.total > 0, 'a search elsewhere runs while they wait');
release();
await held;
const done = await Promise.all(waiting);
eq(done.map((x) => x.replaced), [1, 0, 0, 0], 'and they run in turn once the lock is free');

// ---- a commit that fails ----
// the person's replace goes to the anonymous autosave, never into the agent's attribution
const fp = await store.createProject('Ledger', { 'a.tex': 'b\n', 'agent.tex': 'intro\n' }, ada.id);
store.writeFile(fp.id, 'main', 'agent.tex', 'tighter intro\n');
gitops.registerAttributedPaths(fp.id, 'main', 'Agent: tighten intro', 'Claude', ['agent.tex']);
const refLock = path.join(store.repoDir(fp.id), '.git', 'refs', 'heads', 'main.lock');
fs.writeFileSync(refLock, '');
res = await replace(fp.id, { q: 'b', replace: 'x', paths: ['a.tex'] });
fs.rmSync(refLock);
check(res.statusCode === 200 && res.json().replaced === 1 && res.json().commit === null, `the replace applies, its commit refused (got ${res.body})`);
await gitops.autosave(fp.id, 'main');
log = await logOf(fp.id);
const statOf = async (c) => (await gitops.commitDiff(fp.id, c.hash)).stat.split('\n').filter((l) => l.includes('|')).map((l) => l.split('|')[0].trim());
check(log[1].author === 'Claude' && log[1].message === 'Agent: tighten intro' && (await statOf(log[1])).join() === 'agent.tex', `the agent's pending write is still Claude's alone (got ${JSON.stringify(log.slice(0, 2))})`);
check(log[0].message === 'aldine: autosave' && log[0].author !== 'Claude' && (await statOf(log[0])).join() === 'a.tex', `the replace landed in the autosave, not under Claude (got ${JSON.stringify(log[0])})`);

// ---- manual commits ----
const mp = await store.createProject('Manual', { 'm.tex': 'colour\n' }, ada.id);
const mmeta = await store.readMeta(mp.id);
mmeta.manualCommits = true;
await store.writeMeta(mmeta);
before = (await logOf(mp.id)).length;
res = await replace(mp.id, { q: 'colour', replace: 'color', paths: ['m.tex'] });
body = res.json();
check(res.statusCode === 200 && body.replaced === 1 && body.commit === null && body.pending === true, `a manual-commit project applies without committing (got ${res.body})`);
eq(disk(mp.id, 'm.tex'), 'color\n', 'the file changed');
check((await gitops.uncommittedPaths(mp.id, 'main')).includes('m.tex'), 'and waits in History');
eq((await logOf(mp.id)).length, before, 'no commit');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Search and replace: ALL PASSED');
process.exit(0);
