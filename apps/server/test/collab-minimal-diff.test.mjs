/**
 * Disk content reaches an open document as its changed spans only (agent-7):
 * a whole-file write, a revert, a merge or a pull leaves everything else in
 * the doc as it was, so a co-author's cursor there stays on its character
 * and a reconnecting copy merges without duplicating. Agent writes also mark
 * their spans in the doc's side map (agent-6), in a loaded doc and in the
 * snapshot of a file no editor has open — never a change that was not the
 * agent's. Real hooks on a throwaway datastore; env is set before any src
 * import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-collab-diff-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');

const LINES = Array.from({ length: 30 }, (_, i) => `Sentence ${i} of the draft.\n`).join('');
const meta = await store.createProject('Diff', { 'main.tex': LINES, 'closed.tex': 'Closed one.\nClosed two.\n', 'pulled.tex': 'Before the pull.\nUnchanged.\n' }, null);
const id = meta.id;
const dir = store.branchDir(id, 'main');
const name = (f) => collab.docName(id, 'main', f);
const open = (f) => collab.hocuspocus.openDirectConnection(name(f), {});
const loaded = (f) => collab.hocuspocus.documents.get(name(f));
const unloaded = async (f) => { for (let i = 0; i < 100 && loaded(f); i++) await new Promise((r) => setTimeout(r, 20)); check(!loaded(f), `${f} unloads`); };
const marksOf = (doc) => {
  const text = doc.getText('content');
  return [...doc.getMap(collab.AGENT_EDITS_KEY).values()].map((m) => {
    const at = (j) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), doc)?.index;
    return m.k === 'ins' ? { k: 'ins', text: text.toString().slice(at(m.a), at(m.b)) } : { k: 'del', at: at(m.a) };
  });
};

// ---- a revert under a co-author's cursor ----
const conn = await open('main.tex');
const doc = loaded('main.tex');
const text = doc.getText('content');
const cursorAt = LINES.indexOf('Sentence 15');
const cursor = Y.createRelativePositionFromTypeIndex(text, cursorAt);
const deltas = [];
text.observe((e) => deltas.push(e.delta));
const reverted = LINES.replace('Sentence 2 of', 'Sentence two of').replace('Sentence 28 of the draft.\n', '');
fs.writeFileSync(path.join(dir, 'main.tex'), reverted);
collab.refreshBranchDocsFromDisk(id, 'main'); // a git rewrite: no paths
eq(text.toString(), reverted, 'the doc holds the reverted text');
const moved = Y.createAbsolutePositionFromRelativePosition(cursor, doc).index;
eq(text.toString().slice(moved, moved + 11), 'Sentence 15', "the co-author's cursor is still on the character it was on");
check(deltas.length === 1 && !deltas[0].some((op) => op.delete !== undefined && op.delete > 30), `only the changed spans were replaced: ${JSON.stringify(deltas)}`);
eq(marksOf(doc), [], 'a git rewrite marks nothing as Claude\'s');

// ---- an agent's whole-file write into the open doc ----
const before = text.toString();
const agentText = before.replace('Sentence 20 of the draft.', 'Sentence 20 of the draft, sharpened by Claude.');
fs.writeFileSync(path.join(dir, 'main.tex'), agentText);
collab.refreshBranchDocsFromDisk(id, 'main', ['main.tex'], { agent: new Map([['main.tex', before]]) });
eq(text.toString(), agentText, 'the write reached the open doc');
eq(marksOf(doc), [{ k: 'ins', text: ', sharpened by Claude' }], 'and only its changed span is marked as Claude\'s');
// typed by someone right after the span: not Claude's
text.insert(text.toString().indexOf(', sharpened by Claude') + ', sharpened by Claude'.length, ' (ok)');
eq(marksOf(doc), [{ k: 'ins', text: ', sharpened by Claude' }], 'typing at the edge of the span does not grow it');

// ---- an agent's quote edit through the open doc ----
const st = collab.applySuggestionToDoc(id, 'main', 'main.tex', { from: text.toString().indexOf('Sentence 5 of the draft.'), to: text.toString().indexOf('Sentence 5 of the draft.') + 'Sentence 5 of the draft.'.length, quote: 'Sentence 5 of the draft.' }, 'Sentence 5 of the final draft.', collab.AGENT_ORIGIN);
eq(st, 'applied', 'the agent edit applies');
check(marksOf(doc).some((m) => m.k === 'ins' && m.text === 'final '), `the edit is marked where it changed the text, not over the whole quote: ${JSON.stringify(marksOf(doc))}`);
collab.applySuggestionToDoc(id, 'main', 'main.tex', { from: text.toString().indexOf(' (ok)'), to: text.toString().indexOf(' (ok)') + 5, quote: ' (ok)' }, '', collab.AGENT_ORIGIN);
check(marksOf(doc).some((m) => m.k === 'del'), 'a removal is marked as a deletion point');
const nMarks = marksOf(doc).length;
collab.applySuggestionToDoc(id, 'main', 'main.tex', { from: 0, to: 8, quote: 'Sentence' }, 'SENTENCE');
eq(marksOf(doc).length, nMarks, 'a person accepting a suggestion marks nothing');
await conn.disconnect();
await unloaded('main.tex');

// ---- an agent write to a file nobody has open ----
const c2 = await open('closed.tex');
await c2.disconnect(); // leaves a snapshot behind
await unloaded('closed.tex');
fs.writeFileSync(path.join(dir, 'closed.tex'), 'Closed one.\nClosed two.\nPulled in while closed.\n'); // a pull nobody saw
const pulled = fs.readFileSync(path.join(dir, 'closed.tex'));
fs.writeFileSync(path.join(dir, 'closed.tex'), 'Closed one, edited by Claude.\nClosed two.\nPulled in while closed.\n');
collab.refreshBranchDocsFromDisk(id, 'main', ['closed.tex'], { agent: new Map([['closed.tex', pulled]]) });
const c3 = await open('closed.tex');
eq(loaded('closed.tex').getText('content').toString(), 'Closed one, edited by Claude.\nClosed two.\nPulled in while closed.\n', 'the doc opens with the file as it is');
eq(marksOf(loaded('closed.tex')), [{ k: 'ins', text: ', edited by Claude' }], "it opens with Claude's change marked, and not the pull before it");
await c3.disconnect();

// a file created by the agent and never opened
fs.writeFileSync(path.join(dir, 'new.tex'), 'Written by Claude.\n');
collab.refreshBranchDocsFromDisk(id, 'main', ['new.tex'], { agent: new Map([['new.tex', null]]) });
const c4 = await open('new.tex');
eq(marksOf(loaded('new.tex')), [{ k: 'ins', text: 'Written by Claude.\n' }], 'a file Claude created is Claude\'s throughout');
eq(fs.readFileSync(path.join(dir, 'new.tex'), 'utf8'), 'Written by Claude.\n', 'and loading it changed nothing on disk');
await c4.disconnect();

// ---- a stale snapshot meets a reconnecting copy ----
const c5 = await open('pulled.tex');
const offline = new Y.Doc();
Y.applyUpdate(offline, Y.encodeStateAsUpdate(loaded('pulled.tex')));
await c5.disconnect();
await unloaded('pulled.tex');
offline.getText('content').insert('Before the pull.\nUnchanged.'.length, ' Typed offline.'); // in a line the pull leaves alone
fs.writeFileSync(path.join(dir, 'pulled.tex'), 'After the pull.\nUnchanged.\n');
const c6 = await open('pulled.tex');
Y.applyUpdate(loaded('pulled.tex'), Y.encodeStateAsUpdate(offline));
eq(loaded('pulled.tex').getText('content').toString(), 'After the pull.\nUnchanged. Typed offline.\n', 'the pull and the offline typing merge, each once and in place');
await c6.disconnect();

console.log('collab-minimal-diff: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
