import { describe, expect, it, vi } from 'vitest';
import { createPdfPagesStore, pageInView, parsePageInput } from '../pdfPages';

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
