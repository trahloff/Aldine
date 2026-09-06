import { describe, it, expect } from 'vitest';
import { insertedRanges, agentActive } from '../agentHighlight';
import { filesInPatch } from '../../util/patch';

describe('insertedRanges', () => {
  it('maps a plain insert at the start', () => {
    expect(insertedRanges([{ insert: 'abc' }])).toEqual([{ from: 0, to: 3 }]);
  });

  it('maps retain + insert to new-document coordinates', () => {
    expect(insertedRanges([{ retain: 5 }, { insert: 'xy' }])).toEqual([{ from: 5, to: 7 }]);
  });

  it('a delete does not advance the new-document position', () => {
    // old doc: 10 chars; delete 4 at offset 2, then insert after 1 more retained char
    expect(insertedRanges([{ retain: 2 }, { delete: 4 }, { retain: 1 }, { insert: 'Z' }]))
      .toEqual([{ from: 3, to: 4 }]);
  });

  it('handles multiple inserts, each shifted by earlier inserts', () => {
    expect(insertedRanges([{ insert: 'ab' }, { retain: 3 }, { insert: 'cde' }]))
      .toEqual([{ from: 0, to: 2 }, { from: 5, to: 8 }]);
  });

  it('returns nothing for pure deletions', () => {
    expect(insertedRanges([{ retain: 2 }, { delete: 5 }])).toEqual([]);
  });

  it('counts embedded (non-string) inserts as length 1', () => {
    expect(insertedRanges([{ insert: {} }])).toEqual([{ from: 0, to: 1 }]);
  });
});

describe('agentActive', () => {
  const aw = (states: Array<Record<string, unknown>>) => ({
    getStates: () => new Map(states.map((s, i) => [i, s])),
  });

  it('is true when any state carries user.isAgent', () => {
    expect(agentActive(aw([{ user: { name: 'Ada', color: '#123' } }, { user: { name: 'Claude', isAgent: true } }]))).toBe(true);
  });

  it('is false for humans only or empty awareness', () => {
    expect(agentActive(aw([{ user: { name: 'Ada' } }]))).toBe(false);
    expect(agentActive(aw([]))).toBe(false);
    expect(agentActive(aw([{}]))).toBe(false);
  });
});

describe('filesInPatch', () => {
  it('extracts distinct paths from diff --git headers', () => {
    const patch = [
      'diff --git a/main.tex b/main.tex',
      '--- a/main.tex',
      '+++ b/main.tex',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/chapters/ch1.tex b/chapters/ch1.tex',
      '+++ b/chapters/ch1.tex',
      'diff --git a/main.tex b/main.tex',
    ].join('\n');
    expect(filesInPatch(patch).sort()).toEqual(['chapters/ch1.tex', 'main.tex']);
  });

  it('returns an empty list for an empty patch', () => {
    expect(filesInPatch('')).toEqual([]);
  });
});
