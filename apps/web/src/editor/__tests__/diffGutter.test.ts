import { describe, it, expect } from 'vitest';
import { Text } from '@codemirror/state';
import { diffLines, splitLines } from '../lineDiff';
import { hunkAtLine, revertChange } from '../diffGutter';

const lines = (s: string) => splitLines(s);
const apply = (doc: Text, c: { from: number; to: number; insert: string }) => doc.replace(c.from, c.to, Text.of(c.insert.split('\n')));

describe('diffLines', () => {
  it('finds nothing in equal texts', () => {
    expect(diffLines(lines('a\nb\n'), lines('a\nb\n'))).toEqual([]);
  });

  it('marks new lines as added, in the new text\'s numbers', () => {
    expect(diffLines(lines('a\nb\nc'), lines('a\nb\nnew\nc'))).toEqual([{ kind: 'add', from: 3, to: 3, old: [] }]);
    expect(diffLines(lines('a'), lines('x\ny\na'))).toEqual([{ kind: 'add', from: 1, to: 2, old: [] }]);
  });

  it('marks a changed line as modified, with the text it replaced', () => {
    expect(diffLines(lines('a\nb\nc'), lines('a\nB\nc'))).toEqual([{ kind: 'mod', from: 2, to: 2, old: ['b'] }]);
  });

  it('counts a run that grew as one modification', () => {
    expect(diffLines(lines('a\nb\nc'), lines('a\nB1\nB2\nc'))).toEqual([{ kind: 'mod', from: 2, to: 3, old: ['b'] }]);
  });

  it('marks removed lines at the line that now follows them', () => {
    expect(diffLines(lines('a\nb\nc\nd'), lines('a\nd'))).toEqual([{ kind: 'del', from: 2, to: 2, old: ['b', 'c'] }]);
    expect(diffLines(lines('a\nb'), lines('b'))).toEqual([{ kind: 'del', from: 1, to: 1, old: ['a'] }]);
  });

  it('puts a removal at the end one past the last line', () => {
    expect(diffLines(lines('a\nb\n'), lines('a\nb'))).toEqual([{ kind: 'del', from: 3, to: 3, old: [''] }]);
  });

  it('keeps separate edits apart', () => {
    const before = lines('one\ntwo\nthree\nfour\nfive\nsix');
    const after = lines('ONE\ntwo\nthree\nfour\nfive\nsix\nseven').filter((l) => l !== 'four');
    expect(diffLines(before, after)).toEqual([
      { kind: 'mod', from: 1, to: 1, old: ['one'] },
      { kind: 'del', from: 4, to: 4, old: ['four'] },
      { kind: 'add', from: 6, to: 6, old: [] },
    ]);
  });

  it('reads CRLF and LF baselines alike', () => {
    expect(diffLines(lines('a\r\nb\r\n'), lines('a\nb\n'))).toEqual([]);
  });

  it('makes the changed middle one modification past the edit budget', () => {
    const before = ['keep', ...Array.from({ length: 50 }, (_, i) => `old ${i}`), 'end'];
    const after = ['keep', ...Array.from({ length: 50 }, (_, i) => `new ${i}`), 'end'];
    expect(diffLines(before, after, 10)).toEqual([{ kind: 'mod', from: 2, to: 51, old: before.slice(1, 51) }]);
  });

  it('stays quick on a large file with a small edit', () => {
    const before = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[25_000] = 'changed';
    const t = performance.now();
    expect(diffLines(before, after)).toEqual([{ kind: 'mod', from: 25_001, to: 25_001, old: ['line 25000'] }]);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('hunkAtLine', () => {
  const hunks = diffLines(lines('a\nb\nc\nd\ne'), lines('a\nB\nc\ne\nnew'));
  it('finds the hunk a marked line belongs to', () => {
    expect(hunkAtLine(hunks, 2, 5)?.kind).toBe('mod');
    expect(hunkAtLine(hunks, 4, 5)?.kind).toBe('del');
    expect(hunkAtLine(hunks, 5, 5)?.kind).toBe('add');
    expect(hunkAtLine(hunks, 1, 5)).toBeNull();
  });
  it('finds a removal at the end on the last line', () => {
    const end = diffLines(lines('a\nb'), lines('a'));
    expect(hunkAtLine(end, 1, 1)?.kind).toBe('del');
  });
});

describe('revertChange', () => {
  const roundTrip = (before: string, after: string) => {
    let doc = Text.of(after.split('\n'));
    // Revert from the last hunk up, so the earlier ones keep their numbers.
    for (const h of diffLines(lines(before), lines(after)).reverse()) doc = apply(doc, revertChange(h, doc));
    return doc.toString();
  };
  it('puts a changed line back', () => expect(roundTrip('a\nb\nc', 'a\nB\nc')).toBe('a\nb\nc'));
  it('removes added lines', () => {
    expect(roundTrip('a\nc', 'a\nb\nc')).toBe('a\nc');
    expect(roundTrip('a', 'a\nb')).toBe('a');
    expect(roundTrip('b', 'a\nb')).toBe('b');
  });
  it('restores removed lines, at the start, middle and end', () => {
    expect(roundTrip('x\na\nb', 'a\nb')).toBe('x\na\nb');
    expect(roundTrip('a\nx\ny\nb', 'a\nb')).toBe('a\nx\ny\nb');
    expect(roundTrip('a\nb\n', 'a\nb')).toBe('a\nb\n');
  });
  it('undoes several hunks at once', () => {
    expect(roundTrip('one\ntwo\nthree\nfour', 'ONE\ntwo\nfour\nfive')).toBe('one\ntwo\nthree\nfour');
  });
});
