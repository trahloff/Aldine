import { describe, expect, it, vi } from 'vitest';
import { createPdfPagesStore, pageInView, pagesAt, pagesOnScreen, parsePageInput, scrollTopForPage, scrollToSpot, spotAt } from '../pdfPages';

// Ten 1000px pages, 14px apart, starting 18px down (the pane's padding).
const pages = Array.from({ length: 10 }, (_, i) => ({ top: 18 + i * 1014, height: 1000 }));
const box = (i: number) => pages[i];

describe('pageInView', () => {
  it('names the first page at the top of the document', () => {
    expect(pageInView(10, box, 0, 800)).toBe(1);
  });
  it('names the page that covers most of the viewport', () => {
    // 300px of page 3 and 486px of page 4 are on screen
    expect(pageInView(10, box, 18 + 2 * 1014 + 700, 800)).toBe(4);
    expect(pageInView(10, box, 18 + 2 * 1014 + 100, 800)).toBe(3);
  });
  it('gives a tie to the earlier page', () => {
    // a viewport taller than two whole pages: 1 and 2 both show in full
    expect(pageInView(10, box, 0, 2100)).toBe(1);
  });
  it('gives a tie to the later page at the end of the scroll range', () => {
    const top = pages[9].top + 1000 + 18 - 2100;
    expect(pageInView(10, box, top, 2100)).toBe(9);
    expect(pageInView(10, box, top, 2100, true)).toBe(10);
  });
  it('reads only the pages near the viewport', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ top: i * 1014, height: 1000 }));
    const spy = vi.fn((i: number) => many[i]);
    expect(pageInView(1000, spy, 500 * 1014 + 10, 800)).toBe(501);
    expect(spy.mock.calls.length).toBeLessThan(20);
  });
  it('is 0 for an empty document and the last page past its end', () => {
    expect(pageInView(0, box, 0, 800)).toBe(0);
    expect(pageInView(10, box, 50_000, 800)).toBe(10);
  });
});

describe('pagesOnScreen', () => {
  const els = pages.map((p) => ({ offsetTop: p.top, offsetHeight: p.height }));
  const scrollHeight = 18 + 10 * 1014 + 4;
  it('names the page on screen and the page count', () => {
    expect(pagesOnScreen({ scrollTop: 18 + 2 * 1014 + 700, clientHeight: 800, scrollHeight }, 10, (i) => els[i])).toEqual({ current: 4, total: 10 });
  });
  it('names the last page at the end of the scroll range', () => {
    // two whole pages fit: the tie goes to the last one only at the end
    expect(pagesOnScreen({ scrollTop: scrollHeight - 2100, clientHeight: 2100, scrollHeight }, 10, (i) => els[i])).toEqual({ current: 10, total: 10 });
  });
  it('is the first page of a document that fits without scrolling', () => {
    expect(pagesOnScreen({ scrollTop: 0, clientHeight: 2100, scrollHeight: 2100 }, 2, (i) => els[i])).toEqual({ current: 1, total: 2 });
  });
  it('is null without pages', () => {
    expect(pagesOnScreen({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 }, 0, () => null)).toBeNull();
  });
});

describe('scrollTopForPage', () => {
  const el = (i: number) => ({ offsetTop: pages[i].top, offsetHeight: pages[i].height });
  it('keeps half the gap above a page in view', () => {
    expect(scrollTopForPage(el(3), el(2))).toBe(pages[3].top - 7);
  });
  it('goes to the very top for the first page', () => {
    expect(scrollTopForPage(el(0), undefined)).toBe(0);
  });
});

describe('parsePageInput', () => {
  it('clamps a number to the document', () => {
    expect(parsePageInput('4', 10)).toBe(4);
    expect(parsePageInput(' 12 ', 10)).toBe(10);
    expect(parsePageInput('0', 10)).toBe(1);
  });
  it('refuses what is not a page number', () => {
    expect(parsePageInput('', 10)).toBeNull();
    expect(parsePageInput('two', 10)).toBeNull();
    expect(parsePageInput('-3', 10)).toBeNull();
    expect(parsePageInput('2.5', 10)).toBeNull();
    expect(parsePageInput('3', 0)).toBeNull();
  });
});

