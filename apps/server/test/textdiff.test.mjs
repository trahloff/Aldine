/**
 * The spans a disk write puts into an open document (textdiff.ts): applied
 * to the old text they give the new one, they are ascending and disjoint,
 * and they cover only what changed, so text outside them keeps its CRDT
 * identity and everyone's cursor there stays put.
 */
import { check, eq } from './assert.mjs';

const { diffSpans, applySpans } = await import('../src/textdiff.ts');

eq(diffSpans('same\n', 'same\n'), [], 'identical texts need no span');
eq(diffSpans('alpha beta gamma\n', 'alpha BETA gamma\n'), [{ from: 6, to: 10, insert: 'BETA' }], 'a word changed inside a line is that word only');
eq(diffSpans('one\ntwo\nthree\nfour\n', 'one\nTWO\nthree\nfour\nfive\n'), [{ from: 4, to: 7, insert: 'TWO' }, { from: 19, to: 19, insert: 'five\n' }], 'two changes far apart are two spans, the unchanged lines between them untouched');
eq(diffSpans('a\nb\nc\n', 'a\nc\n'), [{ from: 2, to: 4, insert: '' }], 'a removed line is a deletion');
eq(diffSpans('', 'new file\n'), [{ from: 0, to: 0, insert: 'new file\n' }], 'from nothing');
eq(diffSpans('\nx', 'y\nx'), [{ from: 0, to: 0, insert: 'y' }], 'a change at offset 0 before a newline');

// A revert of an edit at the top and the bottom of a long file: two spans,
// and a cursor in the middle (offset 5000) is outside both.
const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of the paper.\n`).join('');
const edited = long.replace('Line 3 of', 'Line three of').replace('Line 390 of', 'Line 390, revised, of');
const spans = diffSpans(edited, long);
eq(spans.length, 2, 'two edits far apart revert as two spans');
check(spans.every((s) => s.to < 5000 || s.from > 5000 + 50), 'neither touches the middle of the file');

// Past the edit-distance cap the changed region is still exact, as one span.
const reversed = long.split('\n').reverse().join('\n');
const big = diffSpans(long, reversed);
eq(applySpans(long, big), reversed, 'a text rewritten everywhere still comes out right');

// Random edits: applying the spans always gives the new text.
let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pieces = ['a', 'b', '\n', 'foo ', 'bar\n', '\\section{x}\n', ' '];
const gen = (n) => Array.from({ length: n }, () => pieces[Math.floor(rnd() * pieces.length)]).join('');
for (let t = 0; t < 3000; t++) {
  const a = gen(Math.floor(rnd() * 40));
  let b = a;
  for (let o = Math.floor(rnd() * 4); o > 0; o--) {
    const at = Math.floor(rnd() * (b.length + 1));
    b = b.slice(0, at) + gen(Math.floor(rnd() * 4)) + b.slice(at + Math.floor(rnd() * 6));
  }
  const s = diffSpans(a, b);
  if (applySpans(a, s) !== b) throw new Error(`spans do not rebuild the text: ${JSON.stringify({ a, b, s })}`);
  for (let i = 0; i < s.length; i++) {
    if (s[i].from > s[i].to || (i > 0 && s[i - 1].to > s[i].from)) throw new Error(`spans overlap or run backwards: ${JSON.stringify(s)}`);
  }
}

console.log('textdiff: all assertions passed');
