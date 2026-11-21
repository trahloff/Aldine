import { describe, expect, it } from 'vitest';
import { closeTab, loadTabs, MAX_TABS, renameTabs, saveTabs, tabLabels, withTab } from './openTabs';
import { makeSafeStore } from './safeStorage';

const memory = () => {
  const m = new Map<string, string>();
  return makeSafeStore(() => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }) as unknown as Storage);
};

describe('open tabs', () => {
  it('opens a file right after the one open before, once', () => {
    expect(withTab(['a', 'b', 'c'], 'x', 'a')).toEqual(['a', 'x', 'b', 'c']);
    expect(withTab(['a', 'b'], 'x', null)).toEqual(['a', 'b', 'x']);
    expect(withTab(['a', 'b'], 'b', 'a')).toEqual(['a', 'b']);
  });

  it('drops the oldest other tab past the cap', () => {
    const full = Array.from({ length: MAX_TABS }, (_, i) => `f${i}`);
    const next = withTab(full, 'new', null);
    expect(next).toHaveLength(MAX_TABS);
    expect(next[0]).toBe('f1');
    expect(next.at(-1)).toBe('new');
  });

  it('closing the open tab shows its right neighbour, then its left', () => {
    expect(closeTab(['a', 'b', 'c'], 'b', 'b')).toEqual({ tabs: ['a', 'c'], active: 'c' });
    expect(closeTab(['a', 'b', 'c'], 'c', 'c')).toEqual({ tabs: ['a', 'b'], active: 'b' });
    expect(closeTab(['a'], 'a', 'a')).toEqual({ tabs: [], active: null });
    expect(closeTab(['a', 'b'], 'a', 'b')).toEqual({ tabs: ['b'], active: 'b' });
  });

  it('follows a renamed file or folder in place', () => {
    expect(renameTabs(['main.tex', 'ch/a.tex', 'ch/b.tex', 'chx.tex'], 'ch', 'chapters')).toEqual(['main.tex', 'chapters/a.tex', 'chapters/b.tex', 'chx.tex']);
    expect(renameTabs(['a.tex', 'b.tex'], 'a.tex', 'c.tex')).toEqual(['c.tex', 'b.tex']);
  });

  it('labels same-named files with enough of their folder', () => {
    expect(tabLabels(['main.tex', 'a/intro.tex', 'b/intro.tex', 'x/y/z.tex'])).toEqual(['main.tex', 'a/intro.tex', 'b/intro.tex', 'z.tex']);
  });

  it('keeps the strip per project and branch, and survives junk', () => {
    const store = memory();
    saveTabs('p', 'main', ['a', 'b'], store);
    expect(loadTabs('p', 'main', store)).toEqual(['a', 'b']);
    expect(loadTabs('p', 'other', store)).toEqual([]);
    store.set('aldine.openTabs.p.main', '{"nope":1}');
    expect(loadTabs('p', 'main', store)).toEqual([]);
    store.set('aldine.openTabs.p.main', 'not json');
    expect(loadTabs('p', 'main', store)).toEqual([]);
    saveTabs('p', 'main', [], store);
    expect(store.get('aldine.openTabs.p.main')).toBeNull();
  });
});
