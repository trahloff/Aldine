import { describe, expect, it } from 'vitest';
import { findCount, findMatches, findPattern, fold, pageText, type TextRun } from '../pdfFind';

const runs = (...items: (string | [string, true])[]): TextRun[] =>
  items.map((it) => (typeof it === 'string' ? { str: it, hasEOL: false } : { str: it[0], hasEOL: true }));

/** Each match's text, read back from the items it names. */
function read(items: TextRun[][], query: string): string[] {
  return findMatches(items.map(pageText), query).map((m) =>
    m.ranges.map((r) => items[m.page - 1][r.item].str.slice(r.from, r.to)).join('|'));
}

describe('fold', () => {
  it('spells out ligatures and drops accents', () => {
    expect(fold('ﬁnd')).toBe('find');
    expect(fold('Prüfung café')).toBe('Prufung cafe');
    expect(fold('x²')).toBe('x2');
  });
});

describe('pageText', () => {
  it('keeps one space for a run of whitespace and a newline at each line end', () => {
    const p = pageText(runs('  Two', '   ', ['words ', true], 'next', ['line', true]));
    expect(p.text).toBe('Two words\nnextline\n');
  });
  it('maps every character back to its item and its span there', () => {
    const p = pageText(runs('a', ['ﬁ', true], 'é'));
    expect(p.text).toBe('afi\ne');
    expect(p.item).toEqual([0, 1, 1, 1, 2]);
    expect(p.from).toEqual([0, 0, 0, 1, 0]);
    expect(p.to).toEqual([1, 1, 1, 1, 1]);
    expect(p.lengths).toEqual([1, 1, 1]);
  });
});

describe('findPattern', () => {
  it('is null for an empty or blank query', () => {
    expect(findPattern('')).toBeNull();
    expect(findPattern('  \t ')).toBeNull();
  });
  it('takes the query literally', () => {
    expect(read([runs('a+b (c) [d] $e$ \\f g.h a.b')], 'a+b (c) [d] $e$ \\f')).toEqual(['a+b (c) [d] $e$ \\f']);
    expect(read([runs('a.b axb')], 'a.b')).toEqual(['a.b']);
  });
});

describe('findMatches', () => {
  it('ignores case and accents', () => {
    expect(read([runs('Café and CAFE and cafe')], 'café')).toEqual(['Café', 'CAFE', 'cafe']);
  });
  it('finds words across items and line ends, in page order', () => {
    const pages = [
      runs('The quick', ' ', ['brown', true], 'fox jumps.'),
      runs('A brown fox again.'),
    ];
    expect(read(pages, 'brown fox')).toEqual(['brown|fox', 'brown fox']);
    expect(findMatches(pages.map(pageText), 'brown fox').map((m) => m.page)).toEqual([1, 2]);
  });
  it('names each item a match spans, without empty spans', () => {
    const [m] = findMatches([pageText(runs('one tw', 'o thr', 'ee four'))], 'two three');
    expect(m.ranges).toEqual([{ item: 0, from: 4, to: 6 }, { item: 1, from: 0, to: 5 }, { item: 2, from: 0, to: 2 }]);
  });
  it('joins a word TeX hyphenated at a line end, and keeps a real hyphen there', () => {
    expect(read([runs(['An exam-', true], 'ple of a well-', ['', true], 'known case.')], 'example')).toEqual(['exam-|ple']);
    expect(read([runs(['An exam-', true], 'ple of a well-', ['', true], 'known case.')], 'well-known')).toEqual(['well-|known']);
    expect(read([runs('well-', ['', true], 'known')], 'wellknown')).toEqual(['well-|known']);
  });
  it('finds every occurrence, none overlapping', () => {
    expect(read([runs('aaaa')], 'aa')).toEqual(['aa', 'aa']);
  });
  it('finds nothing for a blank query', () => {
    expect(findMatches([pageText(runs('text'))], ' ')).toEqual([]);
  });
});

describe('findCount', () => {
  it('says where Find is', () => {
    expect(findCount('', 3, 0)).toBe('');
    expect(findCount('word', null, -1)).toBe('Searching…');
    expect(findCount('word', 0, -1)).toBe('No matches');
    expect(findCount('word', 12, 2)).toBe('3 of 12');
  });
});