describe('createPdfPagesStore', () => {
  it('notifies only on a change', () => {
    const store = createPdfPagesStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set({ current: 1, total: 3 });
    store.set({ current: 1, total: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
    store.set({ current: 2, total: 3 });
    store.set(null);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.get()).toBeNull();
    off();
    store.set({ current: 1, total: 1 });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('spotAt', () => {
  // the pages on screen, 600px wide from x = 100, the view scrolled 2000px down
  const rect = (i: number) => ({ left: 100, top: pages[i].top - 2000, width: 600, height: pages[i].height });
  it('names the page under the point and where on it', () => {
    // page 3 spans 46..1046 on screen
    expect(spotAt(10, rect, 400, 546)).toEqual({ page: 2, fx: 0.5, fy: 0.5 });
  });
  it('gives a point in the gap to the page below', () => {
    const spot = spotAt(10, rect, 400, 1050)!;
    expect(spot.page).toBe(3);
    expect(spot.fy).toBeLessThan(0);
  });
  it('holds a point past the last page on the last page', () => {
    expect(spotAt(10, rect, 400, 50_000)!.page).toBe(9);
  });
  it('reads only the pages near the point', () => {
    const spy = vi.fn(rect);
    spotAt(10, spy, 400, 546);
    expect(spy.mock.calls.length).toBeLessThan(6);
  });
  it('is null without pages', () => {
    expect(spotAt(0, rect, 0, 0)).toBeNull();
  });
});

describe('scrollToSpot', () => {
  it('scrolls a spot on a page twice the size back under the point', () => {
    // zoomed to 200%: page 3 now starts 3000px lower on screen and is 2000px tall
    const zoomed = (i: number) => ({ left: 0, top: 46 + 3000 + (i - 2) * 2014, width: 1200, height: 2000 });
    const by = scrollToSpot(10, zoomed, { page: 2, fx: 0.5, fy: 0.5 }, 400, 546);
    expect(by).toEqual({ left: 200, top: 46 + 3000 + 1000 - 546 });
  });
  it('holds the spot on the last page of a shorter document', () => {
    const three = (i: number) => ({ left: 0, top: i * 1014, width: 600, height: 1000 });
    expect(scrollToSpot(3, three, { page: 7, fx: 0, fy: 0.25 }, 0, 0).top).toBe(2 * 1014 + 250);
  });
});

describe('pagesAt', () => {
  const heights = Array.from({ length: 10 }, () => 1000);
  it('is the pages at the top without a spot', () => {
    expect(pagesAt(heights, 14, null, 400, 800)).toEqual([0]);
    expect(pagesAt(heights, 14, null, 400, 1200)).toEqual([0, 1]);
  });
  it('is the pages around the spot, the spot refY below the top of the view', () => {
    // the middle of page 5 at the middle of an 800px view: 600px to 1400px into page 5's run
    expect(pagesAt(heights, 14, { page: 4, fx: 0.5, fy: 0.5 }, 400, 800)).toEqual([4]);
    // the bottom of page 5 at the middle: page 6 shows below it
    expect(pagesAt(heights, 14, { page: 4, fx: 0.5, fy: 0.95 }, 400, 800)).toEqual([4, 5]);
  });
  it('counts a margin past the view as on screen', () => {
    expect(pagesAt(heights, 14, { page: 4, fx: 0.5, fy: 0.5 }, 400, 800, 120)).toEqual([3, 4, 5]);
  });
  it('keeps the view inside the pages', () => {
    expect(pagesAt(heights, 14, { page: 0, fx: 0.5, fy: 0 }, 400, 800)).toEqual([0]);
    expect(pagesAt(heights, 14, { page: 9, fx: 0.5, fy: 1 }, 400, 800)).toEqual([9]);
    // a spot past the end of a document that got shorter
    expect(pagesAt([1000, 1000], 14, { page: 7, fx: 0.5, fy: 0.5 }, 400, 800)).toEqual([1]);
  });
  it('is every page of a document shorter than the view', () => {
    expect(pagesAt([300, 300], 14, { page: 1, fx: 0, fy: 0.5 }, 400, 800)).toEqual([0, 1]);
  });
  it('is nothing for no pages', () => {
    expect(pagesAt([], 14, null, 400, 800)).toEqual([]);
  });
});
