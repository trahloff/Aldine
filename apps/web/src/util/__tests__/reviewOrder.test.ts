import { describe, expect, it } from 'vitest';
import { reviewOrder } from '../reviewOrder';

const c = (id: string, file: string, from: number, minute: number) => ({ id, file, anchor: { from }, createdAt: `2026-11-05T10:${String(minute).padStart(2, '0')}:00.000Z` });

describe('reviewOrder', () => {
  it('follows the document: include order, then position, not creation time', () => {
    const list = [
      c('late-intro', 'intro.tex', 10, 9),
      c('main-end', 'main.tex', 500, 1),
      c('methods', 'sections/methods.tex', 3, 2),
      c('main-top', 'main.tex', 20, 8),
      c('intro-top', 'intro.tex', 2, 7),
    ];
    expect(reviewOrder(list, ['main.tex', 'intro.tex', 'sections/methods.tex']).map((x) => x.id))
      .toEqual(['main-top', 'main-end', 'intro-top', 'late-intro', 'methods']);
  });

  it('puts files outside the document after it, by path', () => {
    const list = [c('b', 'notes/b.tex', 0, 1), c('a', 'appendix.tex', 0, 2), c('m', 'main.tex', 0, 3)];
    expect(reviewOrder(list, ['main.tex']).map((x) => x.id)).toEqual(['m', 'a', 'b']);
  });

  it('keeps creation order for threads on the same spot, and leaves the input alone', () => {
    const list = [c('second', 'main.tex', 5, 2), c('first', 'main.tex', 5, 1)];
    expect(reviewOrder(list, []).map((x) => x.id)).toEqual(['first', 'second']);
    expect(list.map((x) => x.id)).toEqual(['second', 'first']);
  });
});
